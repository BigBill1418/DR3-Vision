// ADR-0037 delivery for the invariant suite.
//
// ## The volume controls, per ADR-0131 D6
//
//  - **Tier B never pages.** An `implausibility` is thresholded and arguable; D1
//    puts it on a dashboard and in a digest line, which is what ADR-0037 means by
//    "below default is not a notification". This is absolute and is asserted in
//    `notify.test.ts` — it does not depend on the invariant's `severity`.
//  - **One page per refusal per 24 h**, fingerprint `invariant:<id>`, claimed
//    through `publishNtfy` against the durable ADR-0130 `alert_cooldowns` ledger.
//    A cron child that restarts mid-window therefore cannot re-fire, which is the
//    whole reason that ledger exists. A week of breakage is at most seven pages
//    for one invariant, never seven per invariant per day.
//  - **Silence when green.** No all-clear digest: D6's expected steady-state
//    volume is zero.
//
// ## Two deliberate deviations from D6, both narrower than it
//
//  1. **Fingerprint is `invariant:<id>`, not `invariant:<id>:<site>`.** Per-site is
//     right for a site-scoped invariant and wrong for `INV-ROLLOUT-SURFACE-SEEDED`,
//     whose subjects are 28 surfaces — that one would emit 28 pages from a single
//     unseeded registry. One page per invariant carrying every subject in its body
//     is the same information at 1/28th the volume.
//  2. **Not transition-only (PASS -> FAIL) yet.** D6's largest volume control needs
//     durable knowledge of the PREVIOUS run's verdict, and this pass is read-only
//     against production by instruction, so there is nowhere to record it. The 24 h
//     cooldown bounds a persistent failure to one page per day rather than to one
//     page ever. Closing this needs the `invariant_state` table D5 already
//     specifies; it is the first thing to build on top of this.
//     2026-09-25: the DIGEST (Tier B + indeterminate) now gets most of that
//     benefit without the table - its fingerprint hashes which invariants and
//     subjects it names (`digestFingerprint`), so a changed finding publishes at
//     once and an unchanged one repeats at most weekly (DIGEST_COOLDOWN_MS).
//
// ## Why the all-green deadman was dropped
//
// An earlier draft published a digest every run, green or not, on the reasoning
// that a suite which only speaks on failure is silenced by its own death. D7
// dissolves that: the suite rides the EXISTING `dr3-vision-audit-sweep` container,
// whose liveness is already someone else's problem and already monitored. A
// separate daily all-clear would be a second heartbeat for the same process.
//
// ## Why ntfy at all, given CLAUDE.md hard rule #5
//
// Rule #5 reserves push for SYSTEM-level events and sends operational events
// (rejections, long unloads, SLA breaches, PIN lockouts) to in-app surfaces. Its
// examples are all per-event floor activity. The subject here is different in
// kind: "the production data no longer satisfies what the code assumes about it"
// is a statement about the software's own correctness, not about a load. It goes
// to `dr3-vision-system`, the designated topic, and reaches Bill alone, which is
// the recipient constraint rule #5 actually imposes. Flagged rather than assumed
// — if Bill reads that rule the other way, the fix is to route this body into the
// daily report instead, and nothing else in the suite changes.

import { publishNtfy } from '@/lib/ntfy';
import type { InvariantReport, InvariantRunResult } from './types';

const TOPIC = 'dr3-vision-system';

/**
 * How often an UNCHANGED digest may repeat. 2026-09-25: the digest re-sent the
 * identical two Woodland hauls (H-138391 / H-139774, INV-INBOUND-PLAUSIBLE) every
 * morning at 02:30 from 09-20 on - a finding that is waiting on MRC (OPEN-ITEMS
 * BS-1), that nobody can act on in five minutes, and whose seventh copy says
 * nothing the first did not. ADR-0037 gate 1 fails from the second copy on.
 *
 * The fingerprint now carries a hash of WHAT was found (see `digestFingerprint`),
 * so a NEW or CHANGED finding still publishes at the very next run - the digest
 * lost no sensitivity - while the same finding repeats at most weekly, which is
 * the reminder that stops a known-open item from being forgotten.
 */
export const DIGEST_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** ADR-0131 D6 — a refusal-tier page, and the blindness alarm, get a full day each. */
export const PAGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The publish surface, injected so the suite is testable without a network. */
export type Publisher = typeof publishNtfy;

export interface NotifyOutcome {
  /** Fingerprints this call attempted to publish, in order. */
  published: string[];
}

function line(r: InvariantRunResult): string {
  const head = `${r.id} [${r.adr}] ${r.status.toUpperCase()}`;
  if (r.status === 'indeterminate') return `${head}: ${r.note ?? 'no reason recorded'}`;
  if (r.violations.length === 0) return head;
  return [head, ...r.violations.map((v) => `  - ${v.subject}: ${v.detail}`)].join('\n');
}

/**
 * ADR-0131 D6 — which results may page.
 *
 * Tier is checked, not severity, and that ordering is the point: an
 * `implausibility` can carry any severity its author thought appropriate and still
 * must never page. Reading `severity` first would make the prohibition depend on
 * every future author remembering it.
 */
export function pageable(r: InvariantRunResult): boolean {
  return r.tier === 'refusal' && r.status === 'violated';
}

/**
 * Build the digest body. Violations first, then anything indeterminate, then a
 * one-line tally of what passed.
 *
 * Ordering is the whole design: `publishNtfy` truncates at 1024 bytes, so
 * whatever is last is what gets lost. The findings must never be the part that
 * falls off the end.
 */
export function buildDigestBody(report: InvariantReport): string {
  const violated = report.results.filter((r) => r.status === 'violated');
  const unknown = report.results.filter((r) => r.status === 'indeterminate');
  const ok = report.results.filter((r) => r.status === 'ok');

  const parts: string[] = [];
  if (violated.length > 0) parts.push(violated.map(line).join('\n'));
  if (unknown.length > 0) parts.push(`COULD NOT CHECK:\n${unknown.map(line).join('\n')}`);
  parts.push(
    `${ok.length} ok / ${violated.length} violated / ${unknown.length} unchecked` +
      ` in ${report.durationMs}ms${ok.length > 0 ? ` (ok: ${ok.map((r) => r.id).join(' ')})` : ''}`,
  );
  return parts.join('\n\n');
}

/**
 * The digest's identity: which invariants are in it, in which state, about which
 * subjects. Deliberately NOT the violation `detail` text - details carry live
 * figures (an on-hand count, a percentage) that move every day, and keying on
 * them would make an unchanged finding look new each morning, which is the exact
 * repetition this exists to stop. The subject (a site, a haul id) is what makes a
 * finding a different finding.
 */
export function digestFingerprint(results: readonly InvariantRunResult[]): string {
  const keys = results
    .map((r) =>
      r.status === 'indeterminate'
        ? `${r.id}|indeterminate`
        : `${r.id}|${r.status}|${r.violations
            .map((v) => v.subject)
            .sort()
            .join(',')}`,
    )
    .sort();
  return `dr3-invariants-digest:${fnv1a64(keys.join('\n'))}`;
}

/**
 * FNV-1a, 64-bit, as 16 hex chars. Not a security hash and does not need to be:
 * it only has to make two different digests land on different cooldown keys.
 * Written out rather than `node:crypto` because this directory's read-only guard
 * (`readonly.guard.test.ts`) bans the `.update(` token outright, and a hash
 * object's `.update()` is indistinguishable from a Prisma write to that scan.
 */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Publish the report. Never throws — `publishNtfy` already swallows transport
 * failure, and a notifier that can take down its own caller would turn a
 * diagnostic into an outage.
 */
export async function notifyInvariantReport(
  report: InvariantReport,
  publish: Publisher = publishNtfy,
): Promise<NotifyOutcome> {
  const published: string[] = [];

  // 1. Blindness first. It is the only condition here that pages, because a suite
  //    that checked nothing reports the same silence as a suite that found nothing
  //    — and every other signal in this function is worthless while it is true.
  if (report.blind) {
    const fp = 'dr3-invariants-blind';
    published.push(fp);
    await publish({
      topic: TOPIC,
      title: 'data-invariant suite is BLIND - every check failed to run',
      body:
        `All ${report.results.length} invariants returned indeterminate. Nothing about production ` +
        `data was actually verified this run.\n\n` +
        report.results.map(line).join('\n'),
      priority: 'high',
      tags: ['warning', 'invariants', 'dr3-vision'],
      fingerprint: fp,
      cooldownMs: PAGE_COOLDOWN_MS,
    });
  }

  // 2. Refusal-tier violations. One fingerprint each, so two different findings
  //    never suppress one another, and the remedy travels with the page — a page
  //    that says what broke but not what to do is a page that gets deferred.
  for (const r of report.results) {
    if (!pageable(r)) continue;
    const fp = `invariant:${r.id}`;
    published.push(fp);
    await publish({
      topic: TOPIC,
      title: `${r.id} violated - ${r.title}`,
      body: `${line(r)}\n\nREMEDY: ${r.remedy}\nPinned assumption (${r.adr}): ${r.assumption}`,
      priority: r.severity === 'urgent' ? 'urgent' : r.severity === 'high' ? 'high' : 'default',
      tags: ['warning', 'invariants', 'dr3-vision'],
      fingerprint: fp,
      cooldownMs: PAGE_COOLDOWN_MS,
    });
  }

  // 3. The digest, for everything that must NOT page: Tier B implausibilities and
  //    anything indeterminate. Skipped entirely when there is nothing to say —
  //    D6's expected steady-state volume is zero and a daily all-clear would be a
  //    second heartbeat for a container that already has one.
  const digestWorthy = report.results.filter(
    (r) => (r.status === 'violated' && r.tier === 'implausibility') || r.status === 'indeterminate',
  );
  if (digestWorthy.length > 0) {
    const fp = digestFingerprint(digestWorthy);
    published.push(fp);
    await publish({
      topic: TOPIC,
      title: `data invariants: ${report.counts.violated} violated, ${report.counts.indeterminate} unchecked`,
      body: buildDigestBody(report),
      priority: 'default',
      tags: ['invariants', 'dr3-vision'],
      fingerprint: fp,
      cooldownMs: DIGEST_COOLDOWN_MS,
    });
  }

  return { published };
}
