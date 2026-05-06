// Per-site MyMRC credential reader.
//
// Credentials live in env vars on CHAD-HQ (`~/.dr3-vision-secrets/mymrc.env`,
// mode 600 — see `docs/operator/mymrc-setup.md`). The reader supports
// two naming schemes for each site so the operator runbook and the
// sprint-1 ticket text can both stay valid:
//
//   - Site-name form (preferred — matches the runbook):
//       MYMRC_EUGENE_USERNAME / MYMRC_EUGENE_PASSWORD
//       MYMRC_WOODLAND_USERNAME / MYMRC_WOODLAND_PASSWORD
//
//   - Jurisdiction form (legacy alias from `docs/MYMRC-INTEGRATION.md`):
//       MYMRC_OR_USERNAME / MYMRC_OR_PASSWORD     -> Eugene
//       MYMRC_CA_USERNAME / MYMRC_CA_PASSWORD     -> Woodland
//
// Either pair satisfies a site; the site-name form wins on conflict.
// Both halves of a pair must be present together — a half-set pair is
// treated as "not configured" rather than failing partially-through.
//
// Returning `null` for "not configured" is the contract the cron
// wrapper relies on for the fail-soft path: when no credentials are
// present, the wrapper logs and exits 0 without publishing to ntfy
// (it's an operator state, not a system error).

import type { SiteCode, SiteCredentials } from './types';

interface EnvPair {
  username: string | undefined;
  password: string | undefined;
}

function readEnvPair(usernameKey: string, passwordKey: string): EnvPair {
  return {
    username: process.env[usernameKey]?.trim() || undefined,
    password: process.env[passwordKey]?.trim() || undefined,
  };
}

function pickCompletePair(...candidates: EnvPair[]): EnvPair | null {
  for (const pair of candidates) {
    if (pair.username && pair.password) return pair;
  }
  return null;
}

/**
 * Load credentials for a single site, or `null` if neither naming
 * scheme produced a complete pair. Never throws — partial config (only
 * username, only password) is treated as unconfigured.
 */
export function loadSiteCredentials(site: SiteCode): SiteCredentials | null {
  const candidates: EnvPair[] = [];
  if (site === 'eugene') {
    candidates.push(readEnvPair('MYMRC_EUGENE_USERNAME', 'MYMRC_EUGENE_PASSWORD'));
    candidates.push(readEnvPair('MYMRC_OR_USERNAME', 'MYMRC_OR_PASSWORD'));
  } else {
    candidates.push(readEnvPair('MYMRC_WOODLAND_USERNAME', 'MYMRC_WOODLAND_PASSWORD'));
    candidates.push(readEnvPair('MYMRC_CA_USERNAME', 'MYMRC_CA_PASSWORD'));
  }
  const pair = pickCompletePair(...candidates);
  if (!pair || !pair.username || !pair.password) return null;
  return { site, username: pair.username, password: pair.password };
}

/**
 * Where Playwright stores per-site auth state between scrape runs.
 * Defaults to `~/.dr3-vision/mymrc-{site}/auth.json`; the
 * `MYMRC_AUTH_STATE_DIR` env var overrides the parent dir for local
 * testing. Returns the JSON file path — caller is responsible for
 * ensuring the parent dir exists.
 */
export function authStatePath(site: SiteCode): string {
  const root =
    process.env['MYMRC_AUTH_STATE_DIR']?.trim() ||
    `${process.env['HOME'] ?? '/tmp'}/.dr3-vision`;
  return `${root}/mymrc-${site}/auth.json`;
}
