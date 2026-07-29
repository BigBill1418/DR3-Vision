// ADR-0046 Amendment 9 (§2.3) — the storage-layer invariants must SHIP.
//
// WHY A TEST OVER SQL TEXT. CI does not run migrations (see the repo's
// hand-written-migration rule and the TEXT-vs-uuid trap it exists to prevent), so
// nothing else in the suite would notice if these constraints were edited out,
// renamed, or weakened — and the failure would surface as corrupt approval
// evidence in production, months later, with no test ever having gone red.
//
// The constraints themselves were verified against LIVE PRODUCTION before
// shipping: the migration was replayed inside `BEGIN; … ROLLBACK;`, all 17
// pre-existing `ap_equipment_links` rows satisfied the new CHECK, and four
// negative cases (no disposition, two dispositions, resolved-without-asset,
// rejected-with-blank-note) were each REJECTED by Postgres. That is the proof the
// constraints work; this file is the guard that they remain in the file.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260815_adr0046_a9_ap_equipment_escape_hatch/migration.sql',
  ),
  'utf8',
);

/** Collapse whitespace so assertions survive reformatting. */
const flat = sql.replace(/\s+/g, ' ');

describe('Amendment 9 migration — exactly-one-disposition CHECK', () => {
  it('adds the constraint to ap_equipment_links', () => {
    expect(flat).toContain('ADD CONSTRAINT "ap_equipment_links_exactly_one_disposition"');
  });

  it('counts all THREE dispositions and requires the sum to be exactly 1', () => {
    const check = /ap_equipment_links_exactly_one_disposition" CHECK \((.+?)\);/.exec(flat)?.[1];
    expect(check).toBeTruthy();
    expect(check).toContain('"equipment_id" IS NOT NULL');
    expect(check).toContain('"equipment_request_id" IS NOT NULL');
    // `is_not_equipment_related` is BOOLEAN NOT NULL DEFAULT false — testing it
    // with IS NOT NULL would make the constraint vacuously true for every row.
    expect(check).toContain('WHEN "is_not_equipment_related" THEN 1');
    expect(check).not.toMatch(/"is_not_equipment_related" IS NOT NULL/);
    expect(check).toMatch(/=\s*1/);
  });

  it('is re-runnable — drops before adding, so a replay never errors', () => {
    expect(flat).toContain(
      'DROP CONSTRAINT IF EXISTS "ap_equipment_links_exactly_one_disposition"',
    );
  });
});

describe('Amendment 9 migration — request terminal-state evidence CHECK', () => {
  it('requires a resolved request to name the asset it produced', () => {
    expect(flat).toMatch(
      /"status" = 'resolved' AND "resolved_equipment_id" IS NOT NULL AND "resolved_at" IS NOT NULL/,
    );
  });

  it('requires a rejected request to carry a NON-BLANK note', () => {
    expect(flat).toContain(`btrim("resolution_note") <> ''`);
  });

  it('keeps an open request free of resolution evidence', () => {
    expect(flat).toMatch(
      /"status" = 'open' AND "resolved_equipment_id" IS NULL AND "resolved_at" IS NULL/,
    );
  });
});

describe('Amendment 9 migration — repo conventions', () => {
  it('uses TEXT ids, never uuid — a uuid column passes CI and fails on deploy', () => {
    expect(flat).toMatch(/CREATE TABLE IF NOT EXISTS "ap_equipment_requests" \( "id" TEXT/);
    expect(flat).not.toMatch(/"id"\s+UUID/i);
    expect(flat).not.toMatch(/gen_random_uuid\(\)(?!::text)/);
  });

  it('is clean-replay safe — every DDL statement is guarded', () => {
    expect(flat).toContain('CREATE TABLE IF NOT EXISTS "ap_equipment_requests"');
    expect(flat).toContain('ADD COLUMN IF NOT EXISTS "equipment_request_id"');
    expect(flat).toContain('ADD COLUMN IF NOT EXISTS "can_resolve_equipment_requests"');
    // FKs are wrapped in DO blocks that swallow duplicate_object.
    expect(flat.match(/EXCEPTION WHEN duplicate_object THEN NULL/g)?.length).toBeGreaterThanOrEqual(
      6,
    );
  });

  it('seeds the rollout surface born PILOT and never reverts a live flip', () => {
    expect(flat).toContain(`'notification', 'ap_equipment_request'`);
    expect(flat).toContain(`'pilot'`);
    expect(flat).toContain('ON CONFLICT ("surface_code", "site_id") DO NOTHING');
  });

  it('grants the site-manager flag by EMAIL, never by name', () => {
    // Bill, Janette and Morena each have a second, email-less operator PIN account;
    // a name-keyed grant lands on the account that cannot reach the worklist.
    expect(flat).toContain(`lower(u."email") = v.email`);
    expect(flat).not.toMatch(/u\."name" = v\./);
    for (const email of [
      'morena.gomez@svdp.us',
      'rick.albritton@svdp.us',
      'janette.tomas@svdp.us',
    ]) {
      expect(flat).toContain(email);
    }
  });
});
