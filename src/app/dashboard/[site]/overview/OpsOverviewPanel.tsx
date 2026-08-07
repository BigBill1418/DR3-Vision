// Operations Dashboard — the per-site overview surface (ADR-0020 re-enable).
//
// Server component, no interactivity. Renders the OpsOverview as at-a-glance
// stat cards + compact tables, tuned to be read on the Eugene iPad in Safari:
// generous type, high contrast, ≥44px touch targets, tables that scroll inside
// their own container. Every figure carries a label and a unit. Each panel
// deep-links into its source surface so a number is one tap from its detail.
//
// Empty/degraded panels render an explicit note rather than disappearing, so
// the operator can tell "zero" from "not loaded".

import * as React from 'react';
import type { OpsOverview, MirrorFreshnessPanel } from '@/lib/dashboard/ops-overview';
import { SectionBand, StatCard, ScrollTable, FreshnessBadge, EmptyNote, StatusPill } from './ui';
import type { Tone } from './ui';

const nf = (v: number, digits = 0) => v.toLocaleString('en-US', { maximumFractionDigits: digits });
const usd = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const BUCKET_TONE: Record<string, Tone> = {
  green: 'ok',
  yellow: 'warn',
  red: 'alert',
  pending: 'neutral',
};
const BUCKET_LABEL: Record<string, string> = {
  green: 'On track',
  yellow: 'Watch',
  red: 'Action',
  pending: 'Pending',
};

function rateTone(status: string): Tone {
  return status === 'ok'
    ? 'ok'
    : status === 'warn'
      ? 'warn'
      : status === 'high'
        ? 'alert'
        : 'neutral';
}

export function OpsOverviewPanel({ data }: { data: OpsOverview }) {
  const { siteCode } = data;
  return (
    <div className="flex flex-col gap-8" data-testid="ops-overview" data-site={siteCode}>
      {/* ── Today at a glance ─────────────────────────────────────── */}
      <SectionBand
        title="Today at a glance"
        hint={
          <span>
            {data.siteName} · <span className="capitalize">{data.jurisdiction}</span> · as of{' '}
            {data.generatedPacific} PT
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard
            label="On the dock now"
            value={nf(data.loadsActive)}
            unit="active loads"
            tone={data.loadsActive > 0 ? 'info' : 'neutral'}
            sub="Operator loads in progress"
            href={`/dashboard/${siteCode}/loads`}
            testId="ov-loads-active"
          />
          <StatCard
            label="Arrived today"
            value={nf(data.loadsArrivedToday)}
            unit="loads"
            sub={`Since 12:00 AM PT (${data.todayISO})`}
            href={`/dashboard/${siteCode}/loads`}
            testId="ov-loads-today"
          />
          {data.processed ? (
            <StatCard
              label="Processing close"
              value={
                data.processed.todayClosed ? 'Closed' : data.processed.foundToday ? 'Open' : '—'
              }
              unit={data.processed.todayClosed ? '' : 'today'}
              tone={
                data.processed.todayClosed ? 'ok' : data.processed.foundToday ? 'warn' : 'neutral'
              }
              pillLabel={
                data.processed.todayClosed
                  ? 'Billing-ready'
                  : data.processed.foundToday
                    ? 'Not closed'
                    : 'No entry'
              }
              sub={
                data.processed.todayStrippedProgram != null
                  ? `${nf(data.processed.todayStrippedProgram)} program units stripped`
                  : data.processed.lastClosedISO
                    ? `Last close: ${data.processed.lastClosedISO}`
                    : 'No close entered yet'
              }
              href="/admin/processed-units"
              testId="ov-processed-close"
            />
          ) : (
            <StatCard
              label="Processing close"
              value="—"
              sub="Not available"
              testId="ov-processed-close"
            />
          )}
          {data.floor ? (
            <StatCard
              label="On the floor"
              value={nf(data.floor.totalOnFloor, 1)}
              unit="units total"
              sub={`${nf(data.floor.programOnFloor, 1)} program · ${nf(data.floor.nonProgramOnFloor, 1)} non-program`}
              href={`/dashboard/${siteCode}/loads-inventory`}
              testId="ov-floor-total"
            />
          ) : (
            <StatCard label="On the floor" value="—" sub="Not available" testId="ov-floor-total" />
          )}
        </div>
      </SectionBand>

      {/* ── Throughput & the machine (ADR-0077 Am.1 — named, not generic) ── */}
      <SectionBand
        title={
          data.equipment
            ? `${data.equipment.machineLabel} — throughput, downtime & cost`
            : 'Throughput & equipment'
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {data.equipment ? (
            <>
              <StatCard
                label="Throughput · 7-day"
                value={
                  data.equipment.last7UnitsPerDay == null
                    ? '—'
                    : nf(data.equipment.last7UnitsPerDay, 1)
                }
                unit="units / day"
                sub="Mean daily units stripped"
                href={`/dashboard/${siteCode}/equipment`}
                testId="ov-eq-7day"
              />
              <StatCard
                label="Throughput · 30-day"
                value={
                  data.equipment.last30UnitsPerDay == null
                    ? '—'
                    : nf(data.equipment.last30UnitsPerDay, 1)
                }
                unit="units / day"
                sub="Longer-run pace"
                href={`/dashboard/${siteCode}/equipment`}
                testId="ov-eq-30day"
              />
              {/* ADR-0077 D4 — an unmeasured machine must not read as a perfect
                  one. `hours_down` is NULL on every Terex event ever logged, so
                  this card used to show "0.0 hours" in GREEN. Absence is now
                  said out loud, and it is NOT an ok tone. */}
              <StatCard
                label="Downtime · 30-day"
                value={
                  data.equipment.downtimeHours == null
                    ? 'not recorded'
                    : nf(data.equipment.downtimeHours, 1)
                }
                unit={data.equipment.downtimeHours == null ? '' : 'hours'}
                tone={
                  data.equipment.downtimeHours == null
                    ? 'neutral'
                    : data.equipment.downtimeHours > 0
                      ? 'warn'
                      : 'ok'
                }
                sub={
                  data.equipment.downtimeHours == null
                    ? 'No downtime hours have been recorded for this machine'
                    : data.equipment.lastEvent
                      ? `Last event: ${data.equipment.lastEvent.kind} on ${data.equipment.lastEvent.dateISO}`
                      : 'No events logged'
                }
                href={`/dashboard/${siteCode}/equipment`}
                testId="ov-eq-downtime"
              />
              <StatCard
                label={`${data.equipment.machineLabel} cost · 30-day`}
                value={usd(data.equipment.costUsd)}
                unit=""
                sub="Logged maintenance + repair"
                href={`/dashboard/${siteCode}/equipment`}
                testId="ov-eq-cost"
              />
            </>
          ) : (
            <div className="col-span-full">
              <EmptyNote>Throughput is not available right now.</EmptyNote>
            </div>
          )}
        </div>
      </SectionBand>

      {/* ── Contract rates + compliance ───────────────────────────── */}
      <SectionBand title="Contract rates & compliance">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.rates ? (
              <>
                <StatCard
                  label="Recycling rate (by weight)"
                  value={
                    data.rates.recycling.ratePct == null
                      ? '—'
                      : `${data.rates.recycling.ratePct.toFixed(1)}%`
                  }
                  unit=""
                  tone={rateTone(data.rates.recycling.status)}
                  pillLabel={`Floor ${data.rates.recycling.floorPct.toFixed(0)}%`}
                  sub={
                    data.rates.recycling.trendPts == null
                      ? 'No prior window'
                      : `${data.rates.recycling.trendPts >= 0 ? '▲' : '▼'} ${Math.abs(data.rates.recycling.trendPts).toFixed(1)} pts vs prior window`
                  }
                  href={`/dashboard/${siteCode}/audit?tab=findings&status=open&check=${data.rates.recycling.checkCode}`}
                  testId="ov-rate-recycling"
                />
                <StatCard
                  label="Recovery rate (by units)"
                  value={
                    data.rates.recovery.ratePct == null
                      ? '—'
                      : `${data.rates.recovery.ratePct.toFixed(1)}%`
                  }
                  unit=""
                  tone={rateTone(data.rates.recovery.status)}
                  pillLabel={`Floor ${data.rates.recovery.floorPct.toFixed(0)}%`}
                  sub={
                    data.rates.recovery.trendPts == null
                      ? 'No prior window'
                      : `${data.rates.recovery.trendPts >= 0 ? '▲' : '▼'} ${Math.abs(data.rates.recovery.trendPts).toFixed(1)} pts vs prior window`
                  }
                  href={`/dashboard/${siteCode}/audit?tab=findings&status=open&check=${data.rates.recovery.checkCode}`}
                  testId="ov-rate-recovery"
                />
              </>
            ) : (
              <div className="sm:col-span-2">
                <EmptyNote>Contract rate tiles are not available right now.</EmptyNote>
              </div>
            )}
          </div>
          <div>
            {data.compliance ? (
              <div className="flex h-full flex-col gap-3 rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-dr3-mist-dim">
                    Compliance slate · this month
                  </span>
                  <span className="flex items-center gap-3 text-xs">
                    <StatusPill tone="ok" label={`${data.compliance.green} on track`} />
                    <StatusPill tone="warn" label={`${data.compliance.yellow} watch`} />
                    <StatusPill tone="alert" label={`${data.compliance.red} action`} />
                  </span>
                </div>
                <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {data.compliance.metrics.map((m) => (
                    <li
                      key={m.label}
                      className="flex items-center justify-between gap-2 rounded-md bg-dr3-space px-2.5 py-2 text-sm"
                    >
                      <span className="min-w-0 leading-tight text-dr3-mist">{m.label}</span>
                      <StatusPill
                        tone={BUCKET_TONE[m.bucket] ?? 'neutral'}
                        label={BUCKET_LABEL[m.bucket] ?? m.bucket}
                      />
                    </li>
                  ))}
                </ul>
                <a
                  href={`/dashboard/${siteCode}/compliance`}
                  className="mt-auto inline-flex min-h-[44px] items-center text-sm text-dr3-cyan underline-offset-4 hover:underline"
                >
                  Open the full compliance slate →
                </a>
              </div>
            ) : (
              <EmptyNote>Compliance slate is not available right now.</EmptyNote>
            )}
          </div>
        </div>
      </SectionBand>

      {/* ── Commodity payments + bonus ────────────────────────────── */}
      <SectionBand title="Commodity payments & bonus">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {data.commodity ? (
            <>
              <StatCard
                label="Outstanding (unpaid)"
                value={usd(data.commodity.outstandingUsd)}
                unit=""
                tone={data.commodity.outstandingUsd > 0 ? 'info' : 'neutral'}
                sub={`${data.commodity.awaitingInvoice + data.commodity.invoiced + data.commodity.disputed} loads awaiting payment`}
                href="/dashboard/ops/commodity-payments"
                testId="ov-commodity-outstanding"
              />
              <StatCard
                label="Awaiting invoice"
                value={nf(data.commodity.awaitingInvoice)}
                unit="loads"
                tone={data.commodity.overdueToInvoice > 0 ? 'warn' : 'neutral'}
                sub={`${data.commodity.overdueToInvoice} shipped > 30 days ago`}
                href="/dashboard/ops/commodity-payments"
                testId="ov-commodity-awaiting"
              />
              <StatCard
                label="Invoiced · unpaid"
                value={nf(data.commodity.invoiced)}
                unit="loads"
                tone={data.commodity.overduePaid > 0 ? 'alert' : 'neutral'}
                sub={`${data.commodity.overduePaid} unpaid > 45 days`}
                href="/dashboard/ops/commodity-payments"
                testId="ov-commodity-invoiced"
              />
              <StatCard
                label="Disputed"
                value={nf(data.commodity.disputed)}
                unit="loads"
                tone={data.commodity.disputed > 0 ? 'warn' : 'neutral'}
                sub="Needs resolution"
                href="/dashboard/ops/commodity-payments"
                testId="ov-commodity-disputed"
              />
            </>
          ) : (
            <div className="col-span-2 sm:col-span-3">
              <EmptyNote>Commodity payments are not available for this site.</EmptyNote>
            </div>
          )}
          {data.bonus ? (
            <StatCard
              label="Bonus period"
              value={
                data.bonus.periodLabel
                  ? `${data.bonus.qualifiedCount}/${data.bonus.employeeCount}`
                  : '—'
              }
              unit={data.bonus.periodLabel ? 'qualified' : ''}
              tone={data.bonus.state === 'signed' || data.bonus.state === 'paid' ? 'ok' : 'neutral'}
              pillLabel={data.bonus.state ?? 'No open period'}
              sub={
                data.bonus.periodLabel
                  ? `${data.bonus.periodLabel} · ${usd(data.bonus.totalUsd)} accrued`
                  : 'No bonus period open today'
              }
              href="/bonus"
              testId="ov-bonus"
            />
          ) : (
            <StatCard label="Bonus period" value="—" sub="Not available" testId="ov-bonus" />
          )}
        </div>
      </SectionBand>

      {/* ── MyMRC sync freshness ──────────────────────────────────── */}
      <SectionBand
        title="MyMRC sync freshness"
        hint="Hourly portal scrape — staleness is visible here"
      >
        {data.mirrors.length === 0 ? (
          <EmptyNote>MyMRC mirror status is not available right now.</EmptyNote>
        ) : (
          <ScrollTable
            ariaLabel="MyMRC mirror freshness by feed"
            testId="ov-mirrors-table"
            columns={[
              { key: 'feed', label: 'Feed' },
              { key: 'rows', label: 'Rows', align: 'right' },
              { key: 'synced', label: 'Last synced' },
              { key: 'when', label: 'Pacific time' },
              { key: 'run', label: 'Last run' },
            ]}
          >
            {data.mirrors.map((m: MirrorFreshnessPanel) => (
              <tr key={m.feed} data-testid={`ov-mirror-${m.feed}`}>
                <td className="px-3 py-2.5 text-dr3-mist">
                  {m.label}
                  {m.shared ? (
                    <span className="ml-2 rounded bg-dr3-steel/40 px-1.5 py-0.5 text-xs text-dr3-mist-dim">
                      all sites
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-dr3-mist">{nf(m.count)}</td>
                <td className="px-3 py-2.5">
                  <FreshnessBadge tone={m.freshness.tone} text={m.freshness.relative} />
                </td>
                <td className="px-3 py-2.5 text-dr3-mist-dim">
                  {m.freshness.absolutePacific ?? '—'}
                </td>
                <td className="px-3 py-2.5 text-dr3-mist-dim">
                  {m.lastRunStatus ? (
                    <StatusPill
                      tone={m.lastRunStatus === 'ok' ? 'ok' : 'alert'}
                      label={m.lastRunStatus}
                    />
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </ScrollTable>
        )}
      </SectionBand>
    </div>
  );
}
