import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCloudClient, SupernoteCloudError, VerificationRequiredError, ROOT_DIRECTORY } from './cloud.js';

type Handler = (body: Record<string, unknown>, url: string) => unknown;

/** Fakes the cloud, recording every call so the handshake can be asserted. */
function fakeCloud(handlers: Record<string, Handler>) {
  const calls: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      calls.push({ path: 'PUT', body: {}, headers: (init.headers ?? {}) as Record<string, string> });
      return new Response('', { status: 200 });
    }
    const path = url.replace('https://cloud.supernote.com/api', '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body, headers: (init?.headers ?? {}) as Record<string, string> });

    const handler = handlers[path];
    const payload = handler === undefined ? {} : handler(body, url);
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  return { fetchFn, calls, find: (p: string) => calls.filter((c) => c.path === p) };
}

const listing = (items: Array<Partial<{ id: string; fileName: string; isFolder: string; md5: string }>>) =>
  () => ({ userFileVOList: items.map((i, n) => ({ id: i.id ?? `id${n}`, directoryId: '0', fileName: i.fileName, isFolder: i.isFolder ?? 'N', md5: i.md5 ?? '', size: 1, updateTime: 1 })), total: items.length });

const loginHandlers = {
  '/official/user/query/random/code': () => ({ randomCode: 'RC123', timestamp: 1700000000 }),
  '/official/user/account/login/new': () => ({ token: 'TOKEN-abc' }),
};

const client = (handlers: Record<string, Handler>, over = {}) =>
  createCloudClient({ account: 'someone@example.com', password: 'hunter2', fetchFn: fakeCloud(handlers).fetchFn, ...over });

describe('login', () => {
  it('salts the password with the one-time code, never sending it plain', async () => {
    const cloud = fakeCloud(loginHandlers);
    const c = createCloudClient({ account: 'a@b.c', password: 'hunter2', fetchFn: cloud.fetchFn });
    await c.login();

    const sent = cloud.find('/official/user/account/login/new')[0]!.body;
    const expected = createHash('sha256')
      .update(createHash('md5').update('hunter2').digest('hex') + 'RC123')
      .digest('hex');

    expect(sent.password).toBe(expected);
    expect(JSON.stringify(sent)).not.toContain('hunter2');
  });

  it('asks for the challenge before attempting the login', async () => {
    const cloud = fakeCloud(loginHandlers);
    await createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn }).login();
    expect(cloud.calls[0]!.path).toBe('/official/user/query/random/code');
  });

  it('returns and stores the token', async () => {
    const cloud = fakeCloud(loginHandlers);
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    expect(await c.login()).toBe('TOKEN-abc');
  });

  it('sends the token on subsequent calls', async () => {
    const cloud = fakeCloud({ ...loginHandlers, '/file/list/query': listing([]) });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    await c.listDirectory(ROOT_DIRECTORY);
    expect(cloud.find('/file/list/query')[0]!.headers['x-access-token']).toBe('TOKEN-abc');
  });

  it('refuses to call an authenticated endpoint before logging in', async () => {
    await expect(client({}).listDirectory('0')).rejects.toThrow(/not logged in/i);
  });

  it('names two-factor for what it is instead of a generic failure', async () => {
    const cloud = fakeCloud({
      '/official/user/query/random/code': () => ({ randomCode: 'RC', timestamp: 1 }),
      '/official/user/account/login/new': () => ({ success: false, errorCode: 'E1760', errorMsg: 'E1760 verification' }),
    });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await expect(c.login()).rejects.toThrow(VerificationRequiredError);
  });

  it('reports a rejected login with the server\'s own message', async () => {
    const cloud = fakeCloud({
      '/official/user/query/random/code': () => ({ randomCode: 'RC', timestamp: 1 }),
      '/official/user/account/login/new': () => ({ success: false, errorMsg: 'wrong password' }),
    });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await expect(c.login()).rejects.toThrow(/wrong password/);
  });

  it('requires both credentials', async () => {
    const c = createCloudClient({ account: '', password: '', fetchFn: fakeCloud({}).fetchFn });
    await expect(c.login()).rejects.toThrow(/SUPERNOTE_EMAIL/);
  });
});

describe('ensureDirectory', () => {
  it('walks an existing path without creating anything', async () => {
    const cloud = fakeCloud({
      ...loginHandlers,
      '/file/list/query': (body) =>
        body.directoryId === 0
          ? { userFileVOList: [{ id: 'note', directoryId: '0', fileName: 'Note', isFolder: 'Y', size: 0, updateTime: 0 }], total: 1 }
          : { userFileVOList: [{ id: 'zh', directoryId: 'note', fileName: '中文', isFolder: 'Y', size: 0, updateTime: 0 }], total: 1 },
    });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();

    expect(await c.ensureDirectory('Note/中文')).toBe('zh');
    expect(cloud.find('/file/folder/add')).toHaveLength(0);
  });

  it('creates a folder that is missing', async () => {
    let created = false;
    const cloud = fakeCloud({
      ...loginHandlers,
      '/file/folder/add': () => { created = true; return {}; },
      '/file/list/query': () =>
        created
          ? { userFileVOList: [{ id: 'new', directoryId: '0', fileName: '写汉字', isFolder: 'Y', size: 0, updateTime: 0 }], total: 1 }
          : { userFileVOList: [], total: 0 },
    });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();

    expect(await c.ensureDirectory('写汉字')).toBe('new');
    expect(cloud.find('/file/folder/add')).toHaveLength(1);
  });
});

describe('uploadFile', () => {
  const bytes = Buffer.from('a practice sheet');
  const handlers = {
    ...loginHandlers,
    '/file/upload/apply': () => ({
      url: 'https://s3.example.com/bucket/object-123?x=1',
      s3Authorization: 'AWS4-HMAC-SHA256 ...',
      xamzDate: '20260820T000000Z',
    }),
    '/file/upload/finish': () => ({}),
  };

  it('applies, PUTs the bytes, then finishes — in that order', async () => {
    const cloud = fakeCloud(handlers);
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    await c.uploadFile('dir1', 'sheet.note', bytes);

    const order = cloud.calls.map((x) => x.path).filter((p) => p.includes('upload') || p === 'PUT');
    expect(order).toEqual(['/file/upload/apply', 'PUT', '/file/upload/finish']);
  });

  it('declares the md5 the server will verify', async () => {
    const cloud = fakeCloud(handlers);
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    const { md5 } = await c.uploadFile('dir1', 'sheet.note', bytes);

    expect(md5).toBe(createHash('md5').update(bytes).digest('hex'));
    expect(cloud.find('/file/upload/apply')[0]!.body.md5).toBe(md5);
    expect(cloud.find('/file/upload/finish')[0]!.body.md5).toBe(md5);
  });

  it('sends the storage headers the presigned PUT requires', async () => {
    const cloud = fakeCloud(handlers);
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    await c.uploadFile('dir1', 'sheet.note', bytes);

    const put = cloud.find('PUT')[0]!.headers;
    expect(put['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(put.Authorization).toContain('AWS4');
  });

  // The live API returns innerName: null, not an absent field. Comparing against
  // undefined passes the null straight through, and /file/upload/finish rejects it with
  // "Internal file name cannot be empty".
  it('derives the object name when innerName comes back NULL', async () => {
    const cloud = fakeCloud({
      ...handlers,
      '/file/upload/apply': () => ({
        url: 'https://s3.example.com/bucket/353651ae-null.note?x=1',
        s3Authorization: 'AWS4-HMAC-SHA256 ...',
        xamzDate: '20260820T000000Z',
        innerName: null,
      }),
    });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    await c.uploadFile('dir1', 'sheet.note', bytes);

    expect(cloud.find('/file/upload/finish')[0]!.body.innerName).toBe('353651ae-null.note');
  });

  it('derives the object name from the upload URL when none is returned', async () => {
    const cloud = fakeCloud(handlers);
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    await c.uploadFile('dir1', 'sheet.note', bytes);
    expect(cloud.find('/file/upload/finish')[0]!.body.innerName).toBe('object-123');
  });

  it('does not report success when storage rejects the bytes', async () => {
    const cloud = fakeCloud(handlers);
    const failing = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? new Response('', { status: 403 }) : cloud.fetchFn(url, init));
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: failing });
    await c.login();

    await expect(c.uploadFile('dir1', 'sheet.note', bytes)).rejects.toThrow(/403/);
  });
});

describe('findEntry', () => {
  it('finds a file and ignores folders of the same name', async () => {
    const cloud = fakeCloud({
      ...loginHandlers,
      '/file/list/query': listing([
        { fileName: 'sheet.note', isFolder: 'Y', id: 'folder' },
        { fileName: 'sheet.note', isFolder: 'N', id: 'file' },
      ]),
    });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    expect((await c.findEntry('dir', 'sheet.note'))!.id).toBe('file');
  });

  it('returns undefined when absent', async () => {
    const cloud = fakeCloud({ ...loginHandlers, '/file/list/query': listing([]) });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    expect(await c.findEntry('dir', 'nope.note')).toBeUndefined();
  });
});

describe('error handling', () => {
  it('reports an unreachable cloud as such', async () => {
    const c = createCloudClient({
      account: 'a@b.c', password: 'p',
      fetchFn: vi.fn(async () => { throw new TypeError('fetch failed'); }),
    });
    await expect(c.login()).rejects.toThrow(SupernoteCloudError);
    await expect(c.login()).rejects.toThrow(/could not reach/i);
  });

  // The message alone is not enough to act on. The md5-dedupe refusal on 2026-09-14 cost
  // a filed issue rather than a diagnosis precisely because the body went in the bin.
  it('keeps the response body on the error', async () => {
    const cloud = fakeCloud({
      ...loginHandlers,
      '/file/upload/apply': () => ({
        success: false,
        errorCode: 'E1001',
        errorMsg: 'There are identical md5 files already. No need to upload!',
      }),
    });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();

    const error = await c.uploadFile('d1', 'x.note', Buffer.from('bytes')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupernoteCloudError);
    expect((error as SupernoteCloudError).payload).toMatchObject({ errorCode: 'E1001' });
  });
});

describe('renameEntry', () => {
  const entry = {
    id: 'f1', directoryId: 'd1', fileName: 'old name.note',
    isFolder: false, md5: 'abc', size: 1, updateTime: 1,
  };

  // Uploading the same bytes under a new name is refused forever -- the cloud
  // deduplicates by md5 across the account and deleting a file does not release the hash.
  // Renaming is the only correction that exists.
  it('renames by id, without touching the bytes', async () => {
    const cloud = fakeCloud({ ...loginHandlers, '/file/rename': () => ({ success: true }) });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    await c.renameEntry(entry, 'new name.note');

    expect(cloud.find('/file/rename')[0]!.body).toEqual({ id: 'f1', newName: 'new name.note' });
    expect(cloud.find('/file/upload/apply')).toHaveLength(0);
  });

  it('refuses an empty name rather than asking the cloud to blank one', async () => {
    const cloud = fakeCloud({ ...loginHandlers, '/file/rename': () => ({ success: true }) });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();

    await expect(c.renameEntry(entry, '')).rejects.toThrow(/cannot be empty/i);
    expect(cloud.find('/file/rename')).toHaveLength(0);
  });

  it('surfaces a refusal rather than reporting a rename that did not happen', async () => {
    const cloud = fakeCloud({
      ...loginHandlers,
      '/file/rename': () => ({ success: false, errorMsg: 'file not found' }),
    });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    await expect(c.renameEntry(entry, 'other.note')).rejects.toThrow(/file not found/i);
  });
});

describe('revertDelete', () => {
  // The official web client's restore sends `{ idList: [...] }`; `{ id }` was a guess.
  it('restores from the recycle bin with the idList shape the web client sends', async () => {
    const cloud = fakeCloud({ ...loginHandlers, '/file/recycle/revert': () => ({ success: true }) });
    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn: cloud.fetchFn });
    await c.login();
    await c.revertDelete('f1');

    expect(cloud.find('/file/recycle/revert')[0]!.body).toEqual({ idList: ['f1'] });
  });
});

describe('CSRF handshake', () => {
  // Even unauthenticated calls are gated behind a token from GET /csrf, so a bare first
  // request comes back 403 with no errorCode.
  it('fetches a token and retries when a 403 has no errorCode', async () => {
    const seen: string[] = [];
    let refreshed = false;

    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'POST'} ${url.replace('https://cloud.supernote.com/api', '')}`);
      if (url.endsWith('/csrf')) {
        refreshed = true;
        return new Response('', { status: 200, headers: { 'x-xsrf-token': 'CSRF-1' } });
      }
      if (!refreshed) return new Response(JSON.stringify({}), { status: 403 });
      return new Response(JSON.stringify({ randomCode: 'RC', timestamp: 1 }), { status: 200 });
    });

    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn });
    await expect(c.login()).rejects.toThrow(/did not return a token/);

    expect(seen[0]).toBe('POST /official/user/query/random/code');
    expect(seen[1]).toBe('GET /csrf');
    expect(seen[2]).toBe('POST /official/user/query/random/code');
  });

  it('sends the token on every later request', async () => {
    let refreshed = false;
    const headers: Array<Record<string, string>> = [];

    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/csrf')) {
        refreshed = true;
        return new Response('', { status: 200, headers: { 'x-xsrf-token': 'CSRF-1' } });
      }
      headers.push((init?.headers ?? {}) as Record<string, string>);
      if (!refreshed) return new Response(JSON.stringify({}), { status: 403 });
      if (url.includes('random/code')) {
        return new Response(JSON.stringify({ randomCode: 'RC', timestamp: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: 'T' }), { status: 200 });
    });

    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn });
    await c.login();
    expect(headers.at(-1)!['X-XSRF-TOKEN']).toBe('CSRF-1');
  });

  it('does not retry forever when the 403 is genuine', async () => {
    let csrfCalls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/csrf')) {
        csrfCalls += 1;
        return new Response('', { status: 200, headers: { 'x-xsrf-token': 'C' } });
      }
      return new Response(JSON.stringify({}), { status: 403 });
    });

    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn });
    await expect(c.login()).rejects.toThrow(/403/);
    expect(csrfCalls).toBe(1);
  });
});

describe('downloadFile', () => {
  const entry = {
    id: 'f1', directoryId: 'd', fileName: 'a.note',
    isFolder: false, md5: createHash('md5').update('hello').digest('hex'),
    size: 5, updateTime: 1,
  };

  it('returns the bytes when the checksum matches', async () => {
    const cloud = fakeCloud({
      ...loginHandlers,
      '/file/download/url': () => ({ url: 'https://s3.example.com/obj' }),
    });
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith('https://s3.') ? new Response('hello', { status: 200 }) : cloud.fetchFn(url, init));

    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn });
    await c.login();
    expect((await c.downloadFile(entry)).toString()).toBe('hello');
  });

  // Silently storing truncated bytes is worse than not backing up at all.
  it('refuses bytes whose checksum does not match', async () => {
    const cloud = fakeCloud({
      ...loginHandlers,
      '/file/download/url': () => ({ url: 'https://s3.example.com/obj' }),
    });
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith('https://s3.') ? new Response('truncated', { status: 200 }) : cloud.fetchFn(url, init));

    const c = createCloudClient({ account: 'a@b.c', password: 'p', fetchFn });
    await c.login();
    await expect(c.downloadFile(entry)).rejects.toThrow(/corrupt/i);
  });
});
