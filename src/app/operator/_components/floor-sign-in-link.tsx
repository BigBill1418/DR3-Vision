'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { floorSignInPath } from '@/lib/floor-return-path';

/**
 * ADR-0144 — "Sign in again", back to the screen the operator is on.
 *
 * A link, never a form (CLAUDE.md rule #10), at the ADR-0060 gloved-hand 56px.
 * The return path is the current pathname, encoded and validated by
 * `floorSignInPath`, so after the PIN the keypad lands them where they were —
 * the same G8c round trip the connection badge already makes.
 */
export function FloorSignInLink({ siteCode, testId }: { siteCode: string; testId: string }) {
  const t = useT();
  const pathname = usePathname();
  return (
    <Link
      href={floorSignInPath(siteCode, pathname)}
      data-testid={testId}
      className="flex min-h-[56px] items-center justify-center rounded-lg bg-dr3-green px-4 py-3 text-lg font-bold text-dr3-ink"
    >
      {t('floor.action_outcome.sign_in')}
    </Link>
  );
}
