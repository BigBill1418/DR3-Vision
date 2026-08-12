'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { enqueueDropoff, isOfflineError, newIdempotencyKey } from '@/lib/offline-queue';
import {
  classifyWriteRefusal,
  WriteRefusalNotice,
  type WriteRefusal,
} from '../../_components/write-refusal';
import { NumberStepper } from '../number-stepper';

// ADR-0085 — the walk-up drop-off capture screen.
//
// Three steps on one screen, in JT's order: label → units → photo → send.
// Deliberately one screen rather than a wizard: this happens at the door with
// somebody standing there, and a three-tap flow that can be seen end-to-end is
// faster to complete and much harder to abandon half-done.
//
// ## What this component does NOT collect
//
// No name. No money. No check number. Not even for Incentive — its $3/unit is
// tracked elsewhere, by Bill's explicit call. There is no field here for any of
// it, which is the first of the three layers that keep it out of the row (the
// second is `createFloorDropoff`, whose signature has no such parameter; the
// third is the `consumer_dropoffs_floor_no_money_or_pii` CHECK constraint).
//
// ## The photo is required, and this is the WEAKEST of the guards
//
// `canSend` stays false until a photo is attached. That is a courtesy to the
// operator, not a control: it lives on the client, and the whole point of
// ADR-0078 is that a floor iPad may be running an old bundle for days. The
// controls are the zod schema on the route (422 `invalid_input`),
// `createFloorDropoff`'s `assertPhoto`, and the CHECK constraint. The
// `dropoff.photo-required` test strips THIS check specifically and proves the
// server still refuses.

type Props = {
  siteCode: string;
  /** Pacific day, rendered server-side. Never `new Date()` on the device. */
  dropoffDate: string;
};

type Kind = 'floor_public' | 'floor_incentive';
type Status = 'entry' | 'sending' | 'sent' | 'queued' | 'error';

export function DropoffClient({ siteCode, dropoffDate }: Props) {
  const t = useT();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [kind, setKind] = useState<Kind | null>(null);
  const [units, setUnits] = useState(1);
  const [photo, setPhoto] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('entry');
  const [error, setError] = useState<string | null>(null);
  /** Audit D-8 — a refusal no retap can clear; see `write-refusal.tsx`. */
  const [refusal, setRefusal] = useState<WriteRefusal | null>(null);

  const canSend = kind !== null && units > 0 && photo !== null && status !== 'sending';

  /**
   * Audit D-8 — `dropoffDate` is a server-rendered prop, so a soft refresh
   * re-points the screen at the current Pacific day. The label, units and photo
   * already selected survive it, because a walk-up drop-off is captured with a
   * person standing at the door and re-collecting it is not free.
   */
  function refreshToToday(): void {
    setRefusal(null);
    setError(null);
    setStatus('entry');
    router.refresh();
  }

  function reset(): void {
    setKind(null);
    setUnits(1);
    setPhoto(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function send(): Promise<void> {
    if (kind === null || photo === null) return;
    setStatus('sending');
    setError(null);
    setRefusal(null);

    // Minted ONCE per submit attempt and reused by the queued entry, so a request
    // that landed but lost its response replays to the SAME write rather than
    // creating a second drop-off. A key minted per attempt would make every retry
    // a new row — the exact defect this mechanism exists to close.
    const idempotencyKey = newIdempotencyKey();
    const contentType = photo.type || 'image/jpeg';

    const queueIt = async (
      storage_key: string | null,
      upload_url: string | null,
    ): Promise<void> => {
      await enqueueDropoff({
        site_code: siteCode,
        dropoff_date: dropoffDate,
        kind,
        units,
        blob: photo,
        content_type: contentType,
        storage_key,
        upload_url,
        idempotency_key: idempotencyKey,
      });
      setStatus('queued');
      reset();
    };

    let storageKey: string;
    let uploadUrl: string | null;

    // Step 1 — mint the presigned PUT.
    try {
      const mint = await fetch(`/api/operator/${siteCode}/dropoff/upload-url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content_type: contentType }),
      });
      // Audit D-8 — the session can end between opening this screen and the
      // person arriving at the door. A 401 here is not a network failure and not
      // a retry: `queueIt` is deliberately NOT called, because the drain runs
      // behind the same dead session and "saved on this iPad" over a row that
      // cannot send is the false confirmation ADR-0078 exists to prevent.
      if (mint.status === 401) {
        setStatus('error');
        setRefusal('signed_out');
        return;
      }
      if (!mint.ok) throw new Error(`mint ${mint.status}`);
      const minted = (await mint.json()) as { storage_key: string; upload_url: string | null };
      storageKey = minted.storage_key;
      uploadUrl = minted.upload_url;
    } catch (e) {
      // The blob and the units queue TOGETHER, in one row. A drop-off cannot
      // exist without its photo, so queueing half of it would leave the operator
      // told "saved" over a record that can never be completed.
      if (isOfflineError(e)) return void (await queueIt(null, null));
      setStatus('error');
      setError(t('floor.common.save_failed'));
      return;
    }

    // Step 2 — PUT the bytes straight to R2. `upload_url` is null only when R2 is
    // unconfigured (dev / the pre-provisioning window), in which case the
    // placeholder key stands in and the row still records the capture.
    if (uploadUrl) {
      try {
        const put = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: photo,
        });
        if (!put.ok) throw new Error(`put ${put.status}`);
      } catch (e) {
        if (isOfflineError(e)) return void (await queueIt(storageKey, uploadUrl));
        setStatus('error');
        setError(t('floor.common.save_failed'));
        return;
      }
    }

    // Step 3 — the drop-off itself.
    try {
      const res = await fetch(`/api/operator/${siteCode}/dropoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          dropoffDate,
          kind,
          units,
          photoStorageKey: storageKey,
          photoContentType: contentType,
          photoByteSize: photo.size,
        }),
      });
      if (!res.ok) {
        setStatus('error');
        // Audit D-8 — this branch never read the body at all, so NO refusal this
        // route can return was distinguishable from any other: `date_not_today`,
        // `invalid_input` and a 500 produced one identical sentence. Parsing it
        // is the precondition for classifying anything.
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        const refused = classifyWriteRefusal(res.status, b.error);
        if (refused) {
          setRefusal(refused);
          return;
        }
        setError(t('floor.common.save_failed'));
        return;
      }
      setStatus('sent');
      reset();
      router.refresh();
    } catch (e) {
      if (isOfflineError(e)) return void (await queueIt(null, null));
      setStatus('error');
      setError(t('floor.common.save_failed'));
    }
  }

  const kindBtn = (k: Kind): React.ReactElement => (
    <button
      key={k}
      type="button"
      aria-pressed={kind === k}
      onClick={() => setKind(k)}
      className={`min-h-[88px] flex-1 rounded-xl px-6 py-5 text-xl font-bold transition-colors ${
        kind === k
          ? 'bg-dr3-chartreuse text-dr3-ink'
          : 'bg-dr3-green text-dr3-ink hover:bg-dr3-green-dark hover:text-dr3-cream'
      }`}
    >
      {t(`floor.dropoff.kind_${k}`)}
    </button>
  );

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-dr3-cream/70">{t('floor.dropoff.intro')}</p>

      <div className="flex flex-col gap-2">
        <p className="text-base font-semibold text-dr3-cream/90">{t('floor.dropoff.kind_label')}</p>
        <div className="flex gap-3">
          {(['floor_public', 'floor_incentive'] as Kind[]).map(kindBtn)}
        </div>
      </div>

      <NumberStepper
        label={t('floor.dropoff.units_label')}
        value={units}
        onChange={setUnits}
        min={1}
      />

      <div className="flex flex-col gap-2">
        <p className="text-base font-semibold text-dr3-cream/90">
          {t('floor.dropoff.photo_label')}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setPhoto(f);
            if (status === 'error') {
              setStatus('entry');
              setError(null);
              // The refusal described the LAST attempt; a new photo starts
              // another one. Leaving it up would attach yesterday's reason to
              // today's tap.
              setRefusal(null);
            }
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="min-h-[88px] w-full rounded-xl bg-dr3-green px-6 py-5 text-xl font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark hover:text-dr3-cream"
        >
          {photo ? t('floor.dropoff.photo_taken') : t('floor.dropoff.photo_take')}
        </button>
        {!photo && <p className="text-sm text-amber-200">{t('floor.dropoff.photo_required')}</p>}
      </div>

      <button
        type="button"
        disabled={!canSend}
        onClick={() => void send()}
        data-testid="dropoff-send"
        className="min-h-[88px] w-full rounded-xl bg-dr3-chartreuse px-6 py-5 text-2xl font-bold text-dr3-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'sending' ? t('floor.common.saving') : t('floor.dropoff.send')}
      </button>

      {status === 'sent' && <p className="text-lg text-dr3-cyan">{t('floor.common.saved')}</p>}
      {/* Queued is NOT presented as success. The operator is told the drop-off is
          on the iPad and will send — the ADR-0078 rule that a confirmation only
          ever follows a server-acknowledged write. */}
      {status === 'queued' && (
        <p className="text-lg text-dr3-chartreuse">{t('floor.common.queued')}</p>
      )}
      {error && <p className="text-lg text-red-300">{error}</p>}
      {refusal && <WriteRefusalNotice
          refusal={refusal}
          onRefresh={refreshToToday}
          siteCode={siteCode}
          surface="dropoff"
        />}
    </div>
  );
}
