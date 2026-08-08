// ADR-0072 — the tiered anchor-overwrite guardrail.
//
// ── What is being protected ─────────────────────────────────────────────────
// A physical count becomes the new inventory ANCHOR. Every downstream number —
// the floor balance, the COR filing, the loads/inventory screens — is computed
// forward from it. So a mistyped count does not produce a wrong count; it
// silently moves the entire floor. Woodland's anchor is a known-good 2,483
// established 2026-07-22, and a fat-fingered digit on an iPad would replace it
// with no friction and no trace beyond a snapshot row nobody looks at.
//
// Bill's decision (2026-07-30) was NOT a blanket authorisation gate — he trusts
// the crew to re-anchor. It is a TIERED one: nothing in the way of a first
// count, a confirm step on a modest change, and a manager on a large one.
//
// ── The tiers ───────────────────────────────────────────────────────────────
//   Tier 0 — no existing anchor. Writes straight through, zero friction. This
//            is every Eugene count today and any site's first count.
//   Tier 1 — an overwrite with a swing at or under the threshold. The operator
//            confirms against a current-vs-new comparison.
//   Tier 2 — an overwrite with a swing OVER the threshold. Held. The operator
//            cannot release it; a manager must, by PIN on the device or from
//            their own screen.
//
// ── Why the swing is relative, and why the threshold is a setting ───────────
// 20% of Woodland's 2,483 is ~500 units; 40% would have let ~1,000 through on a
// tap, which is why Bill tightened it. A relative measure keeps that proportion
// right as the floor grows or shrinks — an absolute unit threshold would be
// paranoid at 3,000 and useless at 300.
//
// ── This module decides; it does not trust ──────────────────────────────────
// `classifyAnchorWrite` is called by the WRITE PATH, not by the UI. The client
// computes the same tier only to decide what to show. A hand-crafted request
// that skips the confirm dialog still meets this function on the server, and a
// Tier 2 write without a real approval is refused there. The UI is a courtesy;
// this is the control.

import type { Prisma, PrismaClient } from '@prisma/client';
import { NOT_VOIDED } from './snapshot-void';

type Db = PrismaClient | Prisma.TransactionClient;

/** Seeded default. The live value comes from `inventory_anchor_config`. */
export const DEFAULT_SWING_THRESHOLD_PCT = 20;

export type AnchorTier = 0 | 1 | 2;

export interface PriorAnchor {
  id: string;
  total: number;
  programUnits: number | null;
  nonProgramUnits: number | null;
  snapshotAt: Date;
}

export interface AnchorClassification {
  tier: AnchorTier;
  isOverwrite: boolean;
  prior: PriorAnchor | null;
  newTotal: number;
  /** Signed change, new − prior. Null when there is no prior anchor. */
  delta: number | null;
  /** Absolute swing as a percentage of the prior total. Null on Tier 0. */
  swingPct: number | null;
  thresholdPct: number;
  /** True when a manager approval is REQUIRED for this write to proceed. */
  requiresManagerApproval: boolean;
}

/**
 * The most recent PHYSICAL snapshot for a site — the anchor a new count would
 * replace.
 *
 * `physical` only: a `computed` snapshot is a system-derived marker, not an
 * operator's count, and treating one as the prior anchor would measure the swing
 * against the wrong baseline.
 */
export async function loadPriorAnchor(db: Db, siteId: string): Promise<PriorAnchor | null> {
  const row = await db.siteInventorySnapshot.findFirst({
    // ADR-0084 — voided counts are not anchors. This clause must stay eligible
    // for exactly the same rows as `onHand`'s (see the ordering note below): a
    // guardrail that can still see a voided anchor while the balance cannot
    // would measure the swing against a count the floor is no longer built on.
    where: { ...NOT_VOIDED, site_id: siteId, snapshot_kind: 'physical' },
    // ADR-0078 D1 — `snapshot_at` alone does not order these rows.
    //
    // The floor count route stores every count at Pacific MIDNIGHT of the day it
    // was taken (ADR-0060 D-3), so two counts on the same day are byte-identical
    // in this column. `ORDER BY snapshot_at DESC` then leaves the winner to the
    // planner, and the winner is the number the whole inventory is computed
    // forward from. `created_at DESC` breaks the tie on the recorded insertion
    // instant, so the count ENTERED LAST wins — deterministically, and matching
    // what an operator re-entering a count plainly means.
    //
    // This ordering must stay identical to `onHand`'s in running-balance.ts. Two
    // selectors disagreeing about which row is the anchor is the same defect
    // wearing a second hat: the guardrail would measure the swing against one
    // count while the balance computed forward from the other. ADR-0084 extends
    // the invariant to the WHERE clause above — same eligible rows, same order,
    // or the two selectors can still name different anchors.
    orderBy: [{ snapshot_at: 'desc' }, { created_at: 'desc' }],
    select: {
      id: true,
      snapshot_at: true,
      units_indoor: true,
      units_total: true,
      units_in_processing: true,
      program_units: true,
      non_program_units: true,
    },
  });
  if (!row) return null;
  // Mirrors `snapshotTotalUnits`: jurisdiction decides which of indoor/total is
  // populated, and in-processing is always additive.
  const base = row.units_total ?? row.units_indoor ?? 0;
  return {
    id: row.id,
    total: base + (row.units_in_processing ?? 0),
    programUnits: row.program_units === null ? null : Number(row.program_units),
    nonProgramUnits: row.non_program_units === null ? null : Number(row.non_program_units),
    snapshotAt: row.snapshot_at,
  };
}

/**
 * Classify a proposed anchor write.
 *
 * `prior === null` is Tier 0 — genuinely no anchor exists, so there is nothing to
 * overwrite and nothing to compare against. It is NOT a fallback for "we could
 * not read the prior anchor": a read failure must throw before reaching here,
 * because silently classifying an unreadable state as friction-free is exactly
 * the shape of defect this codebase keeps having to correct.
 */
export function classifyAnchorWrite(args: {
  prior: PriorAnchor | null;
  newTotal: number;
  thresholdPct?: number;
}): AnchorClassification {
  const thresholdPct = args.thresholdPct ?? DEFAULT_SWING_THRESHOLD_PCT;
  const prior = args.prior;

  if (!prior) {
    return {
      tier: 0,
      isOverwrite: false,
      prior: null,
      newTotal: args.newTotal,
      delta: null,
      swingPct: null,
      thresholdPct,
      requiresManagerApproval: false,
    };
  }

  const delta = args.newTotal - prior.total;

  // A prior anchor of zero has no meaningful percentage: every non-zero count is
  // an infinite swing, and every guardrail would fire forever on a site that once
  // counted empty. Treat a zero baseline as Tier 1 — there IS a prior anchor, so
  // it is an overwrite and deserves the confirm, but it can never be Tier 2 on
  // arithmetic nobody can reason about.
  if (prior.total === 0) {
    return {
      tier: 1,
      isOverwrite: true,
      prior,
      newTotal: args.newTotal,
      delta,
      swingPct: null,
      thresholdPct,
      requiresManagerApproval: false,
    };
  }

  const swingPct = (Math.abs(delta) / prior.total) * 100;
  // Strictly greater than: a swing of exactly the threshold is Tier 1. The
  // threshold is the largest swing an operator may confirm alone.
  const tier: AnchorTier = swingPct > thresholdPct ? 2 : 1;

  return {
    tier,
    isOverwrite: true,
    prior,
    newTotal: args.newTotal,
    delta,
    swingPct,
    thresholdPct,
    requiresManagerApproval: tier === 2,
  };
}

/** The site's configured threshold, or the seeded default when unset. */
export async function loadSwingThresholdPct(db: Db, siteId: string): Promise<number> {
  const cfg = await db.inventoryAnchorConfig.findUnique({
    where: { site_id: siteId },
    select: { swing_threshold_pct: true },
  });
  return cfg ? Number(cfg.swing_threshold_pct) : DEFAULT_SWING_THRESHOLD_PCT;
}

/**
 * The delta in words, for the confirm dialog and the hold notification.
 *
 * Spelled out rather than shown as two numbers because the failure this guards
 * against is someone reading "2,483 → 2,150" as fine at a glance. "a decrease of
 * 333 (13%)" is the sentence that makes a wrong number look wrong.
 */
export function describeSwing(c: AnchorClassification): string {
  if (!c.prior) return `Establishes the first anchor at ${c.newTotal.toLocaleString()} units.`;
  const dir = (c.delta ?? 0) < 0 ? 'decrease' : 'increase';
  const mag = Math.abs(c.delta ?? 0).toLocaleString();
  const pct = c.swingPct === null ? null : `${c.swingPct.toFixed(0)}%`;
  return (
    `This replaces ${c.prior.total.toLocaleString()} with ${c.newTotal.toLocaleString()} — ` +
    `${dir === 'decrease' ? 'a decrease' : 'an increase'} of ${mag}${pct ? ` (${pct})` : ''}.`
  );
}
