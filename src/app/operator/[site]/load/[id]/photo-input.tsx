'use client';

import { useRef, useState } from 'react';

// Touch-first camera input. Per CLAUDE.md hard rule #10 there's no
// <form> — `capture="environment"` tells iPad Safari to invoke the
// rear camera directly. The actual file is not yet uploaded; T-007
// wires R2. For T-006 the parent only needs to know "a photo was
// captured" so it can advance the stage.

type Props = {
  label: string;
  onCaptured: (file: File) => void;
};

export function PhotoInput({ label, onCaptured }: Props) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-center gap-3">
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            setName(f.name);
            onCaptured(f);
          }
        }}
      />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="w-full rounded-lg bg-dr3-green px-6 py-8 text-xl font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark"
      >
        {name ? `✓ ${label} captured` : `📸 ${label}`}
      </button>
      {name && <p className="text-xs text-dr3-cream/60">{name}</p>}
    </div>
  );
}
