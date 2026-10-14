import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { backupDrive, walkDrive } from './backup.js';
import type { SupernoteCloud, CloudEntry } from './cloud.js';

let dest: string;
beforeEach(() => {
  dest = mkdtempSync(join(tmpdir(), 'xiehanzi-backup-'));
});

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

type Node = { name: string; children?: Node[]; body?: string };

/** A fake drive: folders with children, files with contents. */
function fakeCloud(tree: Node[]) {
  const byId = new Map<string, Node[]>();
  const entries = new Map<string, { entry: CloudEntry; body: string }>();
  let next = 1;

  const register = (nodes: Node[], parentId: string): CloudEntry[] =>
    nodes.map((n) => {
      const id = `id${next++}`;
      const isFolder = n.children !== undefined;
      const body = n.body ?? '';
      const entry: CloudEntry = {
        id, directoryId: parentId, fileName: n.name, isFolder,
        md5: isFolder ? '' : md5(body), size: body.length, updateTime: 1,
      };
      if (isFolder) byId.set(id, n.children!);
      else entries.set(id, { entry, body });
      return entry;
    });

  const listed = new Map<string, CloudEntry[]>();
  const listOf = (id: string): CloudEntry[] => {
    if (!listed.has(id)) listed.set(id, register(id === '0' ? tree : (byId.get(id) ?? []), id));
    return listed.get(id)!;
  };

  const downloadFile = vi.fn(async (entry: CloudEntry) =>
    Buffer.from(entries.get(entry.id)?.body ?? ''),
  );

  return {
    downloadFile,
    cloud: {
      login: vi.fn(), useToken: vi.fn(), ensureDirectory: vi.fn(), findEntry: vi.fn(),
      uploadFile: vi.fn(), deleteEntry: vi.fn(), renameEntry: vi.fn(), revertDelete: vi.fn(),
      requestVerification: vi.fn(), verify: vi.fn(),
      listDirectory: vi.fn(async (id: string) => listOf(id)),
      downloadFile,
    } as unknown as SupernoteCloud,
  };
}

describe('walkDrive', () => {
  it('finds files at every depth, with full paths', async () => {
    const { cloud } = fakeCloud([
      { name: 'Note', children: [
        { name: '中文', children: [{ name: '写汉字', children: [{ name: 'a.note', body: 'A' }] }] },
        { name: 'top.note', body: 'T' },
      ] },
    ]);
    const found = await walkDrive(cloud);
    expect(found.map((f) => f.path).sort()).toEqual(
      ['Note/中文/写汉字/a.note', 'Note/top.note'].sort(),
    );
  });

  it('returns nothing for an empty drive', async () => {
    expect(await walkDrive(fakeCloud([]).cloud)).toEqual([]);
  });
});

describe('backupDrive', () => {
  const drive = () => [
    { name: 'Note', children: [{ name: '写汉字', children: [{ name: 'a.note', body: 'AAA' }] }] },
    { name: 'Document', children: [{ name: 'b.pdf', body: 'BB' }] },
  ];

  it('mirrors the folder structure to disk', async () => {
    const { cloud } = fakeCloud(drive());
    const r = await backupDrive(cloud, dest);

    expect(r.saved.sort()).toEqual(['Document/b.pdf', 'Note/写汉字/a.note']);
    expect(readFileSync(join(dest, 'Note/写汉字/a.note'), 'utf8')).toBe('AAA');
    expect(readFileSync(join(dest, 'Document/b.pdf'), 'utf8')).toBe('BB');
  });

  it('reports how much it pulled', async () => {
    const r = await backupDrive(fakeCloud(drive()).cloud, dest);
    expect(r.bytes).toBe(5);
  });

  it('downloads nothing on a second run', async () => {
    const { cloud, downloadFile } = fakeCloud(drive());
    await backupDrive(cloud, dest);
    downloadFile.mockClear();

    const r = await backupDrive(cloud, dest);
    expect(r.unchanged.sort()).toEqual(['Document/b.pdf', 'Note/写汉字/a.note']);
    expect(r.saved).toEqual([]);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('re-downloads a file whose contents changed', async () => {
    const { cloud } = fakeCloud(drive());
    await backupDrive(cloud, dest);

    const changed = fakeCloud([
      { name: 'Note', children: [{ name: '写汉字', children: [{ name: 'a.note', body: 'AAA-EDITED' }] }] },
      { name: 'Document', children: [{ name: 'b.pdf', body: 'BB' }] },
    ]);
    const r = await backupDrive(changed.cloud, dest);

    expect(r.saved).toEqual(['Note/写汉字/a.note']);
    expect(readFileSync(join(dest, 'Note/写汉字/a.note'), 'utf8')).toBe('AAA-EDITED');
  });

  it('re-downloads if the local file was deleted, despite the manifest', async () => {
    const { cloud } = fakeCloud(drive());
    await backupDrive(cloud, dest);
    rmSync(join(dest, 'Document/b.pdf'));

    const r = await backupDrive(cloud, dest);
    expect(r.saved).toEqual(['Document/b.pdf']);
  });

  // A backup that deletes is not a backup: an accidental deletion on the device would
  // propagate here and take the last copy with it.
  it('KEEPS a file that vanished from the cloud, and says so', async () => {
    const { cloud } = fakeCloud(drive());
    await backupDrive(cloud, dest);

    const smaller = fakeCloud([{ name: 'Document', children: [{ name: 'b.pdf', body: 'BB' }] }]);
    const r = await backupDrive(smaller.cloud, dest);

    expect(r.vanished).toEqual(['Note/写汉字/a.note']);
    expect(existsSync(join(dest, 'Note/写汉字/a.note'))).toBe(true);
  });

  it('keeps going when one file fails, and reports it', async () => {
    const { cloud, downloadFile } = fakeCloud(drive());
    downloadFile.mockImplementationOnce(async () => { throw new Error('corrupt'); });

    const r = await backupDrive(cloud, dest);
    expect(r.failed).toHaveLength(1);
    expect(r.saved).toHaveLength(1);
  });

  it('does not record a failed file as backed up', async () => {
    const { cloud, downloadFile } = fakeCloud(drive());
    downloadFile.mockImplementation(async () => { throw new Error('nope'); });
    await backupDrive(cloud, dest);

    const good = fakeCloud(drive());
    const second = await backupDrive(good.cloud, dest);
    expect(second.saved).toHaveLength(2);
  });

  it('writes nothing on a dry run', async () => {
    const { cloud, downloadFile } = fakeCloud(drive());
    const r = await backupDrive(cloud, dest, { dryRun: true });

    expect(r.saved).toHaveLength(2);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(existsSync(join(dest, 'Document/b.pdf'))).toBe(false);
  });

  it('leaves no temp files behind', async () => {
    const { cloud } = fakeCloud(drive());
    await backupDrive(cloud, dest);
    expect(existsSync(join(dest, 'Document/b.pdf.tmp'))).toBe(false);
  });

  it('survives a corrupt manifest by re-downloading', async () => {
    const { cloud } = fakeCloud(drive());
    await backupDrive(cloud, dest);
    writeFileSync(join(dest, '.supernote-backup.json'), 'not json');

    const r = await backupDrive(cloud, dest);
    expect(r.saved).toHaveLength(2);
  });
});
