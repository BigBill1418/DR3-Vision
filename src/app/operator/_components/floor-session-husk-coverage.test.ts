// Every FLOOR surface must see through an expired session, not past it.
//
// ## What this pins and why a source scan
//
// `src/lib/session-husk.test.ts` proves the shape: Auth.js answers the
// five-minute operator idle window (and the ADR-0053 D2 kill-switch) with an
// EMPTY token rather than a null one, and `@auth/core` builds a session from
// any non-null token. A guard is therefore handed a HUSK — `session.user` is a
// truthy object with no `id` and no `role`.
//
// `if (!session?.user)` does not see it. `if (!session?.user?.id)` does.
//
// On 2026-08-10 that one character cost Woodland its first load rejection: the
// photo guard fell through to `undefined !== 'operator'` and answered 403, and
// the iPad offered a retry no retry could clear. The floor PAGES had the same
// blind spot pointing a different direction — they waved the husk past the
// sign-in check and into the role check, which redirects to `HOME_ROUTE`, which
// sends an unauthenticated visitor to the MANAGER Microsoft sign-in. A person
// on a forklift cannot complete that; the PIN screen at `/operator/<site>` is
// the only sign-in they have.
//
// A source scan rather than a render test because these are Server Components
// whose whole behaviour is `redirect()` before any markup exists — there is no
// seam to drive, and the same reasoning the repo already used for
// `photo-grant-header-consistency.test.ts` and the money-minting scan applies:
// the failure is a spelling that both halves would keep passing their own
// tests through.
//
// FALSIFIED BY HAND: reverting either floor page to `if (!session?.user)` reds
// this, naming the file.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FLOOR_ROOT = join(process.cwd(), 'src/app/operator');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

/**
 * The husk-blind spellings. Each tests the OBJECT rather than the id, so each
 * reads a signed-out operator as signed in.
 *
 * `?.user?.id`, `?.user?.role` and `?.user?.name` are all fine — they read a
 * FIELD, which is undefined on a husk. Only a bare object test is the defect,
 * so the pattern requires the next character to end the expression.
 */
const HUSK_BLIND = /!session\?\.user\s*(?:\)|\|\||&&|;)/;

describe('no floor surface tests `!session?.user` without reading a field', () => {
  const offenders = sourceFiles(FLOOR_ROOT)
    .map((f) => ({ file: f, src: readFileSync(f, 'utf8') }))
    .filter(({ src }) => HUSK_BLIND.test(src))
    .map(({ file }) => file.replace(`${process.cwd()}/`, ''));

  it('finds none', () => {
    expect(
      offenders,
      'these floor files treat an EXPIRED session as a signed-in one — see the header',
    ).toEqual([]);
  });

  // Guard-the-guard. A pattern that matches nothing would pass this suite
  // forever while proving nothing, which is the failure mode a source scan is
  // most prone to. Prove the matcher on the exact string it exists to catch.
  it('the matcher really does catch the spelling it is written against', () => {
    expect(HUSK_BLIND.test('  if (!session?.user) redirect(`/operator/x`);')).toBe(true);
    expect(HUSK_BLIND.test("  if (!session?.user || session.user.role !== 'operator') {")).toBe(
      true,
    );
    // …and does not fire on the correct forms.
    expect(HUSK_BLIND.test('  if (!session?.user?.id) redirect("/operator");')).toBe(false);
    expect(HUSK_BLIND.test("  const name = session?.user?.name ?? '';")).toBe(false);
  });

  // Guard-the-guard, second half: the scan must actually be reading files.
  it('the scan reaches real floor sources', () => {
    const files = sourceFiles(FLOOR_ROOT);
    expect(files.length, 'the walk found no floor sources — the scan is vacuous').toBeGreaterThan(
      10,
    );
    expect(files.some((f) => f.endsWith('load/[id]/page.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('queue/page.tsx'))).toBe(true);
  });
});
