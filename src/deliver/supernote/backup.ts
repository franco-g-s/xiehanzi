/**
 * Mirrors the whole Supernote drive to a local folder.
 *
 * The device is the only copy of everything written on it, and the cloud is a service that
 * can change its terms, its API, or its mind. This keeps a plain-file copy that outlives
 * both — usable by anything, dependent on nothing.
 *
 * It never deletes. A backup that removes files because they vanished upstream is not a
 * backup: an accidental deletion on the device would propagate here on the next run and
 * take the only remaining copy with it.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { SupernoteCloud, CloudEntry } from './cloud.js';
import { ROOT_DIRECTORY } from './cloud.js';

export type BackupResult = {
  /** Files newly written or updated. */
  saved: string[];
  /** Files already present with matching contents. */
  unchanged: string[];
  /** Present locally, gone from the cloud. Kept, never removed. */
  vanished: string[];
  failed: Array<{ path: string; reason: string }>;
  /** Total bytes downloaded this run. */
  bytes: number;
};

export type BackupOptions = {
  dryRun?: boolean;
  /** Called as each file is considered, for progress on a long first run. */
  onProgress?: (path: string, action: 'saved' | 'unchanged' | 'failed') => void;
};

const MANIFEST = '.supernote-backup.json';

type Manifest = { version: 1; files: Record<string, { md5: string; size: number }> };

function loadManifest(dir: string): Manifest {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) return { version: 1, files: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    return typeof parsed.files === 'object' && parsed.files !== null
      ? parsed
      : { version: 1, files: {} };
  } catch {
    // A damaged manifest costs a re-download, not data.
    return { version: 1, files: {} };
  }
}

/** Every file in the drive, with its full path, depth-first. */
export async function walkDrive(
  cloud: SupernoteCloud,
  directoryId: string = ROOT_DIRECTORY,
  prefix = '',
): Promise<Array<{ path: string; entry: CloudEntry }>> {
  const out: Array<{ path: string; entry: CloudEntry }> = [];
  for (const entry of await cloud.listDirectory(directoryId)) {
    const path = prefix === '' ? entry.fileName : `${prefix}/${entry.fileName}`;
    if (entry.isFolder) out.push(...(await walkDrive(cloud, entry.id, path)));
    else out.push({ path, entry });
  }
  return out;
}

export async function backupDrive(
  cloud: SupernoteCloud,
  destination: string,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const result: BackupResult = { saved: [], unchanged: [], vanished: [], failed: [], bytes: 0 };
  const manifest = loadManifest(destination);
  const files = await walkDrive(cloud);
  const seen = new Set<string>();

  for (const { path, entry } of files) {
    seen.add(path);
    const local = join(destination, path);
    const known = manifest.files[path];

    // Unchanged is decided by the cloud's own checksum, so an untouched drive costs one
    // listing and no downloads.
    if (
      known !== undefined &&
      entry.md5 !== '' &&
      known.md5.toLowerCase() === entry.md5.toLowerCase() &&
      existsSync(local)
    ) {
      result.unchanged.push(path);
      options.onProgress?.(path, 'unchanged');
      continue;
    }

    if (options.dryRun === true) {
      result.saved.push(path);
      continue;
    }

    try {
      const bytes = await cloud.downloadFile(entry);
      mkdirSync(dirname(local), { recursive: true });
      const temp = `${local}.tmp`;
      writeFileSync(temp, bytes);
      renameSync(temp, local);

      manifest.files[path] = { md5: entry.md5 || createHash('md5').update(bytes).digest('hex'), size: bytes.length };
      result.saved.push(path);
      result.bytes += bytes.length;
      options.onProgress?.(path, 'saved');
    } catch (e) {
      result.failed.push({ path, reason: (e as Error).message });
      options.onProgress?.(path, 'failed');
    }
  }

  for (const path of Object.keys(manifest.files)) {
    if (!seen.has(path)) result.vanished.push(path);
  }

  if (options.dryRun !== true) {
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return result;
}
