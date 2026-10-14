/**
 * Uploads a generated sheet to Supernote Cloud, from where the device syncs it.
 *
 * The safety rule that matters: a remote file whose contents differ from what we would
 * upload has almost certainly been WRITTEN ON. Overwriting it destroys handwriting that
 * exists nowhere else. So a differing remote file is refused unless replacement is asked
 * for explicitly -- and even then only after the old file has been copied off the cloud,
 * and in an order that never deletes before the replacement is verified in place.
 */

import { createHash } from 'node:crypto';
import { SupernoteCloudError, type CloudEntry, type SupernoteCloud } from './cloud.js';

export type PushOutcome = 'uploaded' | 'unchanged' | 'replaced' | 'refused';

export type PushResult = {
  outcome: PushOutcome;
  fileName: string;
  remotePath: string;
  /** Set when the push was refused, explaining what is in the way. */
  reason?: string;
  /**
   * Set when a replacement succeeded but the previous file could not be cleared away
   * afterwards. Nothing is lost -- it is still on the cloud under this name -- but it is a
   * stray file in a sheet folder until someone deletes it.
   */
  leftover?: string;
};

export type PushOptions = {
  /** Overwrite a remote file that differs. Destroys anything written on it. */
  replace?: boolean;
  dryRun?: boolean;
  /**
   * Compare-and-swap for `replace`: refuse unless the remote file currently has exactly
   * this md5. The caller passes the checksum of the copy it last pulled, so a notebook
   * written on SINCE that pull -- ink the caller has never seen and could not have carried
   * forward -- is refused instead of overwritten.
   */
  expectRemoteMd5?: string;
  /**
   * Keeps a copy of the file about to be replaced. Called with the remote's bytes, already
   * checked against the cloud's own md5, BEFORE anything on the cloud changes. If it
   * throws, the replacement is abandoned with nothing touched.
   *
   * Required for `replace`: a replacement with nowhere to put the old copy is refused.
   * The cloud's recycle bin is not a backup anyone here can rely on.
   */
  keepCopy?: (entry: CloudEntry, bytes: Buffer) => void | Promise<void>;
};

const md5Hex = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex');
const sameMd5 = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function splitName(fileName: string): { stem: string; extension: string } {
  const dot = fileName.lastIndexOf('.');
  return dot > 0
    ? { stem: fileName.slice(0, dot), extension: fileName.slice(dot) }
    : { stem: fileName, extension: '' };
}

/**
 * The name the file being replaced is moved to while its replacement goes up.
 *
 * Keyed by the OLD file's checksum, and says what it is on its face, so an interrupted
 * replacement leaves something a person reading the folder recognises as the previous
 * version rather than a second copy of the sheet.
 */
export function asideName(fileName: string, md5: string): string {
  const { stem, extension } = splitName(fileName);
  return `${stem.slice(0, 80)}.replaced-${md5.slice(0, 8)}${extension}`;
}

export async function pushNote(
  cloud: SupernoteCloud,
  remotePath: string,
  fileName: string,
  bytes: Buffer,
  options: PushOptions = {},
): Promise<PushResult> {
  const base = { fileName, remotePath };

  // Shared so a dry run cannot drift into paraphrasing the real refusal. The wording is
  // the whole value of that outcome; two copies would eventually disagree.
  const refusal = (): string =>
    `${fileName} already exists on the device and differs from this sheet — it has ` +
    'probably been written on. Pass --replace only if you are sure you want that ' +
    'handwriting gone.';

  if (options.dryRun === true) {
    // Read-only resolution, never `ensureDirectory`: that creates folders, and a dry run
    // that changes the device is not a dry run. A missing folder means nothing can be
    // there to conflict with.
    const directoryId = await cloud.resolveDirectory(remotePath);
    if (directoryId === undefined) return { ...base, outcome: 'uploaded' };

    const existing = await cloud.findEntry(directoryId, fileName);
    if (existing === undefined) return { ...base, outcome: 'uploaded' };
    if (existing.md5.toLowerCase() === md5Hex(bytes).toLowerCase()) {
      return { ...base, outcome: 'unchanged' };
    }
    if (options.replace !== true) return { ...base, outcome: 'refused', reason: refusal() };
    const precondition = replacePrecondition(existing, options);
    if (precondition !== undefined) return { ...base, outcome: 'refused', reason: precondition };
    return { ...base, outcome: 'replaced' };
  }

  const directoryId = await cloud.ensureDirectory(remotePath);
  const existing = await cloud.findEntry(directoryId, fileName);

  if (existing !== undefined) {
    const ours = md5Hex(bytes);
    // Same bytes: already delivered, nothing to do.
    if (existing.md5.toLowerCase() === ours.toLowerCase()) {
      return { ...base, outcome: 'unchanged' };
    }
    if (options.replace !== true) {
      return { ...base, outcome: 'refused', reason: refusal() };
    }
    const precondition = replacePrecondition(existing, options);
    if (precondition !== undefined) return { ...base, outcome: 'refused', reason: precondition };

    return replaceInPlace(cloud, directoryId, existing, bytes, ours, options, base);
  }

  await cloud.uploadFile(directoryId, fileName, bytes);
  return { ...base, outcome: 'uploaded' };
}

/** Why a replacement must not start, or undefined when it may. Shared with the dry run. */
function replacePrecondition(existing: CloudEntry, options: PushOptions): string | undefined {
  if (options.keepCopy === undefined) {
    return `${existing.fileName} would be replaced with nowhere to keep the copy being ` +
      'overwritten. Refusing: a replacement must save the old file first.';
  }
  if (options.expectRemoteMd5 !== undefined && !sameMd5(existing.md5, options.expectRemoteMd5)) {
    return `${existing.fileName} has changed on the cloud since it was last pulled ` +
      `(expected md5 ${options.expectRemoteMd5}, found ${existing.md5}) -- it has probably ` +
      'been written on again. Pull it and rebuild from that copy before replacing.';
  }
  return undefined;
}

/**
 * Replaces `existing` with `bytes` so that NO step deletes anything before the
 * replacement is verified in place:
 *
 *   keep a local copy -> rename the old file aside -> upload under the real name
 *   -> verify -> delete the aside
 *
 * Every failure before the last step leaves the old file on the cloud: a failed rename
 * changed nothing, and a failed upload renames the aside back. Until 2026-09-03 this was
 * delete-then-upload, and a crash between the two left the notebook nowhere; the
 * 2026-09-14 stage-delete-rename order still deleted before its unproven rename. The
 * 2026-09-01 incident that prompted this: handwriting vanished from the cloud and the
 * guard that should have caught it failed open.
 */
async function replaceInPlace(
  cloud: SupernoteCloud,
  directoryId: string,
  existing: CloudEntry,
  bytes: Buffer,
  ours: string,
  options: PushOptions,
  base: { fileName: string; remotePath: string },
): Promise<PushResult> {
  const { fileName, remotePath } = base;

  // 1. A verified local copy of what is about to be overwritten. `downloadFile` checks the
  //    cloud's own md5, so a truncated download fails here rather than being kept.
  const previous = await cloud.downloadFile(existing);
  await options.keepCopy!(existing, previous);

  // 2. Move the old file out of the way. If this fails nothing has changed.
  const aside = asideName(fileName, existing.md5);
  if ((await cloud.findEntry(directoryId, aside)) !== undefined) {
    throw new SupernoteCloudError(
      `${aside} already exists in ${remotePath} -- an earlier replacement was interrupted. ` +
        'Nothing was changed; restore or remove it by hand first.',
    );
  }
  await cloud.renameEntry(existing, aside);
  const moved = await cloud.findEntry(directoryId, aside);
  if (moved === undefined || !sameMd5(moved.md5, existing.md5)) {
    throw new SupernoteCloudError(
      `Renaming ${fileName} aside reported success but ${aside} is not on the cloud. ` +
        'Nothing was uploaded or deleted; check the folder by hand.',
    );
  }

  // 3. Upload under the real name and confirm the cloud holds exactly these bytes.
  let uploadFailure: unknown;
  try {
    await cloud.uploadFile(directoryId, fileName, bytes);
    const placed = await cloud.findEntry(directoryId, fileName);
    if (placed === undefined || !sameMd5(placed.md5, ours)) {
      uploadFailure = new SupernoteCloudError(`The new ${fileName} is not on the cloud after upload.`);
    }
  } catch (cause) {
    uploadFailure = cause;
  }
  if (uploadFailure !== undefined) {
    let restored = false;
    try {
      if ((await cloud.findEntry(directoryId, fileName)) === undefined) {
        await cloud.renameEntry(moved, fileName);
        restored = true;
      }
    } catch {
      // Still on the cloud under the aside name; said so below.
    }
    throw new SupernoteCloudError(
      `Could not upload the new ${fileName}; ` +
        (restored
          ? 'the previous file was renamed back and is unchanged.'
          : `the previous file is safe on the cloud as ${aside} -- rename it back by hand.`),
      { cause: uploadFailure },
    );
  }

  // 4. Only now, with the replacement verified in place, clear the old one away. A
  //    failure here loses nothing -- the old file just stays under its aside name.
  try {
    await cloud.deleteEntry(moved);
  } catch {
    return { ...base, outcome: 'replaced', leftover: aside };
  }
  return { ...base, outcome: 'replaced' };
}
