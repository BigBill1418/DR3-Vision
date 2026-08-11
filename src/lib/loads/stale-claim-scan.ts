// ADR-0092 — the once-a-day pass that says out loud what the badge has been
// showing all afternoon.
//
// Structurally this is ADR-0088's watchdog with a different question, and the
// resemblance is deliberate rather than accidental: per-site loop, a pilot gate,
// a DATABASE-keyed one-alert-per-fact ledger, `notifyStaff()` on its own
// born-pilot surface, and ntfy reserved for the single case of the nudge itself
// failing to arrive. Copying that shape means the two watchdogs fail the same
// way, which is worth more than either being individually clever.
//
// ## Why this is a staff nudge and not a page
//
// CLAUDE.md hard rule #5 names the answer directly: ntfy goes to Bill ONLY, for
// system-level events, and "long unloads, SLA breaches" are given as examples of
// the operational class that stays in-app. A load somebody claimed and walked
// away from is that class exactly — it is a fact about people and process, and
// the person who can act on it is the site manager standing fifty feet from the
// dock, not Bill on a phone.
//
// ADR-0037's rubric reaches the same place from the other direction: "below
// default = dashboard, not notification." So the PRIMARY surface for this is the
// in-app staleness badge (`stale-claim.ts` + the ops overview), which costs
// nobody an interruption and is always current. This scan is the BACKSTOP for
// the case the badge cannot cover — nobody looked at the dashboard today.
//
// ## Why one pass, at 16:45 PT
//
// It is the last moment the information is still cheap to act on: the operator
// who holds the load is still on site, and the load has not yet spent a night
// open. The measurement says that is the boundary that matters — of 58
// operator-claimed loads that reached `submitted`, the 52 healthy ones were all
// submitted on the SAME Pacific day they were claimed, and every one of the 6
// that crossed a day boundary took 2–4 days to come back. Nothing legitimate
// sleeps overnight, so catching it before the night is the whole job.
//
// It also sits clear of the other two staff-mail ticks — 08:30 PT
// (throughput-gap) and 18:00 PT (the alert digest) — so no two staff mails
// arrive as a pair and get skimmed as one.

import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { notifyStaff } from '@/lib/notify/notify-staff';
import { NOTIFY_SURFACE, UI_SURFACE, isUiSurfaceLive } from '@/lib/notify/rollout';
import { publishNtfy } from '@/lib/ntfy';
import { STALE_NUDGE_MS } from '@/lib/loads/stale-claim';
import { listOpenClaimsWithStaleness } from '@/lib/loads/stale-claim-query';

/**
 * Hours, not minutes. A stale claim is a slow-moving condition — the same three
 * loads are still stale five minutes later — so re-reporting a delivery failure
 * at the publisher's 5-minute default is how a topic gets muted. Matches
 * ADR-0088's `GAP_NOTIFY_FAIL_COOLDOWN_MS` and alert-digest's, deliberately.
 */
export const STALE_NOTIFY_FAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface StaleClaimRow {
  loadId: string;
  haulNumber: string | null;
  sourceName: string | null;
  holderName: string | null;
  status: string;
  idleMs: number;
}

export type StaleClaimStatus =
  | 'alerted'
  | 'failed'
  | 'disabled'
  | 'skipped_none'
  | 'skipped_site_pilot'
  | 'skipped_no_recipients'
  | 'error';

export interface StaleClaimOutcome {
  siteCode: string;
  status: StaleClaimStatus;
  staleCount?: number;
  delivered?: number;
  attempted?: number;
  error?: string;
}

export interface StaleClaimScanSummary {
  scannedAtISO: string;
  outcomes: StaleClaimOutcome[];
}

/** Whole hours, floored, with a `<1h` floor case the copy can print literally. */
function humanIdle(idleMs: number): string {
  const hours = Math.floor(idleMs / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours === 1) return '1 hour';
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The digest body. One table, one row per stranded load, each row linking to the
 * LOAD — tier-1 under ADR-0036, because a per-record URL exists and a link to a
 * list would make the reader hunt.
 *
 * Deliberately prints no unit count. A stranded load is uncounted by definition
 * (`total_units` is NULL until finish), and rendering that as "0 units" would
 * state a measurement where there is an absence — the ADR-0077 D4 distinction
 * this codebase is careful about everywhere else.
 */
export function renderStaleClaimHtml(
  site: { code: string; name: string },
  rows: readonly StaleClaimRow[],
): string {
  const base = process.env['APP_BASE_URL'] ?? 'https://dr3-vision.svdp.us';
  const items = rows
    .map((r) => {
      const label =
        [r.haulNumber, r.sourceName]
          .filter((v): v is string => !!v)
          .map(esc)
          .join(' · ') || 'Load';
      const who = r.holderName ? esc(r.holderName) : 'an operator';
      return `<tr>
  <td style="padding:8px 12px;border-bottom:1px solid #ddd;">
    <a href="${base}/operator/${esc(site.code)}/load/${esc(r.loadId)}">${label}</a>
  </td>
  <td style="padding:8px 12px;border-bottom:1px solid #ddd;">${who}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #ddd;">${esc(r.status)}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #ddd;">${esc(humanIdle(r.idleMs))}</td>
</tr>`;
    })
    .join('\n');

  return `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#111;">
<p>${rows.length === 1 ? 'One load at' : `${rows.length} loads at`} <strong>${esc(site.name)}</strong> ${rows.length === 1 ? 'is' : 'are'} still open on the dock and ${rows.length === 1 ? 'has' : 'have'} had no activity for hours.</p>
<table style="border-collapse:collapse;margin:16px 0;">
<thead><tr>
  <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111;">Load</th>
  <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111;">Held by</th>
  <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111;">Stage</th>
  <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111;">Quiet for</th>
</tr></thead>
<tbody>
${items}
</tbody>
</table>
<p>Anyone on the floor can pick one of these up — open it and use <strong>Take over</strong>. Nothing is lost by taking a load over; whatever was counted stays counted.</p>
<p style="color:#555;font-size:13px;">This is a once-a-day check sent before the end of shift, so these can be closed tonight rather than found tomorrow. It reports each load once.</p>
</div>`;
}

/**
 * One pass over every site.
 *
 * Per-site `try/catch`: one site failing must never silence the other, which is
 * `alert-digest.ts`'s discipline and the reason Eugene cannot take Woodland down.
 */
export async function runStaleClaimScan(
  now: Date = new Date(),
  db: PrismaClient = prisma,
): Promise<StaleClaimScanSummary> {
  const sites = await db.site.findMany({ select: { id: true, code: true, name: true } });
  const outcomes: StaleClaimOutcome[] = [];

  for (const site of sites) {
    try {
      // Pilot gate. `ipad_queue` gates the dock workflow itself; where it is
      // pilot the site has no real operator claims, so every "stranded" load
      // would be a test artefact. Nudging a manager about those is a bug wearing
      // an email — the same reasoning as ADR-0088's `equipment_entry` gate.
      if (!(await isUiSurfaceLive(UI_SURFACE.IPAD_QUEUE, site.id, db))) {
        outcomes.push({ siteCode: site.code, status: 'skipped_site_pilot' });
        continue;
      }

      // ONE query, shared with the dashboard badge (`stale-claim-query.ts`), so
      // the thing this mail reports and the thing a manager sees on screen can
      // never be two different lists. `nudge` is the top band; the dashboard
      // also renders `badge`, which deliberately never mails anyone.
      const stale = (await listOpenClaimsWithStaleness(site.id, now, db))
        .filter((c) => c.level === 'nudge')
        .map<StaleClaimRow>((c) => ({
          loadId: c.loadId,
          haulNumber: c.haulNumber,
          sourceName: c.sourceName,
          holderName: c.holderName,
          status: c.status,
          idleMs: c.idleMs,
        }));

      if (stale.length === 0) {
        outcomes.push({ siteCode: site.code, status: 'skipped_none', staleCount: 0 });
        continue;
      }

      // Idempotency, read BEFORE anything costly. One nudge per LOAD, ever —
      // keyed on the fact being reported rather than on wall time, so a restart,
      // a re-fire, or a second cron container cannot double-send. Strictly
      // stronger than ADR-0037's cooldown floor, and it is the reason this scan
      // is safe to `curl` by hand.
      const known = new Set(
        (
          await db.staleClaimAlert.findMany({
            where: { load_id: { in: stale.map((s) => s.loadId) } },
            select: { load_id: true },
          })
        ).map((r) => r.load_id),
      );
      const fresh = stale.filter((s) => !known.has(s.loadId));

      if (fresh.length === 0) {
        outcomes.push({ siteCode: site.code, status: 'skipped_none', staleCount: 0 });
        continue;
      }

      // The established per-site roster — the site managers, who are the people
      // who can walk over and ask. A second roster table for one nudge would be
      // a second thing to keep current and a second thing to get wrong. Under
      // pilot this roster is ignored and the mail goes to admins with the
      // would-have-sent header, so Bill sees the targeting before anyone else.
      const roster = (
        await db.alertRecipient.findMany({
          where: { site_id: site.id, active: true },
          select: { email: true },
        })
      ).map((r) => r.email);

      const notified = await notifyStaff({
        surfaceCode: NOTIFY_SURFACE.LOAD_STALE_CLAIM,
        site: { id: site.id, code: site.code },
        recipients: roster,
        subject: `DR3-Vision — ${site.name}: ${fresh.length} load${fresh.length === 1 ? '' : 's'} still open on the dock`,
        htmlBody: renderStaleClaimHtml(site, fresh),
        // ADR-0037 `default`. NOT `high`: this fails the 5-minute-actionable and
        // customer-visible tests, and flagging a floor-hygiene mail as
        // high-importance is how a reader learns to filter the sender.
        importance: 'normal',
        fromDisplayName: 'DR3-Vision Alerts',
        db,
      });

      // M365 unconfigured → fail-open no-op. No ledger row, so the nudge is
      // still OWED once the operator closes the config gap.
      if (notified.disabled) {
        log.warn({ siteCode: site.code }, '[stale-claim] M365 disabled — nudge not sent');
        outcomes.push({ siteCode: site.code, status: 'disabled', staleCount: fresh.length });
        continue;
      }

      // Nobody to send to — a config gap the operator fixes, not a delivery
      // failure. No ledger row, for the same reason.
      if (notified.actualRecipients.length === 0) {
        outcomes.push({
          siteCode: site.code,
          status: 'skipped_no_recipients',
          staleCount: fresh.length,
        });
        continue;
      }

      const attempted = notified.actualRecipients.length;
      const delivered = notified.delivered;
      const lastStatus =
        notified.sends
          .map((s) => s.lastStatus)
          .filter((v): v is number => v !== undefined)
          .pop() ?? null;

      // Written even on a delivery FAILURE: the send decision was real, and
      // re-reporting the same loads tomorrow would be the nagging this design
      // exists to avoid. The failure itself is what pages, below.
      await db.staleClaimAlert.createMany({
        data: fresh.map((s) => ({
          load_id: s.loadId,
          site_id: site.id,
          holder_name: s.holderName,
          load_status: s.status,
          idle_minutes: Math.round(s.idleMs / 60_000),
          notify_mode: notified.mode,
          recipient_count: attempted,
          delivered_count: delivered,
          last_status: lastStatus,
        })),
        skipDuplicates: true,
      });

      log.info(
        {
          siteCode: site.code,
          staleCount: fresh.length,
          mode: notified.mode,
          attempted,
          delivered,
        },
        '[stale-claim] nudge processed',
      );

      if (delivered === 0) {
        // The nudge failing to ARRIVE is a system event — the alert channel
        // itself is broken — which is the one carve-out hard rule #5 allows.
        // Same existing topic as alert-digest and throughput-gap: a new topic
        // nobody is subscribed to is a silent black hole.
        await publishNtfy({
          topic: 'dr3-vision-system',
          title: `Stale-claim nudge delivery failed for ${site.code}`,
          body: `0/${attempted} recipients received the stale-claim nudge covering ${fresh.length} open load(s) (${notified.mode} mode; last status ${lastStatus ?? 'network'}). Those loads are still open and nobody has been told.`,
          priority: 'high',
          tags: ['error', 'stale-claim', 'dr3-vision'],
          fingerprint: `stale-claim-failed:${site.code}`,
          cooldownMs: STALE_NOTIFY_FAIL_COOLDOWN_MS,
        });
        outcomes.push({
          siteCode: site.code,
          status: 'failed',
          staleCount: fresh.length,
          delivered,
          attempted,
        });
      } else {
        outcomes.push({
          siteCode: site.code,
          status: 'alerted',
          staleCount: fresh.length,
          delivered,
          attempted,
        });
      }
    } catch (e) {
      // One site's failure never silences the other.
      const message = e instanceof Error ? e.message : String(e);
      log.error({ siteCode: site.code, err: message }, '[stale-claim] site scan failed');
      outcomes.push({ siteCode: site.code, status: 'error', error: message });
    }
  }

  return { scannedAtISO: now.toISOString(), outcomes };
}

/** Re-exported so callers get the threshold from one place. */
export { STALE_NUDGE_MS };
