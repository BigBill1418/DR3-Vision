// ADR-0044 D3 / ADR-0079 D3 — the small "equipment" tile for the site dashboard.
//
// Two numbers only: the LAST equipment event (so downtime/cost stops evaporating
// into a side spreadsheet — it's visible the moment the office logs it) and the
// 7-day units/day mean (the throughput pulse). Both site-scoped (hard rule #2).
// Cheap by construction — one `findFirst` + one small `findMany` — because it
// renders on the site dashboard for every manager on every load.
//
// ADR-0079 D3 — the 7-day mean now reads the MANAGER-ENTERED machine throughput,
// not `stripped_program + stripped_non_program`. The old number was the whole
// floor's output (1,000–1,250 units/day at Woodland) displayed as one machine's.
// Days nobody entered are SKIPPED, not counted as zero, and a window with no
// entries at all yields `null` — which the tile renders "not recorded", the same
// discipline ADR-0077 D4 established for downtime.
//
// Keeping the daily capture in its OWN table (ADR-0079 D2) is what makes the
// `lastEvent` query below still correct: a daily row written every working day
// would otherwise have become "the LAST equipment event" forever and buried the
// downtime this tile exists to surface.

import { type EquipmentEventKind } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appTodayISO, dayISO, dayKeyUTCFromISO } from '@/lib/time';
import { enteredThroughputByDay } from './daily-throughput';

export interface EquipmentTileData {
  lastEvent: {
    dateISO: string;
    kind: EquipmentEventKind;
    hoursDown: string | null;
    costCents: number | null;
    notes: string | null;
  } | null;
  /**
   * Mean of the machine's ENTERED units/day over the trailing 7 calendar days,
   * across RECORDED days only. `null` = nothing recorded in the window ("not
   * recorded"), never 0 and never the floor-wide derived total.
   *
   * ADR-0079 Amendment 1 deliberately did NOT widen this to include legacy days.
   * Amendment 1 restored the pre-cutover HISTORY to the chart, where each day is
   * individually labeled as floor-wide. A single averaged number has nowhere to
   * carry that label: "7-day units/day: 1,063" on a tile is a bare claim about
   * the machine, and it would be wrong by roughly 5×. The trend chart is where
   * the legacy era is shown, because that is where it can be shown honestly.
   */
  last7UnitsPerDay: number | null;
  /** Recorded days behind the mean — 0 ⇒ the mean is null because nobody entered. */
  recordedDays: number;
  windowEndISO: string;
}

export async function computeEquipmentTile(
  siteId: string,
  opts: { nowISO?: string; equipmentCode?: string } = {},
): Promise<EquipmentTileData> {
  const endISO = opts.nowISO ?? appTodayISO();
  const endKey = dayKeyUTCFromISO(endISO);
  const startKey = new Date(endKey.getTime() - 6 * 86_400_000); // trailing 7 days inclusive

  const [last, entered] = await Promise.all([
    prisma.equipmentEvent.findFirst({
      where: {
        site_id: siteId,
        voided_at: null,
        ...(opts.equipmentCode ? { equipment_code: opts.equipmentCode } : {}),
      },
      orderBy: [{ event_date: 'desc' }, { created_at: 'desc' }],
      select: { event_date: true, kind: true, hours_down: true, cost_cents: true, notes: true },
    }),
    enteredThroughputByDay(siteId, startKey, endKey),
  ]);

  const recorded = [...entered.values()];
  const last7UnitsPerDay =
    recorded.length === 0
      ? null
      : recorded.reduce((s, e) => s + e.unitsProcessed, 0) / recorded.length;

  return {
    lastEvent: last
      ? {
          dateISO: dayISO(last.event_date),
          kind: last.kind,
          hoursDown: last.hours_down?.toString() ?? null,
          costCents: last.cost_cents,
          notes: last.notes,
        }
      : null,
    last7UnitsPerDay,
    recordedDays: recorded.length,
    windowEndISO: endISO,
  };
}
