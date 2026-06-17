// ADR-0030 — Recent daily-report sends table (read-only; server component).

import { formatCents } from '@/lib/bonus/calculator';
import type { listRecentSends } from '@/lib/bonus/daily-report-config';

type Row = Awaited<ReturnType<typeof listRecentSends>>[number];

interface Props {
  rows: Row[];
}

/** Render a Prisma @db.Date value as its UTC YYYY-MM-DD (the Pacific-day key). */
function dateKey(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toISOString().slice(0, 10);
}

export function RecentSends({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <p className="mt-4 rounded-md border border-dr3-cyan/20 bg-dr3-space-2/60 px-6 py-8 text-center text-sm text-dr3-mist-dim">
        No sends yet.
      </p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-dr3-cyan/20 bg-dr3-space-2/60">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-dr3-steel-light/20 text-xs uppercase tracking-wide text-dr3-mist-dim">
            <th className="px-4 py-3 font-medium">Site</th>
            <th className="px-4 py-3 font-medium">Report date</th>
            <th className="px-4 py-3 font-medium">Sent at</th>
            <th className="px-4 py-3 font-medium">Delivered</th>
            <th className="px-4 py-3 font-medium">Total today</th>
            <th className="px-4 py-3 font-medium">Bonus</th>
            <th className="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const fullyDelivered = r.delivered_count === r.recipient_count;
            return (
              <tr
                key={r.id}
                className="border-b border-dr3-steel-light/10 text-dr3-mist last:border-b-0"
              >
                <td className="px-4 py-3">{r.site.code}</td>
                <td className="px-4 py-3 font-mono text-dr3-mist-dim">{dateKey(r.report_date)}</td>
                <td className="px-4 py-3 text-dr3-mist-dim">
                  {new Date(r.sent_at).toLocaleString()}
                </td>
                <td className="px-4 py-3 font-mono">
                  {r.delivered_count}/{r.recipient_count} {fullyDelivered ? '✓' : '⚠'}
                </td>
                <td className="px-4 py-3 font-mono">{r.total_today}</td>
                <td className="px-4 py-3 font-mono">{formatCents(r.total_bonus_cents)}</td>
                <td className="px-4 py-3 font-mono text-dr3-mist-dim">{r.last_status ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
