// ADR-0019.4 — the standing signature-chain health check.
//
// WHY THIS EXISTS, stated once so the assertions below read as consequences
// rather than arbitrary rules:
//
// The 08:30 PT auto-override is the mechanism ADR-0019.1 §4 calls "load-bearing
// for hitting the 9:00 AM deadline reliably". It refuses to sign as an inactive
// actor (`actorUnavailable` in escalation.ts) — correctly, because signing as a
// deactivated identity would be worse. But that guard is a DETECTOR AT THE POINT
// OF FAILURE: it speaks at 08:30 on payroll morning, thirty minutes before the
// deadline, and only by firing an ntfy.
//
// That is not enough, twice proven:
//   2026-07-07 (P14) — chain pointed at deactivated `operations@svdp.us`;
//                      t3 refused; Eugene deadline missed.
//   2026-08-04 (P16) — same dead actor, unrepaired because `prisma/seed.mjs`
//                      re-aliased it on every seed run. Loki shows t3 ran and
//                      logged `actorUnavailable:1, autoSigned:0`. The next day
//                      t4 found the period stranded and tried to page — and the
//                      app logged `stranded ntfy dropped (primary+fallback
//                      failed)`. Nobody was told. Signed ~25h late.
//
// So: a check that only speaks through the alert channel can be silenced by the
// alert channel. These tests pin a check that answers "is the chain sound?" as
// STANDING STATE, readable on a dashboard whether or not any page was delivered.

import { describe, it, expect } from 'vitest';
import {
  evaluateChainHealth,
  worstChainStatus,
  decideChainPage,
  type ChainHealthInput,
} from './chain-health';

const BILL = { id: 'bill', name: 'Bill Barnard', is_active: true, deleted_at: null };
const RICK = { id: 'rick', name: 'Rick Albritton', is_active: true, deleted_at: null };
const PATRICK = { id: 'patrick', name: 'Patrick Dills', is_active: true, deleted_at: null };
// The real shape of the account that broke payroll twice: seeded is_active=false
// on purpose (it is an import/automation alias, not a login identity).
const DEAD_BILL = { id: 'ops-alias', name: 'Bill Barnard', is_active: false, deleted_at: null };

function healthyEugene(): ChainHealthInput {
  return {
    siteCode: 'eugene',
    siteName: 'Eugene',
    chain: {
      facility_signer_user_id: 'rick',
      facility_override_actor_user_ids: ['bill', 'patrick'],
      ops_signer_user_id: 'patrick',
      ops_override_actor_user_ids: ['bill'],
      auto_override_actor_user_id: 'bill',
    },
    users: [BILL, RICK, PATRICK],
  };
}

describe('evaluateChainHealth — the healthy baseline', () => {
  it('a fully-resolved chain with all-active users is green with no findings', () => {
    const r = evaluateChainHealth(healthyEugene());
    expect(r.status).toBe('green');
    expect(r.findings).toEqual([]);
    expect(r.siteCode).toBe('eugene');
  });

  it('reports the resolved auto-override actor name so the surface can show WHO would sign', () => {
    const r = evaluateChainHealth(healthyEugene());
    expect(r.autoOverrideActorName).toBe('Bill Barnard');
  });
});

// ── The failure class that killed payroll twice ──────────────────────
describe('evaluateChainHealth — inactive / missing references are RED', () => {
  it('an INACTIVE auto-override actor is red and names the 08:30 consequence', () => {
    const input = healthyEugene();
    input.chain.auto_override_actor_user_id = 'ops-alias';
    input.users = [DEAD_BILL, RICK, PATRICK];

    const r = evaluateChainHealth(input);
    expect(r.status).toBe('red');
    const f = r.findings.find((x) => x.slot === 'auto_override');
    expect(f).toBeDefined();
    expect(f?.reason).toBe('inactive');
    expect(f?.userId).toBe('ops-alias');
    // The detail must state the operational consequence, not just the fact —
    // "inactive user" alone does not tell an operator payroll is at risk.
    expect(f?.detail).toMatch(/08:30/);
    expect(f?.detail).toMatch(/auto-override/i);
  });

  it('a MISSING (dangling) reference is red and distinguished from merely inactive', () => {
    const input = healthyEugene();
    input.chain.ops_signer_user_id = 'ghost';
    const r = evaluateChainHealth(input);
    expect(r.status).toBe('red');
    const f = r.findings.find((x) => x.slot === 'ops_signer');
    expect(f?.reason).toBe('missing');
  });

  it('a SOFT-DELETED user counts as broken even when is_active is true', () => {
    // The canonical liveness predicate elsewhere in this repo is
    // `{ is_active: true, deleted_at: null }`. escalation.ts's own guard checks
    // only is_active — so a soft-deleted-but-active user would pass it and sign
    // payroll. This check is deliberately STRICTER than the guard it watches.
    const input = healthyEugene();
    input.users = [{ ...BILL, deleted_at: new Date('2026-08-01T00:00:00Z') }, RICK, PATRICK];
    const r = evaluateChainHealth(input);
    expect(r.status).toBe('red');
    expect(r.findings.find((x) => x.slot === 'auto_override')?.reason).toBe('deleted');
  });

  it('flags a broken OVERRIDE-LIST member, not just the primary slots', () => {
    const input = healthyEugene();
    input.chain.facility_override_actor_user_ids = ['bill', 'ghost'];
    const r = evaluateChainHealth(input);
    expect(r.status).toBe('red');
    expect(r.findings.some((x) => x.slot === 'facility_override' && x.userId === 'ghost')).toBe(
      true,
    );
  });

  it('reports EVERY broken reference, not just the first — a partial repair must stay red', () => {
    const input = healthyEugene();
    input.chain.auto_override_actor_user_id = 'ops-alias';
    input.chain.ops_override_actor_user_ids = ['ops-alias'];
    input.chain.facility_override_actor_user_ids = ['ops-alias', 'patrick'];
    input.users = [DEAD_BILL, RICK, PATRICK];

    const r = evaluateChainHealth(input);
    expect(r.status).toBe('red');
    expect(r.findings.map((f) => f.slot).sort()).toEqual([
      'auto_override',
      'facility_override',
      'ops_override',
    ]);
  });

  // This is the regression test the coordinator asked for: the check must fail
  // against the EXACT pre-fix production shape, so a seed regression that
  // reinstates it cannot pass silently.
  it('REGRESSION: the pre-2026-08-11 production shape (dead operations@ alias) is red at BOTH sites', () => {
    for (const siteCode of ['eugene', 'woodland']) {
      const r = evaluateChainHealth({
        siteCode,
        siteName: siteCode,
        chain: {
          facility_signer_user_id: 'rick',
          facility_override_actor_user_ids: ['ops-alias', 'patrick'],
          ops_signer_user_id: 'patrick',
          ops_override_actor_user_ids: ['ops-alias'],
          auto_override_actor_user_id: 'ops-alias',
        },
        users: [DEAD_BILL, RICK, PATRICK],
      });
      expect(r.status).toBe('red');
      expect(r.findings.some((f) => f.slot === 'auto_override' && f.reason === 'inactive')).toBe(
        true,
      );
    }
  });
});

// ── Degenerate-but-resolvable configurations ─────────────────────────
describe('evaluateChainHealth — degenerate configs are AMBER, not red', () => {
  // Amber, not red, because the chain still functions: the auto-override would
  // fire and payroll would ship. What is lost is the FOUR-EYES property. That is
  // worth seeing before a deadline morning, but it must not cry wolf at the same
  // volume as a chain that cannot sign at all.
  it('the same person in both signer slots collapses four-eyes → amber', () => {
    const input = healthyEugene();
    input.chain.facility_signer_user_id = 'patrick';
    const r = evaluateChainHealth(input);
    expect(r.status).toBe('amber');
    expect(r.findings[0]?.reason).toBe('degenerate_same_signer');
  });

  it('an empty override list leaves a slot with no human backstop → amber', () => {
    const input = healthyEugene();
    input.chain.ops_override_actor_user_ids = [];
    const r = evaluateChainHealth(input);
    expect(r.status).toBe('amber');
    expect(r.findings[0]?.reason).toBe('degenerate_no_override');
  });

  it('the auto-override actor also holding a signer slot is amber (self-override)', () => {
    const input = healthyEugene();
    input.chain.auto_override_actor_user_id = 'patrick';
    const r = evaluateChainHealth(input);
    expect(r.status).toBe('amber');
    expect(r.findings[0]?.reason).toBe('degenerate_actor_is_signer');
  });

  it('RED WINS: a broken reference outranks any number of degenerate findings', () => {
    const input = healthyEugene();
    input.chain.ops_override_actor_user_ids = []; // amber
    input.chain.auto_override_actor_user_id = 'ghost'; // red
    const r = evaluateChainHealth(input);
    expect(r.status).toBe('red');
  });
});

describe('worstChainStatus', () => {
  it('rolls up across sites, worst-wins', () => {
    expect(worstChainStatus(['green', 'green'])).toBe('green');
    expect(worstChainStatus(['green', 'amber'])).toBe('amber');
    expect(worstChainStatus(['amber', 'red'])).toBe('red');
  });

  it('an EMPTY site list is red, not green — no chains means nothing can sign', () => {
    // A chain table that returns zero rows must never read as "all healthy".
    // This is the empty-set trap: `.some()` over nothing is false.
    expect(worstChainStatus([])).toBe('red');
  });
});

// ── Transition-based paging (the mymrc decidePage pattern) ───────────
describe('decideChainPage — page on the leading edge, then re-page slowly', () => {
  const T0 = new Date('2026-08-11T14:00:00Z');
  const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

  it('pages on the first unhealthy observation (no prior state)', () => {
    expect(decideChainPage(null, 'red', T0)).toBe(true);
  });

  it('pages on the transition green → red', () => {
    expect(decideChainPage({ status: 'green', observed_at: T0 }, 'red', hours(1))).toBe(true);
  });

  it('does NOT re-page while the same unhealthy state persists inside the window', () => {
    expect(decideChainPage({ status: 'red', observed_at: T0 }, 'red', hours(6))).toBe(false);
  });

  it('re-pages a persisting failure once past the re-page interval', () => {
    // Slow-moving condition: hours, not minutes (ADR-0037 cooldown tiering).
    expect(decideChainPage({ status: 'red', observed_at: T0 }, 'red', hours(25))).toBe(true);
  });

  it('never pages while healthy, however long it has been healthy', () => {
    expect(decideChainPage({ status: 'green', observed_at: T0 }, 'green', hours(999))).toBe(false);
    expect(decideChainPage(null, 'green', T0)).toBe(false);
  });

  it('pages on amber→red escalation even inside the re-page window', () => {
    // A worsening state is news even if we paged about amber an hour ago.
    expect(decideChainPage({ status: 'amber', observed_at: T0 }, 'red', hours(1))).toBe(true);
  });

  it('does NOT page on red→amber improvement inside the window (recovery is not an alarm)', () => {
    expect(decideChainPage({ status: 'red', observed_at: T0 }, 'amber', hours(1))).toBe(false);
  });
});
