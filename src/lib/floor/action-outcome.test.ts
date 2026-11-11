// ADR-0144 — a failed floor check-in is classified by its CAUSE, not lumped.
//
// 2026-11-10 Woodland: an idled-out session (a 401) was shown to the operator as
// "This card changed since the page loaded" — the copy for a 409 — because the
// client caught every non-redirect error and printed one sentence. Each row below
// is one cause and the class the operator must be shown for it.

import { describe, expect, it } from 'vitest';
import { classifyFloorActionFailure, type FloorActionFailure } from './action-outcome';

class UnrecognizedActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecognizedActionError';
  }
}

const refusal = (status: number, reason = 'r') => ({ ok: false as const, status, reason });

const TABLE: Array<[string, unknown, FloorActionFailure]> = [
  ['401 — the session husk', refusal(401, 'not_authenticated_as_operator'), 'signed_out'],
  ['409 — haul read-back mismatch', refusal(409, 'haul_number_mismatch'), 'card_changed'],
  ['409 — slot withdrawn', refusal(409, 'expected_load_cancelled'), 'card_changed'],
  ['409 — no longer due today', refusal(409, 'expected_load_not_due_today'), 'card_changed'],
  ['403 — not an operator', refusal(403, 'not_an_operator'), 'not_allowed'],
  ['403 — wrong site', refusal(403, 'operator_not_assigned_to_site'), 'not_allowed'],
  ['404 — slot gone', refusal(404, 'expected_load_not_found'), 'not_allowed'],
  ['422 — some other refusal', refusal(422), 'failed'],
  ['500 — unknown status', refusal(500), 'failed'],
  [
    'stale bundle after a deploy',
    new UnrecognizedActionError(
      'Server Action "7f00ab" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    ),
    'app_updated',
  ],
  ['older wording of the same', new Error('Failed to find Server Action "7f00ab"'), 'app_updated'],
  ['Safari / iPad offline', new TypeError('Load failed'), 'no_connection'],
  ['Chrome offline', new TypeError('Failed to fetch'), 'no_connection'],
  [
    'Firefox offline',
    new TypeError('NetworkError when attempting to fetch resource.'),
    'no_connection',
  ],
  ['a production server-action digest', Object.assign(new Error('x'), { digest: '123' }), 'failed'],
  ['a TypeError that is a bug, not a network', new TypeError('x is undefined'), 'failed'],
  ['null', null, 'failed'],
  ['a string', 'boom', 'failed'],
  ['an ok-shaped value without a status', { ok: false }, 'failed'],
];

describe('ADR-0144 — classifyFloorActionFailure', () => {
  it.each(TABLE)('%s', (_name, input, expected) => {
    expect(classifyFloorActionFailure(input)).toBe(expected);
  });

  it('card_changed comes ONLY from a real 409', () => {
    const changed = TABLE.filter(([, , c]) => c === 'card_changed').map(([, i]) => i);
    for (const i of changed) expect((i as { status: number }).status).toBe(409);
  });
});
