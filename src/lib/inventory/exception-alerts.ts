// ADR-0143 D5 + Bill B4 (2026-10-29) — how a negative-pool exception reaches Bill.
//
//   onset   one `high` page on `dr3-vision-system`, click → the exception page
//   7 days  one more `high` page if it is still open, naming the age
//   open    one line in a once-a-day `default` digest while it stays open
//
// Nothing else. Site managers are never pushed (CLAUDE.md hard rule 5): they see
// the exception in-app, born pilot. This REPLACES the old daily
// `INV-POOL-NON-NEGATIVE` page for a negative that has an exception — that page had
// no action and was ignored for weeks (ADR-0143 RC4, ADR-0037 gate q1).
//
// Delivered ≠ sent (the DR 0114/0126/0129 class): a page is STAMPED only when it
// landed (`sent` / `fallback-sent`) or another process already claimed it
// (`cooldown-suppressed`). `dropped` / `unconfigured` leave the stamp empty, so the
// next sweep (≤ 10 min, `/api/internal/inventory/pool-check`) tries again.
//
// ADR-0037 grade (plan §7): q1 actionable in 5 min — approve or reject the proposed
// adjustment on the page; q2 MRC program reporting; q3 no self-heal, a person
// decides the split; q4 one open exception per site + pool; q5 tier-1 record URL.

import { publishNtfy, type PublishNtfyArgs, type PublishNtfyResult } from '@/lib/ntfy';
import { prisma } from '@/lib/prisma';
import { dayISO, pacificDayISO } from '@/lib/time';
import { negativeFloorCopy } from './negative-floor';

export const TOPIC = 'dr3-vision-system';
export const REPAGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Belt and braces behind the DB stamp: one onset page per exception, ever. */
export const ONSET_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
/** One digest per Pacific day. */
export const DIGEST_COOLDOWN_MS = 20 * 60 * 60 * 1000;

export type Publisher = (args: PublishNtfyArgs) => Promise<PublishNtfyResult>;

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}

export function exceptionUrl(siteCode: string, id: string): string {
  return `${baseUrl()}/dashboard/${siteCode}/inventory-exceptions/${id}`;
}

/** ADR-0093 header contract: the title is pure ASCII. */
function ascii(s: string): string {
  return s.replace(/[−–—]/g, '-').replace(/[^\x20-\x7e]/g, '');
}

function poolLabel(pool: string): string {
  return pool === 'program' ? 'program' : 'non-program';
}

const landed = (r: PublishNtfyResult) =>
  r.outcome === 'sent' || r.outcome === 'fallback-sent' || r.outcome === 'cooldown-suppressed';

interface OpenRow {
  id: string;
  pool: string;
  first_negative_day: Date;
  opened_at: Date;
  opened_by_writer: string;
  shortfall: { toString(): string };
  onset_paged_at: Date | null;
  repaged_at: Date | null;
  site: { code: string; name: string };
}

/** Pure: the onset page for one exception. */
export function onsetPage(e: OpenRow): PublishNtfyArgs {
  const pool = poolLabel(e.pool);
  // The exception is a pool going negative; whether the total is still positive is
  // read on the page. The cause wording is the ONE remedy (negative-floor.ts).
  const copy = negativeFloorCopy({
    kind: 'pool-split',
    pool: e.pool === 'program' ? 'program' : 'non-program',
  });
  return {
    topic: TOPIC,
    title: ascii(
      `${e.site.name} ${pool} inventory went negative (-${e.shortfall.toString()}) - written by ${e.opened_by_writer}`,
    ),
    body:
      `${e.site.name} ${pool} pool first closed below zero on ${dayISO(e.first_negative_day)} ` +
      `(Pacific day), written by ${e.opened_by_writer}. Deepest shortfall ${e.shortfall.toString()} units.\n` +
      `${copy.remedy}\n` +
      `Open the exception to see the day and the leg, and to approve or reject the proposed adjustment.`,
    priority: 'high',
    tags: ['warning', 'inventory', 'dr3'],
    clickUrl: exceptionUrl(e.site.code, e.id),
    fingerprint: `inventory-exception:${e.id}`,
    cooldownMs: ONSET_COOLDOWN_MS,
  };
}

/** Pure: the single 7-day re-page. */
export function repage(e: OpenRow, now: Date): PublishNtfyArgs {
  const days = Math.floor((now.getTime() - e.opened_at.getTime()) / 86_400_000);
  return {
    topic: TOPIC,
    title: ascii(
      `${e.site.name} ${poolLabel(e.pool)} inventory exception still open after ${days} days`,
    ),
    body:
      `Opened ${dayISO(e.opened_at)} (first negative day ${dayISO(e.first_negative_day)}), shortfall ` +
      `${e.shortfall.toString()} units, still unresolved. This is the only reminder page; it stays a ` +
      `line in the daily digest until it is resolved.`,
    priority: 'high',
    tags: ['warning', 'inventory', 'dr3'],
    clickUrl: exceptionUrl(e.site.code, e.id),
    fingerprint: `inventory-exception:${e.id}:7d`,
    cooldownMs: ONSET_COOLDOWN_MS,
  };
}

export interface SweepOutcome {
  onset: string[];
  repaged: string[];
  failed: string[];
}

/**
 * Page every open exception that is due. Called by the 10-minute pool-check sweep,
 * so an onset page goes out within one sync tick of the write that opened it.
 */
export async function sweepInventoryExceptionPages(
  opts: { now?: Date; publish?: Publisher } = {},
): Promise<SweepOutcome> {
  const now = opts.now ?? new Date();
  const publish = opts.publish ?? publishNtfy;
  const open = (await prisma.inventoryException.findMany({
    where: { status: 'open' },
    select: {
      id: true,
      pool: true,
      first_negative_day: true,
      opened_at: true,
      opened_by_writer: true,
      shortfall: true,
      onset_paged_at: true,
      repaged_at: true,
      site: { select: { code: true, name: true } },
    },
    orderBy: { opened_at: 'asc' },
  })) as OpenRow[];

  const out: SweepOutcome = { onset: [], repaged: [], failed: [] };
  for (const e of open) {
    if (e.onset_paged_at == null) {
      const r = await publish(onsetPage(e));
      if (landed(r)) {
        await prisma.inventoryException.updateMany({
          where: { id: e.id, onset_paged_at: null },
          data: { onset_paged_at: now },
        });
        out.onset.push(e.id);
      } else {
        out.failed.push(e.id);
      }
      continue; // never onset + re-page in one sweep
    }
    if (e.repaged_at == null && now.getTime() - e.opened_at.getTime() >= REPAGE_AFTER_MS) {
      const r = await publish(repage(e, now));
      if (landed(r)) {
        await prisma.inventoryException.updateMany({
          where: { id: e.id, repaged_at: null },
          data: { repaged_at: now },
        });
        out.repaged.push(e.id);
      } else {
        out.failed.push(e.id);
      }
    }
  }
  return out;
}

/** Pure: the digest body, one line per open exception. */
export function digestLines(open: readonly OpenRow[], now: Date): string[] {
  return open.map((e) => {
    const days = Math.floor((now.getTime() - e.opened_at.getTime()) / 86_400_000);
    return (
      `${e.site.code} ${poolLabel(e.pool)}: open ${days}d, first negative ${dayISO(e.first_negative_day)}, ` +
      `shortfall ${e.shortfall.toString()} - ${exceptionUrl(e.site.code, e.id)}`
    );
  });
}

/**
 * The once-a-day `default` digest line while an exception stays open. Sent from the
 * daily invariants run; its fingerprint carries the Pacific day, so it is at most
 * one message a day however often the caller runs.
 */
export async function publishOpenExceptionsDigest(
  opts: { now?: Date; publish?: Publisher } = {},
): Promise<{ published: boolean; lines: number }> {
  const now = opts.now ?? new Date();
  const publish = opts.publish ?? publishNtfy;
  const open = (await prisma.inventoryException.findMany({
    where: { status: 'open' },
    select: {
      id: true,
      pool: true,
      first_negative_day: true,
      opened_at: true,
      opened_by_writer: true,
      shortfall: true,
      onset_paged_at: true,
      repaged_at: true,
      site: { select: { code: true, name: true } },
    },
    orderBy: { opened_at: 'asc' },
  })) as OpenRow[];
  if (open.length === 0) return { published: false, lines: 0 };
  const lines = digestLines(open, now);
  await publish({
    topic: TOPIC,
    title: `inventory exceptions: ${open.length} open`,
    body: lines.join('\n'),
    priority: 'default',
    tags: ['inventory', 'dr3'],
    clickUrl: exceptionUrl(open[0]!.site.code, open[0]!.id),
    fingerprint: `inventory-exceptions-digest:${pacificDayISO(now)}`,
    cooldownMs: DIGEST_COOLDOWN_MS,
  });
  return { published: true, lines: lines.length };
}
