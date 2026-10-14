// scripts/eval-recognition.ts
/**
 * Re-scores the recognisers on the 126 labelled recall cells of 2026-08-24..09-30, so a
 * new partner model — a Go release, a vision-capable Jev — can be judged on the same
 * cells before config/recognition.json is changed.
 *
 *   npm run eval:recognition                # the configured partner
 *   npm run eval:recognition -- kimi-k3 chat # any Go model and API
 *
 * Network-bound and sequential on purpose; costs one Google and one partner call per cell.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildRecognisers, loadGoKey, loadRecognitionConfig } from '../src/recall/recognise/config.js';
import { decideCell } from '../src/recall/verdict.js';
import { referenceStrokeCount } from '../src/recall/recognise/reference.js';
import type { Cell } from '../src/recall/cells.js';

const root = join(import.meta.dirname, '..');
// process.loadEnvFile throws ENOENT when the file is absent (as it is here, outside a .env
// setup) rather than being a no-op; guard the same way src/cli.ts does.
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const cfg = loadRecognitionConfig(join(root, 'config/recognition.json'));
const [model, api] = process.argv.slice(2);
if (model !== undefined) cfg.partner = { ...cfg.partner, model, api: (api ?? 'chat') as typeof cfg.partner.api };
const { google, partner } = buildRecognisers(cfg, loadGoKey(process.env, join(homedir(), '.local/share/opencode/auth.json')));
if (partner === null) throw new Error('No OpenCode Go key found.');

type Label = { id: string; expected: string; correct: boolean };
const labels = JSON.parse(readFileSync(join(root, 'eval/recognition/labels.json'), 'utf8')) as Label[];

const tally = { google: [0, 0], partner: [0, 0], ambiguous: [0, 0], pair: [0, 0] }; // [false fails, false passes]
const score = (key: keyof typeof tally, pass: boolean, correct: boolean) => {
  if (correct && !pass) tally[key][0]! += 1;
  if (!correct && pass) tally[key][1]! += 1;
};

for (const [n, l] of labels.entries()) {
  const s = JSON.parse(readFileSync(join(root, `eval/recognition/strokes/${l.id}.json`), 'utf8')) as Pick<Cell, 'cellMm' | 'strokes'>;
  const cell: Cell = { ...s, png: readFileSync(join(root, `eval/recognition/cells/${l.id}.png`)) };
  const g = await google!.recognise(cell, l.expected);
  const p = await partner.recognise(cell, l.expected);
  // Each row scores one partner mode: 'google' is Google with the stroke gate (mode off),
  // 'partner' the partner alone, 'ambiguous' the partner asked only one stroke off, 'pair'
  // the partner asked about every pass.
  const reference = referenceStrokeCount(l.expected);
  const strokeDelta = s.strokes.length === 0 || reference === null ? null : s.strokes.length - reference;
  const opts = { eligible: new Set<string>(), confusion: false, strokeDelta, readDelta: null, maxStrokeDelta: cfg.maxStrokeDelta };
  score('google', decideCell(l.expected, { google: g, partner: null, device: null }, { ...opts, partnerMode: 'off' })?.result === 'pass', l.correct);
  score('partner', decideCell(l.expected, { google: null, partner: p, device: null }, { ...opts, partnerMode: 'always' })?.result === 'pass', l.correct);
  score('ambiguous', decideCell(l.expected, { google: g, partner: p, device: null }, { ...opts, partnerMode: 'ambiguous' })?.result === 'pass', l.correct);
  score('pair', decideCell(l.expected, { google: g, partner: p, device: null }, { ...opts, partnerMode: 'always' })?.result === 'pass', l.correct);
  process.stdout.write(`\r${n + 1}/${labels.length}`);
}

const correct = labels.filter((l) => l.correct).length;
console.log(`\n${labels.length} cells: ${correct} written correctly, ${labels.length - correct} wrong. Partner: ${cfg.partner.model}`);
for (const [k, [ff, fp]] of Object.entries(tally)) {
  console.log(`${k.padEnd(10)} correct marked wrong ${ff}, wrong marked right ${fp}, total ${ff! + fp!}`);
}
