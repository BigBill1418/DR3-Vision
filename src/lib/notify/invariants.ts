// Data invariants for the rollout-surface registry (ADR-0131 D2).
//
// Co-located with `rollout.ts`, which holds the code-side list of surfaces that the
// production `rollout_surfaces` rows are supposed to cover.

import { prisma } from '@/lib/prisma';
import { NOTIFY_SURFACE, UI_SURFACE } from '@/lib/notify/rollout';
import type { Invariant, InvariantOutcome, Violation } from '@/lib/invariants/types';
import { verdict } from '@/lib/invariants/types';

export const NOTIFY_INVARIANTS: readonly Invariant[] = [
  {
    id: 'INV-ROLLOUT-SURFACE-SEEDED',
    tier: 'refusal',
    title: 'Every rollout surface the code knows about has its production rows',
    adr: 'ADR-0047',
    assumption:
      'Register every new staff-facing surface with a `rollout_surfaces` row (born pilot).',
    severity: 'default',
    gate:
      'q1 actionable in 5min? YES - the fix is one seeded row. q2 customer-visible? no, but staff ' +
      'output either throws or is silently admin-only. q3 self-heal? no. q4 dedup? per invariant. ' +
      'q5 /status. -> Tier A, `default`.',
    remedy:
      'Seed the missing born-pilot row for the named surface and site. A notification surface with no row makes notifyStaff throw on the day it first fires; a UI surface with no row is admin-only and looks exactly like one deliberately left in pilot.',
    async check(): Promise<InvariantOutcome> {
      // P-63 / BR-7, mechanised for the one class where it CAN be.
      //
      // BR-7 asks the general question: what else is a shipped ADR whose production
      // data was never moved? In general that is unanswerable by a machine - an ADR
      // is prose. It is answerable exactly where the CODE carries a machine-readable
      // list of what the DATA is supposed to contain, and `NOTIFY_SURFACE` /
      // `UI_SURFACE` are that: CLAUDE.md hard rule #12 says every staff-facing
      // surface ships with a `rollout_surfaces` row, born pilot.
      //
      // The consequence of a missing row is not theoretical. `getRolloutState`
      // THROWS `UnregisteredSurfaceError` for a notification surface with no row -
      // loud, but only on the day that surface first fires, which for a watchdog can
      // be months after it shipped. `isUiSurfaceLive` catches the same throw into
      // `false`, so a UI surface with no row is invisible to everyone but an admin
      // and looks exactly like one deliberately left in pilot.
      const codes = [
        ...Object.values(NOTIFY_SURFACE).map((c) => ({ kind: 'notification' as const, code: c })),
        ...Object.values(UI_SURFACE).map((c) => ({ kind: 'ui' as const, code: c })),
      ];
      const siteCount = await prisma.site.count();
      const rows = await prisma.rolloutSurface.groupBy({
        by: ['kind', 'surface_code'],
        _count: { _all: true },
      });
      const seen = new Map(rows.map((r) => [`${r.kind}|${r.surface_code}`, r._count._all]));

      const violations: Violation[] = [];
      for (const { kind, code } of codes) {
        const n = seen.get(`${kind}|${code}`) ?? 0;
        if (n === 0) {
          violations.push({
            subject: `${kind}/${code}`,
            detail:
              'registered in code, NO rollout_surfaces row in production (born-pilot row never seeded)',
          });
        } else if (n < siteCount) {
          violations.push({
            subject: `${kind}/${code}`,
            detail: `${n} row(s) for ${siteCount} sites; the unseeded site resolves by throw (notification) or admin-only (ui)`,
          });
        }
      }
      // NOTE, deliberately not a violation: production also carries surface codes
      // that live OUTSIDE these two registries (processor_quota_digest,
      // reimbursement_notify, workbook_sync are registered under their own
      // constants). This invariant asserts the code-list is covered by data, not
      // that the data is covered by the code-list - the second direction would flag
      // every such constant as an orphan and would be wrong.
      return verdict(codes.length, violations);
    },
  },
];
