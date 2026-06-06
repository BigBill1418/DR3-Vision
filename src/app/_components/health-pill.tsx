'use client';

// Vision Dashboard footer health pill (ADR-0020 / T-120). Shows overall status;
// click to expand per-subsystem detail. Polls /api/health/subsystems every 30s.
// Fail-safe: a failed poll keeps the last known state (never throws into the UI).

import { useCallback, useEffect, useState } from 'react';

type Status = 'green' | 'amber' | 'red';
interface Subsystem {
  key: string;
  label: string;
  status: Status;
  detail: string;
}

// ADR-0020 health colors.
const DOT: Record<Status, string> = {
  green: 'bg-[#97C459]',
  amber: 'bg-[#F0993E]',
  red: 'bg-[#E24B4A]',
};
const LABEL: Record<Status, string> = {
  green: 'All systems operational',
  amber: 'Some systems degraded',
  red: 'System issue detected',
};

export function HealthPill() {
  const [overall, setOverall] = useState<Status>('green');
  const [subs, setSubs] = useState<Subsystem[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/health/subsystems', { cache: 'no-store' });
      if (!r.ok) return;
      const d = (await r.json()) as { overall: Status; subsystems: Subsystem[] };
      setOverall(d.overall);
      setSubs(d.subsystems);
    } catch {
      // keep last known state
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-full bg-dr3-green-dark/60 px-3 py-1 text-xs font-medium text-dr3-cream/80 transition-colors hover:text-dr3-cream"
      >
        <span className={`h-2 w-2 rounded-full ${DOT[overall]}`} aria-hidden="true" />
        {LABEL[overall]}
        <span aria-hidden="true" className="text-dr3-cream/50">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-72 rounded-lg bg-dr3-cream p-3 text-dr3-ink shadow-xl">
          {subs ? (
            <ul className="flex flex-col gap-2">
              {subs.map((s) => (
                <li key={s.key} className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${DOT[s.status]}`} aria-hidden="true" />
                    {s.label}
                  </span>
                  <span className="text-dr3-ink/60">{s.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-dr3-ink/60">Checking subsystems…</p>
          )}
        </div>
      )}
    </div>
  );
}
