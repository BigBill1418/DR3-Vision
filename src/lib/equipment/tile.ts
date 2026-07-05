// ADR-0044 D3 — the small "equipment" tile for the site dashboard.
//
// Two numbers only: the LAST equipment event (so downtime/cost stops evaporating
// into a side spreadsheet — it's visible the moment the office logs it) and the
// 7-day units/day mean (the throughput pulse). Both site-scoped (hard rule #2).
// Cheap by construction — one `findFirst` + one small `findMany` — because it
// renders on the site dashboard for every manager on every load.

import { Prisma, type EquipmentEventKind } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appTodayISO, dayISO, dayKeyUTCFromISO } from '@/lib/time';

export interface EquipmentTileData {
  lastEvent: {
    dateISO: string;
    kind: EquipmentEventKind;
    hoursDown: string | null;
    costCents: number | null;
    notes: string | null;
  } | null;
  /** Mean units/day over the trailing 7 calendar days (non-null closes only). */
  last7UnitsPerDay: number | null;
  windowEndISO: string;
}

function num(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : v.toNumber();
}

export async function computeEquipmentTile(
  siteId: string,
  opts: { nowISO?: string; equipmentCode?: string } = {},
): Promise<EquipmentTileData> {
  const endISO = opts.nowISO ?? appTodayISO();
  const endKey = dayKeyUTCFromISO(endISO);
  const startKey = new Date(endKey.getTime() - 6 * 86_400_000); // trailing 7 days inclusive

  const [last, closes] = await Promise.all([
    prisma.equipmentEvent.findFirst({
      where: {
        site_id: siteId,
        voided_at: null,
        ...(opts.equipmentCode ? { equipment_code: opts.equipmentCode } : {}),
      },
      orderBy: [{ event_date: 'desc' }, { created_at: 'desc' }],
      select: { event_date: true, kind: true, hours_down: true, cost_cents: true, notes: true },
    }),
    prisma.processedUnitsDaily.findMany({
      where: { site_id: siteId, production_date: { gte: startKey, lte: endKey } },
      select: { stripped_program: true, stripped_non_program: true },
    }),
  ]);

  const last7UnitsPerDay =
    closes.length === 0
      ? null
      : closes.reduce((s, c) => s + num(c.stripped_program) + num(c.stripped_non_program), 0) / closes.length;

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
    windowEndISO: endISO,
  };
}
