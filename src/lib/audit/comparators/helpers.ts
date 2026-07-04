// ADR-0039 — shared comparator helpers (pure).
//
// Business-day math REUSES the existing repo helper `addBusinessDays`
// (src/lib/compliance.ts), operating on the @db.Date UTC-midnight day keys that
// `src/lib/time.ts` already standardizes. We add thin ISO-day-key wrappers so
// comparators can stay in `YYYY-MM-DD` space (Pacific calendar days).

import { addBusinessDays } from '@/lib/compliance';
import { dayISO, dayKeyUTCFromISO, pacificDayISO } from '@/lib/time';
import { makeFingerprint } from '../fingerprint';
import type {
  AuditWindow,
  CheckCode,
  CheckConfig,
  Finding,
  FindingKind,
  JsonValue,
  Severity,
} from '../types';

/** `YYYY-MM-DD` that is `n` business days after `startISO` (skips weekends + holidays). */
export function businessDayAddISO(startISO: string, n: number, holidays: Date[]): string {
  return dayISO(addBusinessDays(dayKeyUTCFromISO(startISO), n, holidays));
}

/** True when `dayISO` is a weekday (Mon–Fri) and not in the holiday set. */
export function isBusinessDayISO(iso: string, holidays: Date[]): boolean {
  const d = dayKeyUTCFromISO(iso);
  const dow = d.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return false;
  const key = dayISO(d);
  return !holidays.some((h) => dayISO(dayKeyUTCFromISO(h.toISOString().slice(0, 10))) === key);
}

/** Whole-day count from `fromISO` to `toISO` (`to − from`), UTC day keys. */
export function daysBetweenISO(fromISO: string, toISO: string): number {
  const ms = dayKeyUTCFromISO(toISO).getTime() - dayKeyUTCFromISO(fromISO).getTime();
  return Math.round(ms / 86_400_000);
}

/** The Pacific calendar day (`YYYY-MM-DD`) of an ISO instant string. */
export function instantToPacificDayISO(instantISO: string): string {
  return pacificDayISO(new Date(instantISO));
}

/** |a − b| > tolerance, treating either null as 0 only when the other is present. */
export function exceedsTolerance(a: number | null, b: number | null, tol: number): boolean {
  const av = a ?? 0;
  const bv = b ?? 0;
  return Math.abs(av - bv) > tol;
}

/** True when both operands are present (non-null) — a value comparison is meaningful. */
export function bothPresent(a: number | null | undefined, b: number | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined;
}

export interface FindingSpec {
  kind: FindingKind;
  keys: readonly (string | number | null | undefined)[];
  legARef?: string | null;
  legBRef?: string | null;
  expected?: JsonValue | null;
  actual?: JsonValue | null;
  detail?: JsonValue | null;
  severity?: Severity;
}

/**
 * Curried Finding factory: binds the check + window + config once, then each
 * call fills in the discrepancy specifics and derives the fingerprint. Severity
 * defaults to the check's configured severity unless a spec overrides it.
 */
export function makeFinder(
  checkCode: CheckCode,
  window: AuditWindow,
  config: CheckConfig,
): (spec: FindingSpec) => Finding {
  return (spec) => ({
    checkCode,
    siteId: window.siteId,
    windowStartISO: window.startISO,
    windowEndISO: window.endISO,
    severity: spec.severity ?? config.severity,
    kind: spec.kind,
    legARef: spec.legARef ?? null,
    legBRef: spec.legBRef ?? null,
    expected: spec.expected ?? null,
    actual: spec.actual ?? null,
    detail: spec.detail ?? null,
    fingerprint: makeFingerprint(checkCode, spec.kind, spec.keys),
  });
}
