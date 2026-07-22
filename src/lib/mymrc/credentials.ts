// ADR-0057 D1/D9 — MyMRC admin credential reader (DB-backed, single identity).
//
// Vision now logs into MyMRC as Bill's ONE admin identity (ADR-0057 D1). Those
// credentials live ENCRYPTED in Postgres (see credential-store.ts) and are
// entered via the `/admin/mrc-scrape` admin surface — NEVER a `.env` file. This
// module is the scrape worker's read path over that store.
//
// It replaces the retired per-site env-var scheme. The old
// `MYMRC_{EUGENE,WOODLAND,OR,CA}_{USERNAME,PASSWORD}` variables were NEVER
// honored (the service accounts they named were never created — see ADR-0038
// preamble + ADR-0057 context: zero pulls in months), so they are deleted
// outright rather than migrated. Site scoping no longer happens on the login
// identity; it happens on the DATA (records carry `Recycler__c` = "DR3 Woodland"
// / "DR3 Eugene").
//
// D9 posture change (ADR-0057 D9): missing credentials are NO LONGER a fail-soft
// "skip + exit 0" operator state. They are a LOUD failure — `loadAdminCredentials`
// THROWS `CredentialsNotConfiguredError`, and the caller pages + exits non-zero.
// This is what closes the historical silent-no-op failure mode.

import { getMymrcCredentials, type MymrcCredentials } from './credential-store';
import type { PrismaClient } from '@prisma/client';

/**
 * Thrown at scrape startup when NO admin credentials are configured in the DB
 * store (ADR-0057 D9). Distinct from a decrypt/key failure (which the store
 * surfaces as `CredentialDecryptError` / `CredentialKeyUnavailableError`): this
 * one means "Bill has not entered his MyMRC login yet", and the fix is to enter
 * it at `/admin/mrc-scrape` — not to investigate corruption.
 */
export class CredentialsNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsNotConfiguredError';
  }
}

/**
 * Load the single MyMRC admin credential from the encrypted DB store and return
 * the decrypted `{ username, password }`. SERVER/SCRAPE ONLY — the caller must
 * never log or forward the password.
 *
 * Fail-loud (ADR-0057 D9): THROWS `CredentialsNotConfiguredError` when the store
 * is empty — there is no `null`/skip path. It may also propagate the store's
 * fail-closed errors (`CredentialDecryptError` on tamper/wrong-key,
 * `CredentialKeyUnavailableError` when `MYMRC_CRED_KEY` is unset while a row
 * exists); those are loud by design too and must NOT be masked as "unconfigured".
 */
export async function loadAdminCredentials(prisma: PrismaClient): Promise<MymrcCredentials> {
  const creds = await getMymrcCredentials(prisma);
  if (!creds) {
    throw new CredentialsNotConfiguredError(
      'MyMRC admin credentials are not configured — enter them at /admin/mrc-scrape',
    );
  }
  return creds;
}

/**
 * Where Playwright persists the admin session between scrape runs. Single admin
 * context (ADR-0057 D1) — one path, NOT per-site. `MYMRC_AUTH_STATE_DIR`
 * overrides the parent dir (set to a mounted volume in compose); otherwise it
 * defaults under `~/.dr3-vision`. Returns the JSON file path — the caller
 * (portal-client) ensures the parent dir exists.
 */
export function adminAuthStatePath(): string {
  const root =
    process.env['MYMRC_AUTH_STATE_DIR']?.trim() ||
    `${process.env['HOME'] ?? '/tmp'}/.dr3-vision`;
  return `${root}/mymrc-admin/auth.json`;
}
