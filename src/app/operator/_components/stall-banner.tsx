'use client';

// Shown when a floor action has been pending far longer than any healthy one (see
// `use-watched-transition.ts`). The one escape from a stalled request is a reload;
// without this the operator sees a disabled button and no way forward. Queued
// writes live in IndexedDB and survive the reload.

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/provider';
import { STALL_EVENT } from '@/lib/floor/use-watched-transition';

export function StallBanner() {
  const t = useT();
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const on = (e: Event): void => {
      setStalled((e as CustomEvent<{ stalled: boolean }>).detail?.stalled === true);
    };
    window.addEventListener(STALL_EVENT, on);
    return () => window.removeEventListener(STALL_EVENT, on);
  }, []);
  if (!stalled) return null;
  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex items-center justify-between gap-4 bg-amber-500 px-6 py-3 text-black"
    >
      <span className="text-base font-medium">{t('stall.message')}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-lg bg-black px-5 py-3 text-base font-semibold text-white"
      >
        {t('stall.reload')}
      </button>
    </div>
  );
}
