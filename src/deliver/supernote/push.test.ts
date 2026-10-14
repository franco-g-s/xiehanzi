import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { pushNote, asideName, type PushOptions } from './push.js';
import type { SupernoteCloud, CloudEntry } from './cloud.js';

const BYTES = Buffer.from('a generated sheet');
const OUR_MD5 = createHash('md5').update(BYTES).digest('hex');

/**
 * A directory that remembers what was uploaded into it.
 *
 * `findEntry` has to answer by NAME rather than returning one fixed row: the replace path
 * moves the old file aside and then looks both names up to confirm the cloud really did
 * what it said. A mock that answers the same entry for every name could not tell the
 * aside from the replacement, and would pass the very checks that exist to stop a delete
 * happening before the replacement is real.
 */
function fakeCloud(existing?: Partial<CloudEntry>) {
  const files = new Map<string, CloudEntry>();
  if (existing !== undefined) {
    const entry: CloudEntry = {
      id: 'f1', directoryId: 'd1', fileName: 'sheet.note', isFolder: false,
      md5: '', size: 1, updateTime: 1, ...existing,
    };
    files.set(entry.fileName, entry);
  }
  let nextId = 2;

  return {
    login: vi.fn(async () => 'token'),
    listDirectory: vi.fn(async () => [...files.values()]),
    ensureDirectory: vi.fn(async () => 'd1'),
    resolveDirectory: vi.fn(async (): Promise<string | undefined> => 'd1'),
    findEntry: vi.fn(async (_directoryId: string, fileName: string) => files.get(fileName)),
    uploadFile: vi.fn(async (directoryId: string, fileName: string, bytes: Buffer) => {
      const md5 = createHash('md5').update(bytes).digest('hex');
      files.set(fileName, {
        id: `f${nextId++}`, directoryId, fileName, isFolder: false,
        md5, size: bytes.byteLength, updateTime: 2,
      });
      return { md5 };
    }),
    deleteEntry: vi.fn(async (entry: CloudEntry) => { files.delete(entry.fileName); }),
    renameEntry: vi.fn(async (entry: CloudEntry, newName: string) => {
      files.delete(entry.fileName);
      files.set(newName, { ...entry, fileName: newName });
    }),
    revertDelete: vi.fn(async () => {}),
    downloadFile: vi.fn(async (_entry: CloudEntry) => Buffer.from('his handwriting')),
    requestVerification: vi.fn(async () => ({ email: 'a@b.c', timestamp: 1, validCodeKey: 'k' })),
    verify: vi.fn(async () => 'token'),
    useToken: vi.fn(),
    /** What the directory holds, for assertions about what survived. */
    names: () => [...files.keys()],
  } satisfies SupernoteCloud & Record<string, unknown>;
}

describe('pushNote', () => {
  it('uploads when nothing is there', async () => {
    const cloud = fakeCloud();
    const r = await pushNote(cloud, 'Note/中文/写汉字', 'sheet.note', BYTES);

    expect(r.outcome).toBe('uploaded');
    expect(cloud.uploadFile).toHaveBeenCalledOnce();
  });

  it('creates the remote folder path first', async () => {
    const cloud = fakeCloud();
    await pushNote(cloud, 'Note/中文/写汉字', 'sheet.note', BYTES);
    expect(cloud.ensureDirectory).toHaveBeenCalledWith('Note/中文/写汉字');
  });

  it('does nothing when the identical file is already there', async () => {
    const cloud = fakeCloud({ md5: OUR_MD5 });
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES);

    expect(r.outcome).toBe('unchanged');
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it('compares checksums case-insensitively', async () => {
    const cloud = fakeCloud({ md5: OUR_MD5.toUpperCase() });
    expect((await pushNote(cloud, 'p', 'sheet.note', BYTES)).outcome).toBe('unchanged');
  });

  // The whole point: a differing remote file has been written on, and that handwriting
  // exists nowhere else.
  it('REFUSES to overwrite a file that differs, and deletes nothing', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES);

    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/written on/i);
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  // The copy of the old file lands here before anything on the cloud changes.
  const kept: Array<{ name: string; bytes: string }> = [];
  const keepCopy: NonNullable<PushOptions['keepCopy']> = (entry, bytes) => {
    kept.push({ name: entry.fileName, bytes: bytes.toString() });
  };
  const REPLACE: PushOptions = { replace: true, keepCopy };

  it('replaces only when explicitly told to', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE);

    expect(r.outcome).toBe('replaced');
    expect(r.leftover).toBeUndefined();
    expect(cloud.uploadFile).toHaveBeenCalledOnce();
    // The aside is gone and the real name carries the new bytes.
    expect(cloud.names()).toEqual(['sheet.note']);
    expect(cloud.uploadFile.mock.calls[0]?.[1]).toBe('sheet.note');
  });

  // The ordering IS the safety property: nothing is deleted until the replacement is
  // verified under the real name. Delete-first (until 2026-09-03) and stage-delete-rename
  // (until 2026-09-28) both had a window where a failure left the handwriting deleted.
  it('copies, moves aside, uploads, and only THEN deletes', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const order: string[] = [];
    for (const name of ['downloadFile', 'renameEntry', 'uploadFile', 'deleteEntry'] as const) {
      const real = cloud[name];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cloud as any)[name] = vi.fn(async (...args: unknown[]) => {
        order.push(name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (real as any)(...args);
      });
    }

    await pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE);
    expect(order).toEqual(['downloadFile', 'renameEntry', 'uploadFile', 'deleteEntry']);
    // The delete removes the ASIDE, never the new file.
    expect((cloud.deleteEntry.mock.calls[0]?.[0] as CloudEntry).fileName).toBe(asideName('sheet.note', 'deadbeef'));
  });

  it('keeps a copy of the old file before touching the cloud', async () => {
    kept.length = 0;
    const cloud = fakeCloud({ md5: 'deadbeef' });
    await pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE);
    expect(kept).toEqual([{ name: 'sheet.note', bytes: 'his handwriting' }]);
  });

  it('REFUSES to replace when there is nowhere to keep the old copy', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES, { replace: true });

    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/nowhere to keep/i);
    expect(cloud.renameEntry).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
  });

  it('changes nothing when the copy cannot be kept', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const failing = () => { throw new Error('disk full'); };
    await expect(pushNote(cloud, 'p', 'sheet.note', BYTES, { replace: true, keepCopy: failing }))
      .rejects.toThrow(/disk full/);
    expect(cloud.renameEntry).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
  });

  // Compare-and-swap: the caller says which version it pulled. Ink added since then is
  // ink it never saw, so overwriting would destroy it.
  it('REFUSES when the remote is not the version the caller last pulled', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES, { ...REPLACE, expectRemoteMd5: 'cafef00d' });

    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/changed on the cloud since it was last pulled/i);
    expect(cloud.downloadFile).not.toHaveBeenCalled();
    expect(cloud.renameEntry).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
  });

  it('replaces when the remote is exactly the version last pulled', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES, { ...REPLACE, expectRemoteMd5: 'DEADBEEF' });
    expect(r.outcome).toBe('replaced');
  });

  it('changes nothing when the rename aside fails', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    cloud.renameEntry = vi.fn(async () => { throw new Error('rename refused'); });

    await expect(pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE)).rejects.toThrow(/rename refused/);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
    expect(cloud.names()).toEqual(['sheet.note']);
  });

  it('uploads nothing when the rename reports success but did not happen', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    cloud.renameEntry = vi.fn(async () => {});

    await expect(pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE)).rejects.toThrow(
      /Nothing was uploaded or deleted/,
    );
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
  });

  // The md5 dedupe is the realistic way an upload fails: these bytes were uploaded before.
  it('renames the old file back when the upload is refused, and deletes nothing', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    cloud.uploadFile = vi.fn(async () => {
      throw new Error('There are identical md5 files already. No need to upload!');
    });

    await expect(pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE)).rejects.toThrow(
      /renamed back and is unchanged/i,
    );
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
    expect(cloud.names()).toEqual(['sheet.note']);
    expect((await cloud.findEntry('d1', 'sheet.note'))?.md5).toBe('deadbeef');
  });

  it('renames back when the upload claims success but the file is not there', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    cloud.uploadFile = vi.fn(async () => ({ md5: OUR_MD5 })); // registers nothing

    await expect(pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE)).rejects.toThrow(/renamed back/i);
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
    expect(cloud.names()).toEqual(['sheet.note']);
  });

  it('names the aside when it cannot rename back', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const realRename = cloud.renameEntry;
    let calls = 0;
    cloud.renameEntry = vi.fn(async (e: CloudEntry, n: string) => {
      calls += 1;
      if (calls > 1) throw new Error('second rename refused');
      return realRename(e, n);
    });
    cloud.uploadFile = vi.fn(async () => { throw new Error('network'); });

    await expect(pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE)).rejects.toThrow(
      new RegExp(`safe on the cloud as ${asideName('sheet.note', 'deadbeef').replace(/\./g, '\\.')}`),
    );
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
  });

  it('refuses to start when an earlier replacement left an aside behind', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    await cloud.uploadFile('d1', asideName('sheet.note', 'deadbeef'), Buffer.from('older'));

    await expect(pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE)).rejects.toThrow(/interrupted/);
    expect(cloud.renameEntry).not.toHaveBeenCalled();
  });

  it('reports the aside as a leftover when only the final delete fails', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    cloud.deleteEntry = vi.fn(async () => { throw new Error('delete refused'); });

    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES, REPLACE);
    expect(r.outcome).toBe('replaced');
    expect(r.leftover).toBe(asideName('sheet.note', 'deadbeef'));
    expect((await cloud.findEntry('d1', 'sheet.note'))?.md5).toBe(OUR_MD5);
  });

  it('touches nothing on a dry run', async () => {
    const cloud = fakeCloud();
    await pushNote(cloud, 'p', 'sheet.note', BYTES, { dryRun: true });

    expect(cloud.ensureDirectory).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
  });
});

describe('pushNote — dry run', () => {
  // The point of a dry run is to say what the real run would do. Reporting "would upload"
  // when the real run would refuse is worse than no dry run at all: it is the case where
  // handwriting is at stake, and it is exactly the answer the operator came to check.

  it('reports the refusal a real run would give', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES, { dryRun: true });

    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/written on/i);
  });

  it('reports unchanged when the identical file is already there', async () => {
    const cloud = fakeCloud({ md5: OUR_MD5 });
    expect((await pushNote(cloud, 'p', 'sheet.note', BYTES, { dryRun: true })).outcome).toBe('unchanged');
  });

  it('reports a replacement when --replace is passed', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES, { dryRun: true, replace: true, keepCopy: () => {} });
    expect(r.outcome).toBe('replaced');
  });

  it('reports the compare-and-swap refusal a real run would give', async () => {
    const opts = { replace: true, keepCopy: () => {}, expectRemoteMd5: 'cafef00d' };
    const dry = await pushNote(fakeCloud({ md5: 'deadbeef' }), 'p', 'sheet.note', BYTES, { ...opts, dryRun: true });
    const real = await pushNote(fakeCloud({ md5: 'deadbeef' }), 'p', 'sheet.note', BYTES, opts);
    expect(dry.outcome).toBe('refused');
    expect(dry.reason).toBe(real.reason);
  });

  it('reports an upload when nothing is there', async () => {
    const cloud = fakeCloud();
    expect((await pushNote(cloud, 'p', 'sheet.note', BYTES, { dryRun: true })).outcome).toBe('uploaded');
  });

  it('reports an upload when the remote folder does not exist yet', async () => {
    const cloud = fakeCloud();
    cloud.resolveDirectory = vi.fn(async () => undefined);
    const r = await pushNote(cloud, 'p', 'sheet.note', BYTES, { dryRun: true });

    expect(r.outcome).toBe('uploaded');
    expect(cloud.findEntry).not.toHaveBeenCalled();
  });

  // A dry run that creates a folder is not a dry run. ensureDirectory writes.
  it('changes nothing on the device', async () => {
    const cloud = fakeCloud({ md5: 'deadbeef' });
    await pushNote(cloud, 'p', 'sheet.note', BYTES, { dryRun: true, replace: true });

    expect(cloud.ensureDirectory).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
  });

  it('gives the same refusal text as a real run, not a paraphrase', async () => {
    const dry = await pushNote(fakeCloud({ md5: 'deadbeef' }), 'p', 'sheet.note', BYTES, { dryRun: true });
    const real = await pushNote(fakeCloud({ md5: 'deadbeef' }), 'p', 'sheet.note', BYTES);
    expect(dry.reason).toBe(real.reason);
  });
});

describe('asideName', () => {
  it('keeps the extension and says what it is', () => {
    expect(asideName('sheet.note', 'abcdef1234')).toBe('sheet.replaced-abcdef12.note');
  });

  it('handles a name with no extension', () => {
    expect(asideName('sheet', 'abcdef1234')).toBe('sheet.replaced-abcdef12');
  });

  it('bounds the stem so a long name cannot be rejected by the cloud', () => {
    expect(asideName(`${'x'.repeat(200)}.note`, 'abcdef1234').length).toBeLessThan(110);
  });
});
