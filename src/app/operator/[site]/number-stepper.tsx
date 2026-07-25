'use client';

// ADR-0060 — big-target number entry for the floor surfaces. Operators work outdoors,
// often gloved, without a hardware keyboard: −10/−1/+1/+10 buttons (each ≥56px) around a
// large tabular value, plus a numeric input for direct entry. No hover-only or drag
// interactions. Clamped to [min, max].

type Props = {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
};

export function NumberStepper({ label, value, onChange, min = 0, max = 100000 }: Props) {
  const clamp = (n: number): number => Math.max(min, Math.min(max, Math.round(n)));
  const set = (n: number): void => onChange(clamp(Number.isFinite(n) ? n : min));

  const Btn = ({ delta, children }: { delta: number; children: React.ReactNode }) => (
    <button
      type="button"
      aria-label={`${label} ${delta > 0 ? '+' : ''}${delta}`}
      onClick={() => set(value + delta)}
      className="min-h-[56px] min-w-[56px] flex-1 rounded-lg bg-dr3-green-deep text-2xl font-bold text-dr3-cream ring-1 ring-dr3-green active:bg-dr3-green-dark"
    >
      {children}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-base font-semibold text-dr3-cream/90">{label}</label>
      <div className="flex items-center gap-2">
        <Btn delta={-10}>−10</Btn>
        <Btn delta={-1}>−1</Btn>
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={String(value)}
          onChange={(e) => set(Number(e.target.value))}
          className="min-h-[56px] w-24 rounded-lg bg-dr3-cream px-3 text-center text-3xl font-bold tabular-nums text-dr3-ink"
        />
        <Btn delta={1}>+1</Btn>
        <Btn delta={10}>+10</Btn>
      </div>
    </div>
  );
}
