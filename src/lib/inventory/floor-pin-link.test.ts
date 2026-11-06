// ADR-0072 Am.2 — the link script's argument parser (pure). The DB path, refusals
// and audit row are in floor-pin-link.db.test.ts. Nothing here touches a database.
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/link-floor-pin.mjs';

describe('link-floor-pin parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs(['--actor=a', '--manager=m', '--operator=o'])).toEqual({
      apply: false,
      clear: false,
      actor: 'a',
      manager: 'm',
      operator: 'o',
    });
  });

  it('accepts --clear without an operator, and --apply', () => {
    expect(parseArgs(['--actor=a', '--manager=m', '--clear', '--apply'])).toMatchObject({
      apply: true,
      clear: true,
      operator: '',
    });
  });

  it.each([
    [['--manager=m', '--operator=o'], /--actor/],
    [['--actor=a', '--operator=o'], /--manager/],
    [['--actor=a', '--manager=m'], /exactly one/],
    [['--actor=a', '--manager=m', '--operator=o', '--clear'], /exactly one/],
    [['--actor=a', '--manager=m', '--operator=m'], /different accounts/],
    [['--actor=a', '--manager=m', '--operator=o', '--name=Morena'], /unknown argument/],
  ])('refuses %j', (argv, msg) => {
    expect(() => parseArgs(argv)).toThrowError(msg);
  });
});
