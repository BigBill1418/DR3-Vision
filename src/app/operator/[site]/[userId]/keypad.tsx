'use client';

import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import { resolveFloorReturnPath } from '@/lib/floor-return-path';

// Touch-first numeric keypad. Per CLAUDE.md hard rule #10 there is no
// <form> — the Submit fires implicitly on the 4th digit, and the
// outer button-grid uses onClick handlers throughout. Auto-submit
// keeps gloved-hand interaction at the minimum number of taps.
//
// The keypad grid is forced `dir="ltr"` so that even under the
// page-level `<html dir="rtl">` (Urdu), the digit order stays
// 1-2-3 / 4-5-6 / 7-8-9. Numerals are universally LTR; flipping them
// would surprise the operator without benefit.

const PIN_LEN = 4;

type Props = {
  userId: string;
  siteCode: string; /** ADR-0078 G8c — post-PIN destination from the session-expired badge. */
  next?: string | undefined;
};

export function Keypad({ userId, siteCode, next }: Props) {
  const router = useRouter();
  const t = useT();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittedRef = useRef(false);

  const append = (d: string) => {
    if (busy || pin.length >= PIN_LEN) return;
    setError(null);
    setPin(pin + d);
  };

  const back = () => {
    if (busy) return;
    setError(null);
    setPin(pin.slice(0, -1));
  };

  useEffect(() => {
    if (pin.length !== PIN_LEN || submittedRef.current) return;
    submittedRef.current = true;
    setBusy(true);
    void signIn('pin', {
      user_id: userId,
      pin,
      redirect: false,
    })
      .then((res) => {
        if (res?.error) {
          setError(t('keypad.error_incorrect'));
          setPin('');
          setBusy(false);
          submittedRef.current = false;
          return;
        }
        // ADR-0060 — land on the daily-validation HUB (the shift landing). It links to
        // the per-load queue, which stays reachable there regardless of rollout state.
        //
        // ADR-0078 G8c — UNLESS the operator was sent here by the session-expired
        // badge, in which case they resume the screen they were on. Validated,
        // never trusted: `next` arrives in a URL, and an unchecked push target is
        // an open redirect.
        router.push(resolveFloorReturnPath(next, siteCode));
        router.refresh();
      })
      .catch(() => {
        setError(t('keypad.error_failed'));
        setPin('');
        setBusy(false);
        submittedRef.current = false;
      });
  }, [pin, userId, siteCode, next, router, t]);

  return (
    <div className="flex w-full flex-col items-center gap-6" dir="ltr">
      <div className="flex gap-3" aria-label={t('keypad.pin_progress_label')}>
        {Array.from({ length: PIN_LEN }).map((_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full border-2 ${
              i < pin.length ? 'border-dr3-green bg-dr3-green' : 'border-white/30 bg-transparent'
            }`}
          />
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="grid w-full grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <KeypadButton key={d} onClick={() => append(d)} disabled={busy}>
            {d}
          </KeypadButton>
        ))}
        <KeypadButton onClick={back} disabled={busy || pin.length === 0}>
          ⌫
        </KeypadButton>
        <KeypadButton onClick={() => append('0')} disabled={busy}>
          0
        </KeypadButton>
        <span className="rounded-lg" />
      </div>
    </div>
  );
}

function KeypadButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-20 items-center justify-center rounded-lg bg-white/5 text-3xl font-semibold text-white transition-colors hover:bg-white/15 active:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
