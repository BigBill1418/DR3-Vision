'use client';

import { useState, useTransition } from 'react';
import { doorOpenCapturedAction } from '../../actions';
import { PhotoInput } from './photo-input';

// Stage 3 — forced door-open photo. Per ADR-0012 §1, the visible
// timer starts on submission of THIS photo (not BOL). The server
// stamps `unload_started_at` and computes
// `time_to_unload_start_seconds` (silent SLA metric).

export function StageDoor({ siteCode, loadId }: { siteCode: string; loadId: string }) {
  const [hasFile, setHasFile] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-2xl font-bold">3. Door open</h2>
        <p className="text-sm text-dr3-cream/70">
          Photo the open trailer. Your unload timer starts now.
        </p>
      </header>
      <PhotoInput label="Capture door-open" onCaptured={() => setHasFile(true)} />
      <button
        type="button"
        disabled={!hasFile || isPending}
        onClick={() =>
          startTransition(async () => {
            await doorOpenCapturedAction(siteCode, loadId);
          })
        }
        className="rounded-lg bg-dr3-chartreuse px-6 py-4 text-lg font-semibold text-dr3-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? 'Starting timer…' : 'Start unload →'}
      </button>
    </section>
  );
}
