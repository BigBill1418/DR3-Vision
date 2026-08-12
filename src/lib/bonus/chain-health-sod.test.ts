// ADR-0019.3 §2 / ADR-0019.4 — the health indicator must UNDERSTAND the
// separation-of-duties exclusion.
//
// The failure mode being prevented is a monitor that cries wolf about a
// deliberate design. Once the SoD guard is live, a Eugene historical period is
// SUPPOSED to bypass its ops signer and route to the override chain. If the
// chain-health evaluator read that as "the ops slot cannot sign, therefore the
// chain is broken", the standing indicator ADR-0019.4 built precisely so a real
// break is visible would sit red permanently — and a monitor that is always red
// is a monitor nobody reads. An exclusion is a healthy, working chain.
//
// The one case where it IS worth saying something: an excluded signer whose slot
// has no override backstop at all. `degenerate_no_override` already flags an
// empty override list as amber, but its consequence sentence is conditional
// ("if its signer is unavailable"). For an SoD-excluded slot that condition is
// not hypothetical — the signer is already, permanently, unable to sign a class
// of periods. Same severity, sharper sentence, distinct reason.

import { describe, it, expect } from 'vitest';
import { evaluateChainHealth, type ChainHealthUser } from './chain-health';

const live = (id: string, name: string): ChainHealthUser => ({
  id,
  name,
  is_active: true,
  deleted_at: null,
});

/** The real Eugene chain as of 2026-08-11, verified against production. */
const EUGENE_USERS = [
  live('rick', 'Rick Albritton'),
  live('patrick', 'Patrick Dills'),
  live('bill', 'Bill Barnard'),
];

const eugeneChain = {
  facility_signer_user_id: 'rick',
  facility_override_actor_user_ids: ['bill', 'patrick'],
  ops_signer_user_id: 'patrick',
  ops_override_actor_user_ids: ['bill'],
  auto_override_actor_user_id: 'bill',
};

const PATRICK_EXCLUDED = [
  { slot: 'ops_signer' as const, userId: 'patrick', employeeName: 'Patrick Dills' },
];

describe('an SoD-excluded signer is a HEALTHY chain (ADR-0019.3 §2)', () => {
  it('stays green when the excluded slot has a live override backstop', () => {
    const res = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain: eugeneChain,
      users: EUGENE_USERS,
      sodExclusions: PATRICK_EXCLUDED,
    });

    expect(res.status).toBe('green');
    expect(res.findings).toEqual([]);
  });

  it('reports the exclusion as standing context rather than as a finding', () => {
    // The operator still needs to SEE it — "why did Bill sign that period?" is a
    // question the dashboard should answer without anyone reading an ADR.
    const res = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain: eugeneChain,
      users: EUGENE_USERS,
      sodExclusions: PATRICK_EXCLUDED,
    });

    expect(res.sodExclusions).toEqual(PATRICK_EXCLUDED);
  });

  it('is identical to the same chain evaluated with no exclusions', () => {
    // Pins the core claim: passing an exclusion cannot change the verdict of an
    // otherwise-healthy chain. A regression that made exclusions subtract from
    // health would fail here rather than in production at 06:30 PT.
    const withOut = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain: eugeneChain,
      users: EUGENE_USERS,
    });
    const withIn = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain: eugeneChain,
      users: EUGENE_USERS,
      sodExclusions: PATRICK_EXCLUDED,
    });

    expect(withIn.status).toBe(withOut.status);
    expect(withIn.findings).toEqual(withOut.findings);
  });

  it('still reports a genuinely broken reference on a chain that also has an exclusion', () => {
    // The exclusion must not become a blanket amnesty: a dead auto-override
    // actor is red whether or not a signer is SoD-excluded. This is the
    // 2026-07-07 / 2026-08-04 condition and it must survive the new input.
    const res = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain: eugeneChain,
      users: [
        live('rick', 'Rick Albritton'),
        live('patrick', 'Patrick Dills'),
        { id: 'bill', name: 'Bill Barnard', is_active: false, deleted_at: null },
      ],
      sodExclusions: PATRICK_EXCLUDED,
    });

    expect(res.status).toBe('red');
    expect(res.findings.some((f) => f.slot === 'auto_override' && f.reason === 'inactive')).toBe(
      true,
    );
  });
});

describe('an excluded signer with no backstop is worth saying out loud', () => {
  const noBackstop = { ...eugeneChain, ops_override_actor_user_ids: [] };

  it('is amber with an exclusion-specific reason, not the generic one', () => {
    const res = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain: noBackstop,
      users: EUGENE_USERS,
      sodExclusions: PATRICK_EXCLUDED,
    });

    expect(res.status).toBe('amber');
    const f = res.findings.find((x) => x.slot === 'ops_override');
    expect(f?.reason).toBe('sod_excluded_no_backstop');
    expect(f?.detail).toMatch(/cannot sign/i);
  });

  it('stays the generic degeneracy when the slot is NOT SoD-excluded', () => {
    const res = evaluateChainHealth({
      siteCode: 'eugene',
      siteName: 'Eugene',
      chain: noBackstop,
      users: EUGENE_USERS,
    });

    expect(res.status).toBe('amber');
    expect(res.findings.find((x) => x.slot === 'ops_override')?.reason).toBe(
      'degenerate_no_override',
    );
  });
});
