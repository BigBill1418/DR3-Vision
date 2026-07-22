// Operations Dashboard — shared presentational primitives (ADR-0020 re-enable).
//
// Server-only, no interactivity: pure cards + compact tables tuned for an iPad
// read in Safari. Design contract (the acceptance bar is legibility on glass):
//   - Dark Vision palette only (dr3-space / dr3-cyan / dr3-mist), ADR-0014.
//   - No real-data text below 12px (text-xs). The [11px]/[10px] sizes are used
//     ONLY for decorative uppercase eyebrow labels, never for numbers/units.
//   - Status hues are non-brand (emerald / amber / rose) so green/amber/red
//     read as STATUS against the cyan chrome — matching rate-tiles + compliance.
//   - Every number carries a label AND a unit. No bare figures.
//   - Tables scroll inside their own overflow-x container; the page never
//     scrolls sideways. Touch targets (links) are ≥44px tall.
//   - High contrast: dr3-mist (#DCEFEC) on dr3-space-2 (#0E1923) clears WCAG AA.

import * as React from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';

export type Tone = 'ok' | 'warn' | 'alert' | 'neutral' | 'info';

const TONE_RING: Record<Tone, string> = {
  ok: 'ring-emerald-400/30 bg-emerald-500/10',
  warn: 'ring-amber-400/30 bg-amber-500/10',
  alert: 'ring-rose-400/40 bg-rose-500/10',
  neutral: 'ring-dr3-steel-light/25 bg-dr3-space-2',
  info: 'ring-dr3-cyan/25 bg-dr3-cyan/[0.06]',
};

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  alert: 'bg-rose-400',
  neutral: 'bg-dr3-mist-dim/50',
  info: 'bg-dr3-cyan',
};

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  alert: 'text-rose-300',
  neutral: 'text-dr3-mist-dim',
  info: 'text-dr3-cyan',
};

/** Section band header — cyan small-caps rule matching VisionShell sections. */
export function SectionBand({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.28em] text-dr3-cyan">
          <span className="h-px w-6 bg-dr3-cyan/50" aria-hidden="true" />
          {title}
        </h2>
        {hint ? <span className="text-xs text-dr3-mist-dim">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** A status dot + label chip (used as a card corner badge). */
export function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-dr3-mist-dim">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden="true" />
      <span className={TONE_TEXT[tone]}>{label}</span>
    </span>
  );
}

/**
 * The core at-a-glance stat card. `value` is the big number; `unit` sits beside
 * it (always shown so a figure is never ambiguous); `label` is the eyebrow;
 * `sub` is a supporting line. Optional `href` turns the whole card into a ≥44px
 * touch target that drills into the source surface.
 */
export function StatCard({
  label,
  value,
  unit,
  sub,
  tone = 'neutral',
  pillLabel,
  href,
  testId,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: Tone;
  pillLabel?: string;
  href?: string;
  testId?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-dr3-mist-dim">
          {label}
        </span>
        {pillLabel ? <StatusPill tone={tone} label={pillLabel} /> : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-3xl font-bold tabular-nums text-dr3-mist sm:text-[2.1rem]">
          {value}
        </span>
        {unit ? <span className="text-sm font-medium text-dr3-mist-dim">{unit}</span> : null}
      </div>
      {sub ? <div className="text-xs leading-snug text-dr3-mist-dim">{sub}</div> : null}
    </>
  );

  const cls = `flex min-h-[6.5rem] flex-col gap-2.5 rounded-lg p-4 ring-1 ${TONE_RING[tone]}`;

  if (href) {
    return (
      <Link
        href={href}
        data-testid={testId}
        className={`${cls} transition-colors hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-dr3-cyan`}
      >
        {body}
      </Link>
    );
  }
  return (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

/**
 * Freshness pill for the MyMRC mirrors: shows relative + absolute Pacific time
 * and turns amber/rose as the last sync ages past the thresholds. `label`d so
 * staleness is visible at a glance.
 */
export function FreshnessBadge({
  tone,
  text,
  testId,
}: {
  tone: Tone;
  text: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ring-1 ${TONE_RING[tone]} ${TONE_TEXT[tone]}`}
    >
      <span className={`h-2 w-2 rounded-full ${TONE_DOT[tone]}`} aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * A horizontally-scrollable compact table. The wrapper owns the overflow so a
 * wide table never breaks the page layout on a phone. Header is sticky-free
 * (short tables); rows use ≥12px text.
 */
export function ScrollTable({
  columns,
  children,
  ariaLabel,
  testId,
}: {
  columns: { key: string; label: string; align?: 'left' | 'right' }[];
  children: ReactNode;
  ariaLabel: string;
  testId?: string;
}) {
  return (
    <div
      className="overflow-x-auto rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2"
      data-testid={testId}
    >
      <table className="w-full min-w-[34rem] border-collapse text-sm" aria-label={ariaLabel}>
        <thead>
          <tr className="border-b border-dr3-steel-light/25 text-left">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-dr3-mist-dim ${
                  c.align === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-dr3-steel-light/15">{children}</tbody>
      </table>
    </div>
  );
}

/** Empty-state row/card so a site with no data never renders a broken table. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-dr3-steel-light/25 bg-dr3-space-2 px-4 py-6 text-center text-sm text-dr3-mist-dim">
      {children}
    </div>
  );
}
