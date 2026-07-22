// ADR-0057 D4 — MyMRC reconciliation queue (admin surface).
//
// Admin-only. Renders the pending queue (status pending + woken snoozed) with the
// mirror_table + change_kind filter and per-item Approve / Reject / Snooze. Vision
// NEVER auto-updates operational tables from MyMRC — every write flows through an
// explicit approve here (mirrors the AP approval pattern, ADR-0046).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { listPendingReconciliations } from '@/lib/reconcile/apply';
import { ReconcileClient, type ReconItem } from './ReconcileClient';

export const dynamic = 'force-dynamic';

export default async function MymrcReconcilePage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/mymrc/reconcile');
    redirect('/admin');
  }

  const rows = await listPendingReconciliations({ prisma });
  const items: ReconItem[] = rows.map((r) => ({
    id: r.id,
    mirrorTable: r.mirror_table,
    mirrorRecordId: r.mirror_record_id,
    targetTable: r.target_table,
    targetRecordId: r.target_record_id,
    fieldName: r.field_name,
    changeKind: r.change_kind,
    status: r.status,
    mymrcValue: r.mymrc_value ?? null,
    visionValue: r.vision_value ?? null,
    createdAt: r.created_at.toISOString(),
    snoozeUntil: r.snooze_until ? r.snooze_until.toISOString() : null,
  }));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← Back to Admin
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">MyMRC Reconcile</h1>
          <p className="text-sm text-dr3-mist-dim">
            Candidate changes MyMRC sync detected against Vision&apos;s operational tables. Nothing
            is written until you approve it. Approve applies the change; reject discards it; snooze
            defers it 7 days.
          </p>
        </header>
        <ReconcileClient initialItems={items} />
      </div>
    </main>
  );
}
