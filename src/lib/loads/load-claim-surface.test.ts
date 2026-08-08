// ADR-0082 — the surface-level guarantees, tested structurally.
//
// Three of this ADR's claims are about the SHAPE of the code rather than the
// result of a call, and each one was FALSE somewhere before it landed:
//
//   1. Opening a load somebody else holds renders who holds it. It used to
//      `redirect()` to the queue with no message — a silent loop the operator
//      could not escape or interpret. A behavioural test cannot pin this without
//      standing up Next's router, and the defect was one line of code, so the
//      line is what is asserted.
//   2. The floor queue lists the SITE's open loads, not just the viewer's. The
//      operator-scoped query is what made a stranded load invisible.
//   3. Takeover is ONLINE-ONLY: not a floor scope, never enqueued. That is a
//      decision (ADR-0082 D5), and a decision with no guard is a comment.
//
// Structural tests, in the idiom `close-authority.test.ts` and
// `floor-surface-coverage.test.ts` already use here: read the real file, assert
// the property. A future change that reverses one of these has to delete the
// assertion deliberately — it cannot happen by accident.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = join(process.cwd(), 'src');
const LOAD_PAGE = join(SRC, 'app', 'operator', '[site]', 'load', '[id]', 'page.tsx');
const HELD_BY_PANEL = join(SRC, 'app', 'operator', '[site]', 'load', '[id]', 'held-by-panel.tsx');
const QUEUE_PAGE = join(SRC, 'app', 'operator', '[site]', 'queue', 'page.tsx');
const ACTIONS = join(SRC, 'app', 'operator', '[site]', 'actions.ts');
const FLOOR_WRITES = join(SRC, 'lib', 'operator', 'floor-writes.ts');
const OFFLINE_QUEUE = join(SRC, 'lib', 'offline-queue.ts');

const read = (p: string) => readFileSync(p, 'utf8');
/** Source with comments stripped — the prose here quotes the very patterns banned. */
const code = (p: string) =>
  read(p)
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('ADR-0082 — the silent redirect loop is gone', () => {
  it('never bounces a non-assignee back to the queue', () => {
    // THE DEFECT, named exactly. `if (load.assigned_operator_id !== session.user.id)
    // redirect(`/operator/${siteCode}/queue`)` produced the loop JT hit: tap the
    // load, land on the queue, tap the load, land on the queue, with the holder's
    // name on no screen anywhere.
    const src = code(LOAD_PAGE);
    expect(src, 'the load page redirects to the queue again').not.toMatch(
      /redirect\(\s*`\/operator\/\$\{siteCode\}\/queue`\s*\)/,
    );
  });

  it('renders the held-by panel for a load another operator holds', () => {
    const src = code(LOAD_PAGE);
    expect(src).toContain('HeldByPanel');
    // The holder's NAME must reach the panel. Rendering "held by someone" is the
    // same silence one adjective further along.
    expect(src).toMatch(/holderName=\{load\.assigned_operator\?\.name/);
  });

  it('still refuses a load at ANOTHER SITE outright (hard rule #2 is untouched)', () => {
    // Widening visibility within a site must not have widened it across sites.
    // Eugene and Woodland are strictly separated; a cross-site load is not one
    // this operator may know about, let alone take.
    expect(code(LOAD_PAGE)).toMatch(/if\s*\(!load\s*\|\|\s*load\.site_id\s*!==\s*site\.id\)/);
  });
});

describe('ADR-0082 — the queue shows the site’s open loads, with names', () => {
  it('reads the SITE-wide listing, not the operator-scoped one', () => {
    const src = code(QUEUE_PAGE);
    expect(src).toContain('listSiteOpenLoads');
    // The operator-scoped function is gone from the module; naming it here means
    // a re-introduction fails a test rather than quietly re-hiding stranded work.
    expect(src).not.toContain('listOperatorOpenLoads');
  });

  it('renders the held-by-others block', () => {
    expect(code(QUEUE_PAGE)).toContain('HeldByOthersSection');
  });

  it('keeps the current-Pacific-day window on EXPECTED loads only', () => {
    // ADR-0065 D5 is not relaxed by this ADR. The day floor still governs
    // browsing expected hauls; open loads were already exempt and stay exempt.
    const src = code(QUEUE_PAGE);
    expect(src).toContain('currentPacificDayWindow');
    expect(src).toMatch(
      /expected_arrival_at:\s*\{\s*gte:\s*today\.start,\s*lt:\s*today\.endExclusive/,
    );
  });
});

describe('ADR-0082 D5 — takeover is ONLINE-ONLY', () => {
  it('is not a replayable floor scope', () => {
    // A takeover is a CONTENTION action: replaying one hours later would settle a
    // contest that is already over, against a load whose state has moved on. It
    // also captures no operator data, so refusing it offline costs a tap, not a
    // count. `FLOOR_SCOPES` is the allowlist the replay endpoint dispatches
    // through — absence from it is the enforcement.
    const src = code(FLOOR_WRITES);
    expect(src, 'takeover was added to the replayable floor scopes').not.toMatch(/takeover/i);
  });

  it('never enqueues itself for offline replay', () => {
    const src = code(HELD_BY_PANEL);
    expect(src).toContain('takeOverLoadAction');
    expect(src, 'the takeover panel enqueues an offline action').not.toContain('enqueueAction');
  });

  it('reads the outcome from the RETURN VALUE, never from a thrown message (Am.1)', () => {
    // ┌─ LOAD-BEARING ─────────────────────────────────────────────────────────┐
    // │ THIS is the regression lock for Am.1. Do not delete it as "duplicated  │
    // │ by held-by-panel.test.tsx" — it is not duplicated, it is the only test │
    // │ that catches the realistic regression.                                 │
    // └────────────────────────────────────────────────────────────────────────┘
    //
    // MEASURED (2026-08-08), because the distinction is not obvious: re-adding
    // the string-match ALONGSIDE the return value — the shape a "defensive
    // cleanup" would actually take — leaves `held-by-panel.test.tsx` **fully
    // green at 7/7**, because the return path still works and the dead `catch`
    // branch is simply never reached in the tests. Only this assertion fails.
    //
    // The behavioural suite catches the OTHER direction (someone removing the
    // return path); this one catches dead message-inspection creeping back. Both
    // are needed, and neither is redundant.
    //
    // The first cut selected `takeover.error_moved` by
    // `e.message.includes('load_claim_moved')` — a direct contradiction of
    // `use-claim-loss-guard.ts`, which exists BECAUSE a Server Action's throw is
    // redacted in production. Since the redaction is real, that match could never
    // fire live: the key was dead in three locales and every lost race rendered
    // the generic retry copy, pushing the operator at a contest already settled.
    //
    // A future "helpful" change that re-adds message inspection is asserting
    // something production cannot supply, and must fail loudly rather than
    // silently degrade the banner again.
    const panel = code(HELD_BY_PANEL);
    expect(panel, 'the panel string-matches a redacted error message').not.toMatch(
      /\.message\s*\.?\s*(includes|indexOf|match)/,
    );
    expect(panel, 'the panel reads e.message').not.toMatch(/instanceof\s+Error\s*\?\s*e\.message/);
    expect(panel).not.toContain('load_claim_moved');
    // …and the action must therefore RETURN the outcome.
    expect(code(ACTIONS)).toMatch(/Promise<TakeoverActionResult>/);
  });

  it('still carries an idempotency key — a live double-tap is real', () => {
    expect(code(HELD_BY_PANEL)).toContain('newIdempotencyKey()');
    expect(code(ACTIONS)).toMatch(/takeOverLoadAction\(\s*\n?\s*idempotencyKey: string/);
  });

  it('a REPLAYED write for a taken-over load parks with its own named reason', () => {
    // The displaced claimer's queued stack replays and gets 403
    // `load_not_assigned_to_operator`. `classify(403)` already parked it — retry
    // behaviour is unchanged and correct, since no number of attempts gives this
    // operator the load back. What was missing was the REASON.
    const q = code(OFFLINE_QUEUE);
    expect(q).toContain('CONFLICT_LOAD_TAKEN_OVER');
    expect(q).toContain("body.error === 'load_not_assigned_to_operator'");
  });

  it('names the takeover BEFORE the generic 403, which claims the session expired', () => {
    // THE ORDERING IS THE FIX. `reasonLabel` ends with
    // `lastError?.includes('403') → why_session` — "Your sign-in expired before
    // this was sent." For a load somebody else now holds that is simply false,
    // and it sends the operator to re-enter a PIN that will not help. A branch
    // added after it would be dead.
    const src = code(
      join(SRC, 'app', 'operator', '[site]', 'queue', 'conflicts', 'conflicts-client.tsx'),
    );
    const specific = src.indexOf("'conflict:load_taken_over'");
    const generic = src.indexOf("lastError?.includes('403')");
    expect(specific, 'the takeover reason branch is missing').toBeGreaterThan(-1);
    expect(generic, 'the generic 403 branch is missing').toBeGreaterThan(-1);
    expect(specific, 'the takeover branch is unreachable behind the generic 403').toBeLessThan(
      generic,
    );
  });

  it('the queue module it opted out of is the one that has a conflicts screen', () => {
    // Sanity on the opt-out: a scope NOT in the queue never parks as a conflict,
    // so this only stays a safe choice while the action is retried by a person on
    // a live connection. Asserted so the reasoning is checkable rather than
    // asserted — if the conflict machinery ever became the only failure surface,
    // this test names the assumption that changed.
    expect(read(OFFLINE_QUEUE)).toContain('CONFLICT_PREFIX');
  });
});

describe('ADR-0082 — every string the takeover surface renders is translated', () => {
  const LOCALES = ['en', 'es', 'ur'] as const;

  /** Every `t('some.key')` literal in a file. */
  function translationKeys(file: string): string[] {
    return [...read(file).matchAll(/\bt\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/g)].map((m) => m[1]!);
  }

  function lookup(locale: string, dotted: string): unknown {
    const dict = JSON.parse(
      readFileSync(join(SRC, 'i18n', 'locales', locale, 'operator.json'), 'utf8'),
    ) as Record<string, unknown>;
    return dotted
      .split('.')
      .reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], dict);
  }

  const KEYS = [
    ...new Set([
      ...translationKeys(HELD_BY_PANEL),
      ...translationKeys(join(SRC, 'app', 'operator', '[site]', 'queue', 'open-loads.tsx')),
    ]),
  ];

  it('found the keys (a zero-length sweep would vacuously pass every locale)', () => {
    // Guards the guard. `takeover.*` alone is 14 keys plus the queue block.
    expect(KEYS.length).toBeGreaterThanOrEqual(14);
    expect(KEYS).toContain('takeover.held_by');
    expect(KEYS).toContain('queue.held_by');
  });

  it.each(LOCALES)('%s carries a non-empty string for every one of them', (locale) => {
    const missing = KEYS.filter((k) => {
      const v = lookup(locale, k);
      return typeof v !== 'string' || v.trim() === '';
    });
    // CLAUDE.md hard rule #4 — English, Spanish and Urdu ship on day 1, not later.
    expect(missing, `${locale} is missing: ${missing.join(', ')}`).toEqual([]);
  });
});
