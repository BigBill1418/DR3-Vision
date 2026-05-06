'use client';

import type { PhotoKind } from '@prisma/client';
import { useRef, useState } from 'react';
import { enqueueUpload, isOfflineError, type UploadKind } from '@/lib/offline-queue';
import { useT, useLocale } from '@/i18n/provider';

// Touch-first camera input + R2 upload (T-007), now with offline-queue
// fallback (T-009 / ADR-0006). Sequence:
//   1. operator taps the button → file picker / rear camera
//   2. POST /api/photos/upload-url for a presigned URL + storage_key
//   3. PUT the file bytes directly to R2 (or skip if R2 not yet
//      provisioned — `upload_url` is null and we proceed with the
//      placeholder storage_key for backward compat)
//   4. POST /api/photos/confirm to write the LoadPhoto row
//   5. fire `onCaptured(file)` so the parent stage enables Continue
//
// On network failure at ANY of steps 2/3/4 we enqueue the file blob in
// IndexedDB (per CLAUDE.md hard rule #9 — no localStorage) and STILL
// fire `onCaptured` so the operator's workflow advances. The
// `LoadPhoto` row is missing on the server until `replayAll()` runs to
// completion; the manager-portal load detail surfaces this as a
// pending-r2 photo until then. Acceptable per ADR-0006: "Photos are
// uploaded when the queue replays; the user's submission is 'complete'
// from their perspective even before the photo finishes uploading."
//
// Hard 4xx (auth expired, load reassigned, etc.) is NOT a network
// failure — those errors keep the operator on the current stage with
// the error message visible, because the queue cannot resolve them.
//
// CLAUDE.md hard rules respected:
//   #7  photos go to R2, never local disk or DB (queue is transient,
//       blob is removed on successful R2 PUT during replay)
//   #9  IndexedDB only — no localStorage / sessionStorage
//   #10 onClick handlers, no native <form>

// `labelKey` is the suffix portion of `photo.label_<labelKey>` in the
// operator dictionary. This lets the parent stage stay locale-blind —
// it picks the right translation by giving us the canonical kind name.
type LabelKey = 'bol' | 'weight_ticket' | 'door_open' | 'rejection' | 'concern';

type Props = {
  loadId: string;
  kind: PhotoKind;
  labelKey: LabelKey;
  onCaptured: (file: File) => void;
};

type Status = 'idle' | 'uploading' | 'done' | 'queued' | 'error';

export function PhotoInput({ loadId, kind, labelKey, onCaptured }: Props) {
  const t = useT();
  const locale = useLocale();
  const ref = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const label = t(`photo.label_${labelKey}`);

  const queueAndAdvance = async (
    file: File,
    storage_key: string | null,
    upload_url: string | null,
  ) => {
    await enqueueUpload({
      load_id: loadId,
      kind: kind as UploadKind,
      blob: file,
      content_type: file.type || 'application/octet-stream',
      storage_key,
      upload_url,
    });
    setStatus('queued');
    onCaptured(file);
  };

  const handleFile = async (file: File) => {
    setStatus('uploading');
    setError(null);
    setName(file.name);

    let storage_key: string | null = null;
    let upload_url: string | null = null;

    // Step 2: mint presigned URL.
    try {
      const mintRes = await fetch('/api/photos/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          load_id: loadId,
          kind,
          content_type: file.type || 'application/octet-stream',
        }),
      });
      if (!mintRes.ok) throw new Error(`mint failed (${mintRes.status})`);
      const minted = (await mintRes.json()) as {
        storage_key: string;
        upload_url: string | null;
      };
      storage_key = minted.storage_key;
      upload_url = minted.upload_url;
    } catch (e) {
      if (isOfflineError(e)) {
        await queueAndAdvance(file, null, null);
        return;
      }
      setStatus('error');
      setError(e instanceof Error ? e.message : 'upload failed');
      return;
    }

    // Step 3: PUT to R2.
    if (upload_url) {
      try {
        const putRes = await fetch(upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!putRes.ok) throw new Error(`R2 PUT failed (${putRes.status})`);
      } catch (e) {
        if (isOfflineError(e)) {
          await queueAndAdvance(file, storage_key, upload_url);
          return;
        }
        setStatus('error');
        setError(e instanceof Error ? e.message : 'upload failed');
        return;
      }
    }

    // Step 4: confirm — write the LoadPhoto row.
    try {
      const confirmRes = await fetch('/api/photos/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          load_id: loadId,
          kind,
          storage_key,
          byte_size: file.size,
        }),
      });
      if (!confirmRes.ok) throw new Error(`confirm failed (${confirmRes.status})`);
    } catch (e) {
      if (isOfflineError(e)) {
        // R2 PUT already succeeded — queue only the confirm step.
        // We re-use enqueueUpload with the existing storage_key; on
        // replay the queue notices the URL is stale and re-mints, but
        // the bytes have to be re-PUT to the new key. That's a minor
        // bandwidth waste, accepted because partial-progress tracking
        // would balloon the queue schema for a vanishingly rare case
        // (network drops between R2 PUT response and Next.js confirm).
        await queueAndAdvance(file, null, null);
        return;
      }
      setStatus('error');
      setError(e instanceof Error ? e.message : 'upload failed');
      return;
    }

    setStatus('done');
    onCaptured(file);
  };

  const buttonText = (() => {
    if (status === 'uploading') return t('photo.uploading', { label });
    if (status === 'done') return t('photo.captured', { label });
    if (status === 'queued') return t('photo.queued', { label });
    if (status === 'error') return t('photo.retry', { label });
    return t('photo.default', { label });
  })();

  return (
    <div className="flex flex-col items-center gap-3" lang={locale}>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          // Reset the input so re-selecting the same file re-fires onChange
          // (browsers suppress the event when value is unchanged).
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={status === 'uploading'}
        className="w-full rounded-lg bg-dr3-green px-6 py-8 text-xl font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {buttonText}
      </button>
      {name && status !== 'error' && <p className="text-xs text-dr3-cream/60">{name}</p>}
      {status === 'queued' && (
        <p className="text-xs text-dr3-chartreuse/80">{t('photo.queued_caption')}</p>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
    </div>
  );
}
