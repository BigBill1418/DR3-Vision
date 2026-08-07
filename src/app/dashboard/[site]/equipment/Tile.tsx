'use client';

// The stat tile shared by the throughput summary (ADR-0044 D3) and the machine
// metrics band (ADR-0081). Extracted from `EquipmentClient` when the band became
// its second caller — not before, and it carries no logic of its own.
//
// It renders STRINGS. Every "not recorded" vs "$0.00" vs "0.0" decision belongs
// to the caller that owns the number's meaning, because only that caller knows
// whether a null is a gap or a measured zero (ADR-0077 D4 / ADR-0079 D3). A tile
// that formatted nulls itself would make that call in one place for facts with
// three different provenances.

export function Tile({
  label,
  value,
  sub,
  note,
  accent,
}: {
  label: string;
  value: string;
  /** The denominator disclosure — e.g. "5 of 7 days recorded". */
  sub?: string;
  /** ADR-0081 D5 — the composition that rides a blended mean. */
  note?: string | null;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${accent ? 'border-dr3-cyan/50 bg-black/20' : 'border-white/15 bg-black/10'}`}
    >
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="mt-1 text-xs opacity-60">{sub}</div>}
      {note && <div className="mt-0.5 text-xs opacity-60">{note}</div>}
    </div>
  );
}
