import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INVARIANTS, REFUSAL_TIER_BUDGET } from './registry';

const ADR_DIR = join(process.cwd(), 'docs', 'adr');

describe('the invariant registry cannot drift from its ADRs', () => {
  it('holds at least the seed set — a registry that silently lost entries is a quiet suite', () => {
    // A FLOOR, not an equality: new invariants are the point. Its job is to fail
    // if a bad edit drops entries, which would otherwise look identical to a
    // healthy run with fewer things to say.
    expect(INVARIANTS.length).toBeGreaterThanOrEqual(8);
  });

  it('NEGATIVE CONTROL — the uniqueness check actually rejects a duplicate id', () => {
    const ids = [...INVARIANTS.map((i) => i.id), INVARIANTS[0]!.id];
    expect(new Set(ids).size).not.toBe(ids.length);
  });

  it('gives every invariant a unique, stable id', () => {
    const ids = INVARIANTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // ADR-0131 D3's naming: `INV-<SUBJECT>-<CLAIM>`, self-describing, so a digest
    // line names what broke without a lookup table.
    for (const id of ids) expect(id).toMatch(/^INV-[A-Z0-9]+(-[A-Z0-9]+)+$/);
  });

  it('points every invariant at an ADR file that actually exists on disk', () => {
    // The reason an invariant exists must be findable. `check-adr-citations.mjs`
    // already hard-gates the string form across src/; this asserts the stronger
    // property the registry needs — that the record is a real, readable file.
    const adrFiles = readdirSync(ADR_DIR);
    for (const inv of INVARIANTS) {
      expect(inv.adr, `${inv.id} has no ADR`).toMatch(/^ADR-\d{4}(\.\d)?$/);
      const num = inv.adr.slice(4);
      const match = adrFiles.find((f) => f.startsWith(`${num}-`));
      expect(match, `${inv.id} cites ${inv.adr}, which has no file in docs/adr/`).toBeDefined();
      expect(existsSync(join(ADR_DIR, match as string))).toBe(true);
    }
  });

  it('makes every invariant carry its ADR-0037 grading in writing', () => {
    for (const inv of INVARIANTS) {
      expect(inv.gate.length, `${inv.id} has no ADR-0037 grading`).toBeGreaterThan(20);
      expect(inv.title.length).toBeGreaterThan(10);
    }
  });

  it('stays inside the ADR-0131 D1 refusal budget', () => {
    // D1: 15 for the lifetime of the project. "A refusal tier with forty members is
    // an advisory tier wearing a costume." Spending the budget should require
    // amending the ADR, so the ceiling is asserted rather than assumed.
    const refusals = INVARIANTS.filter((i) => i.tier === 'refusal');
    expect(refusals.length).toBeLessThanOrEqual(REFUSAL_TIER_BUDGET);
  });

  it('makes every invariant carry a tier, an assumption and a remedy', () => {
    for (const i of INVARIANTS) {
      expect(['refusal', 'implausibility']).toContain(i.tier);
      // ADR-0131 D3: `assumption` is the load-bearing field. A short one is a
      // label, not the sentence from the ADR that this makes falsifiable.
      expect(i.assumption.length, `${i.id} has no pinned assumption`).toBeGreaterThan(30);
      expect(i.remedy.length, `${i.id} says what broke but not what to do`).toBeGreaterThan(30);
      expect(i.gate).toMatch(/q1|Tier B/i);
    }
  });
});
