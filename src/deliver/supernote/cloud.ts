/**
 * Supernote Cloud client.
 *
 * Unofficial API — there is no published specification. The endpoints, the login
 * challenge and the upload handshake were read out of the Obsidian Supernote plugin's own
 * bundled client, which is the closest thing to documentation that exists. Expect it to
 * change without notice, and fail loudly rather than silently when it does.
 *
 * Credentials come from the environment and are never written to disk by this code.
 */

import { createHash } from 'node:crypto';

export const CLOUD_BASE = 'https://cloud.supernote.com/api';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CloudEntry = {
  id: string;
  directoryId: string;
  fileName: string;
  isFolder: boolean;
  md5: string;
  size: number;
  updateTime: number;
};

export class SupernoteCloudError extends Error {
  override name = 'SupernoteCloudError';
  /**
   * The parsed response body, when the cloud answered with one.
   *
   * Kept because throwing away the payload is how a diagnosable failure becomes a
   * mystery: the md5-dedupe refusal (2026-09-14) carries fields that say which object
   * the cloud already holds, and none of them survived to the caller.
   */
  payload?: Record<string, unknown>;
}

/**
 * The account has two-factor enabled; login needs a code emailed to the account holder.
 * Carries the server timestamp, which the verification exchange has to echo back.
 */
export class VerificationRequiredError extends SupernoteCloudError {
  override name = 'VerificationRequiredError';
  constructor(message: string, readonly timestamp: number) {
    super(message);
  }
}

/** Everything needed to complete a verification, once the code arrives by email. */
export type VerificationChallenge = {
  email: string;
  timestamp: number;
  validCodeKey: string;
};

export type CloudConfig = {
  account: string;
  password: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  pageSize?: number;
};

const md5Hex = (value: string | Uint8Array): string =>
  createHash('md5').update(value).digest('hex');

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The root of the user's cloud drive. */
export const ROOT_DIRECTORY = '0';

export type SupernoteCloud = {
  login(): Promise<string>;
  /** Asks the cloud to email a six-character code. */
  requestVerification(timestamp: number): Promise<VerificationChallenge>;
  /** Completes a two-factor login. Returns the session token. */
  verify(challenge: VerificationChallenge, code: string): Promise<string>;
  /** Reuse a token from a previous login instead of authenticating again. */
  useToken(token: string): void;
  listDirectory(directoryId: string): Promise<CloudEntry[]>;
  /** Resolves a path like `Note/中文/写汉字`, creating any missing folders. */
  ensureDirectory(path: string): Promise<string>;
  /**
   * The same resolution without the creating — `undefined` when a segment is missing.
   *
   * Exists so a dry run can look before it decides. `ensureDirectory` writes, and a dry
   * run that creates folders is not a dry run.
   */
  resolveDirectory(path: string): Promise<string | undefined>;
  findEntry(directoryId: string, fileName: string): Promise<CloudEntry | undefined>;
  uploadFile(directoryId: string, fileName: string, bytes: Buffer): Promise<{ md5: string }>;
  /** Fetches a file's bytes, verifying the checksum the cloud reported for it. */
  downloadFile(entry: CloudEntry): Promise<Buffer>;
  deleteEntry(entry: CloudEntry): Promise<void>;
  /**
   * Renames a file in place. The cloud deduplicates uploads by md5 across the whole
   * account and a delete does NOT release the hash, so re-uploading the same bytes under
   * a different name is refused forever — renaming is the only way to correct a name.
   */
  renameEntry(entry: CloudEntry, newName: string): Promise<void>;
  /**
   * Restores a deleted file from the cloud's recycle bin.
   *
   * Not used by `pushNote` any more -- its replacement order never deletes before success,
   * so there is nothing to revert -- but kept as the recovery tool for a hand-run delete.
   */
  revertDelete(id: string): Promise<void>;
};

export function createCloudClient(config: CloudConfig): SupernoteCloud {
  const base = config.baseUrl ?? CLOUD_BASE;
  const fetchFn = config.fetchFn ?? fetch;
  const pageSize = config.pageSize ?? 100;

  let token: string | null = null;
  let csrfToken: string | null = null;

  /** The API gates even unauthenticated calls behind a CSRF token handed out by GET /csrf. */
  async function refreshCsrf(): Promise<void> {
    const response = await fetchFn(`${base}/csrf`, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
    });
    const issued = response.headers.get('x-xsrf-token');
    if (issued === null || issued === '') {
      throw new SupernoteCloudError('Supernote Cloud did not issue a CSRF token.');
    }
    csrfToken = issued;
  }

  /**
   * A 403 carrying no errorCode means the CSRF token is missing or stale rather than the
   * request being wrong — fetch a fresh one and try once more.
   */
  const isCsrfProblem = (payload: Record<string, unknown>): boolean =>
    payload.errorCode === undefined ||
    payload.code === 'CSRF_TOKEN_EXPIRED' ||
    payload.code === 'INVALID_CSRF_TOKEN';

  async function post<T>(
    path: string,
    body: Record<string, unknown>,
    authenticated = true,
    allowCsrfRetry = true,
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authenticated) {
      if (token === null) throw new SupernoteCloudError('Not logged in to Supernote Cloud.');
      headers['x-access-token'] = token;
    }
    if (csrfToken !== null) headers['X-XSRF-TOKEN'] = csrfToken;

    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (cause) {
      throw new SupernoteCloudError(`Could not reach Supernote Cloud (${path}).`, { cause });
    }

    const setCsrf = response.headers.get('x-xsrf-token');
    if (setCsrf !== null && setCsrf !== '') csrfToken = setCsrf;

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (response.status === 403 && allowCsrfRetry && isCsrfProblem(payload)) {
      await refreshCsrf();
      return post<T>(path, body, authenticated, false);
    }

    if (payload.success === false) {
      const message = typeof payload.errorMsg === 'string' ? payload.errorMsg : 'request rejected';
      const error = new SupernoteCloudError(`Supernote Cloud: ${message} (${path})`);
      error.payload = payload;
      throw error;
    }
    if (!response.ok) {
      const error = new SupernoteCloudError(
        `Supernote Cloud returned HTTP ${response.status} for ${path}.`,
      );
      error.payload = payload;
      throw error;
    }
    return payload as T;
  }

  const client: SupernoteCloud = {
    async login() {
      const account = config.account.trim();
      if (account === '' || config.password === '') {
        throw new SupernoteCloudError('SUPERNOTE_EMAIL and SUPERNOTE_PASSWORD must both be set.');
      }

      const challenge = await post<{ randomCode: string; timestamp: number }>(
        '/official/user/query/random/code',
        { countryCode: '1', account },
        false,
      );

      // The server never sees the password: it is md5'd, salted with the one-time code,
      // then sha256'd.
      const hashed = sha256Hex(`${md5Hex(config.password)}${challenge.randomCode}`);

      let result: { token?: string; success?: boolean; errorCode?: string };
      try {
        result = await post('/official/user/account/login/new', {
          countryCode: 1,
          account,
          password: hashed,
          browser: 'Chrome107',
          equipment: '1',
          loginMethod: '1',
          timestamp: challenge.timestamp,
          language: 'en',
        }, false);
      } catch (e) {
        if (e instanceof SupernoteCloudError && /E1760|verif/i.test(e.message)) {
          throw new VerificationRequiredError(
            'Supernote Cloud wants a verification code emailed to this account.',
            challenge.timestamp,
          );
        }
        throw e;
      }

      if (typeof result.token !== 'string') {
        throw new SupernoteCloudError('Supernote Cloud did not return a token.');
      }
      token = result.token;
      return token;
    },

    async requestVerification(timestamp) {
      const account = config.account.trim();

      const pre = await post<{ token: string }>('/user/validcode/pre-auth', { account }, false);
      // The signing part is selected by the token's own last character used as an index.
      const parts = pre.token.split('-');
      const index = Number(pre.token.at(-1));
      const part = parts[index];
      if (!Number.isInteger(index) || part === undefined) {
        throw new SupernoteCloudError('Supernote Cloud returned an unusable pre-auth token.');
      }

      const sent = await post<{ validCodeKey: string }>(
        '/user/mail/validcode/send',
        { email: account, timestamp, token: pre.token, sign: sha256Hex(`${account}${part}`) },
        false,
      );
      if (typeof sent.validCodeKey !== 'string') {
        throw new SupernoteCloudError('Supernote Cloud did not return a verification key.');
      }
      return { email: account, timestamp, validCodeKey: sent.validCodeKey };
    },

    async verify(challenge, code) {
      const trimmed = code.trim();
      if (trimmed.length !== 6) {
        throw new SupernoteCloudError('The verification code is six characters.');
      }
      const result = await post<{ token?: string }>(
        '/official/user/sms/login',
        {
          email: challenge.email,
          validCode: trimmed,
          validCodeKey: challenge.validCodeKey,
          timestamp: challenge.timestamp,
          browser: 'Chrome107',
          equipment: '4',
        },
        false,
      );
      if (typeof result.token !== 'string') {
        throw new SupernoteCloudError('Supernote Cloud rejected the verification code.');
      }
      token = result.token;
      return token;
    },

    useToken(existing) {
      token = existing;
    },

    async listDirectory(directoryId) {
      const entries: CloudEntry[] = [];
      let pageNo = 1;
      let total = Number.POSITIVE_INFINITY;

      while (entries.length < total) {
        const page = await post<{ userFileVOList?: unknown[]; total?: number }>(
          '/file/list/query',
          {
            directoryId: directoryId === ROOT_DIRECTORY ? 0 : directoryId,
            pageNo,
            pageSize,
            order: 'time',
            sequence: 'desc',
          },
        );
        const list = page.userFileVOList;
        if (!Array.isArray(list)) {
          throw new SupernoteCloudError('Folder listing did not include a file list.');
        }
        total = typeof page.total === 'number' ? page.total : list.length;

        for (const raw of list as Array<Record<string, unknown>>) {
          entries.push({
            id: String(raw.id),
            directoryId: String(raw.directoryId),
            fileName: String(raw.fileName),
            isFolder: raw.isFolder === 'Y',
            md5: typeof raw.md5 === 'string' ? raw.md5 : '',
            size: Number(raw.size ?? 0),
            updateTime: Number(raw.updateTime ?? 0),
          });
        }

        // Guard against a pagination bug turning into an infinite loop.
        if (list.length === 0) break;
        pageNo += 1;
      }
      return entries;
    },

    async resolveDirectory(path) {
      let directoryId = ROOT_DIRECTORY;
      for (const segment of path.split('/').filter((s) => s !== '')) {
        const existing = (await client.listDirectory(directoryId)).find(
          (e) => e.isFolder && e.fileName === segment,
        );
        if (existing === undefined) return undefined;
        directoryId = existing.id;
      }
      return directoryId;
    },

    async ensureDirectory(path) {
      let directoryId = ROOT_DIRECTORY;
      for (const segment of path.split('/').filter((s) => s !== '')) {
        const existing = (await client.listDirectory(directoryId)).find(
          (e) => e.isFolder && e.fileName === segment,
        );
        if (existing !== undefined) {
          directoryId = existing.id;
          continue;
        }
        await post('/file/folder/add', {
          directoryId: directoryId === ROOT_DIRECTORY ? 0 : directoryId,
          fileName: segment,
        });
        const created = (await client.listDirectory(directoryId)).find(
          (e) => e.isFolder && e.fileName === segment,
        );
        if (created === undefined) {
          throw new SupernoteCloudError(`Created folder "${segment}" but it did not appear.`);
        }
        directoryId = created.id;
      }
      return directoryId;
    },

    async findEntry(directoryId, fileName) {
      return (await client.listDirectory(directoryId)).find(
        (e) => !e.isFolder && e.fileName === fileName,
      );
    },

    async uploadFile(directoryId, fileName, bytes) {
      const md5 = md5Hex(bytes);

      const apply = await post<{
        url: string;
        s3Authorization: string;
        xamzDate: string;
        innerName?: string | null;
      }>(
        '/file/upload/apply',
        { directoryId, fileName, md5, size: bytes.byteLength },
      );

      const put = await fetchFn(apply.url, {
        method: 'PUT',
        headers: {
          Authorization: apply.s3Authorization,
          'x-amz-date': apply.xamzDate,
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(300_000),
      });
      if (!put.ok) {
        throw new SupernoteCloudError(`Storage rejected the upload with HTTP ${put.status}.`);
      }

      const objectPath = new URL(apply.url).pathname;
      // The field is present but NULL in practice, so it must be type-checked rather than
      // compared against undefined — passing null on gets "Internal file name cannot be
      // empty" from the finish call.
      const innerName =
        typeof apply.innerName === 'string' && apply.innerName !== ''
          ? apply.innerName
          : objectPath.slice(objectPath.lastIndexOf('/') + 1);
      if (innerName === '') {
        throw new SupernoteCloudError('Supernote Cloud did not name the uploaded object.');
      }

      await post('/file/upload/finish', {
        directoryId,
        fileName,
        fileSize: bytes.byteLength,
        innerName,
        md5,
      });

      return { md5 };
    },

    async downloadFile(entry) {
      const descriptor = await post<{ url: string }>('/file/download/url', {
        id: entry.id,
        type: 0,
      });
      if (typeof descriptor.url !== 'string' || descriptor.url === '') {
        throw new SupernoteCloudError(`Supernote Cloud gave no download URL for ${entry.fileName}.`);
      }

      let response: Response;
      try {
        response = await fetchFn(descriptor.url, { signal: AbortSignal.timeout(300_000) });
      } catch (cause) {
        throw new SupernoteCloudError(`Could not download ${entry.fileName}.`, { cause });
      }
      if (!response.ok) {
        throw new SupernoteCloudError(
          `Storage returned HTTP ${response.status} downloading ${entry.fileName}.`,
        );
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      // A backup that silently stores truncated bytes is worse than no backup, so the
      // checksum the cloud published is checked rather than trusted.
      if (entry.md5 !== '') {
        const actual = md5Hex(bytes);
        if (actual.toLowerCase() !== entry.md5.toLowerCase()) {
          throw new SupernoteCloudError(
            `${entry.fileName} downloaded corrupt: expected md5 ${entry.md5}, got ${actual}.`,
          );
        }
      }
      return bytes;
    },

    async deleteEntry(entry) {
      await post('/file/delete', { directoryId: entry.directoryId, idList: [entry.id] });
    },

    async renameEntry(entry, newName) {
      if (newName === '') throw new SupernoteCloudError('A new name cannot be empty.');
      await post('/file/rename', { id: entry.id, newName });
    },

    async revertDelete(id) {
      // `idList`, not `id`: the shape the official web client sends (cloud.supernote.com,
      // js/app.*.js, `restore` posts `{ idList: [fileId, ...] }`). The `{ id }` this sent
      // until 2026-09-28 came from a third-party client and was never called live.
      await post('/file/recycle/revert', { idList: [id] });
    },
  };

  return client;
}
