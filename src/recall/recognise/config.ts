import { existsSync, readFileSync } from 'node:fs';
import { createGoogleRecogniser } from './google.js';
import { createGoRecogniser, type GoConfig } from './go.js';
import type { Recognisers } from './http.js';
import type { PartnerMode } from '../verdict.js';

const PARTNER_MODES: readonly PartnerMode[] = ['off', 'ambiguous', 'always'];

export type RecognitionConfig = {
  partner: GoConfig;
  google: { timeoutMs: number; retries: number };
  /** First date the confusion rule applies. Earlier dates are never graded with it. */
  confusionFrom: string;
  /** A Google pass more than this many strokes off the reference is a fail. */
  maxStrokeDelta: number;
  /** When the partner is asked: never, only for a pass one stroke off, or for every pass. */
  partnerMode: PartnerMode;
};

/**
 * A config written before the stroke gate reads as the behaviour it was written for: the
 * partner asked about every pass. An unknown mode reads as 'off', with a warning, rather
 * than throwing: this config loads for every command, and a typo in a grading key must not
 * stop the morning sheet from being generated and pushed.
 */
export function loadRecognitionConfig(path: string): RecognitionConfig {
  const cfg = {
    maxStrokeDelta: 1,
    partnerMode: 'always',
    ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<RecognitionConfig>),
  } as RecognitionConfig;
  if (!PARTNER_MODES.includes(cfg.partnerMode)) {
    process.stderr.write(
      `${path}: partnerMode ${JSON.stringify(cfg.partnerMode)} is not one of ${PARTNER_MODES.join(', ')}; reading it as off.\n`,
    );
    cfg.partnerMode = 'off';
  }
  return cfg;
}

/**
 * The OpenCode Go key: `.env` first, else the one opencode itself stored. No key means no
 * partner — grading degrades to Google alone rather than failing.
 */
export function loadGoKey(env: NodeJS.ProcessEnv, authPath: string): string | null {
  const fromEnv = env.XIEHANZI_OPENCODE_GO_KEY;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (!existsSync(authPath)) return null;
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, { key?: string }>;
    return auth['opencode-go']?.key ?? null;
  } catch {
    return null;
  }
}

export function buildRecognisers(
  cfg: RecognitionConfig,
  key: string | null,
  opts: { fetch?: typeof fetch } = {},
): Recognisers {
  return {
    google: createGoogleRecogniser({ ...opts, ...cfg.google }),
    partner: key === null ? null : createGoRecogniser(cfg.partner, key, opts),
  };
}
