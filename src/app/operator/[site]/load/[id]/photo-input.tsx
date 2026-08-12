'use client';

import type { PhotoKind } from '@prisma/client';
import { useRef, useState } from 'react';
import {
  enqueueUpload,
  isOfflineError,
  newIdempotencyKey,
  type UploadKind,
} from '@/lib/offline-queue';
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

type Status = 'idle' | 'uploading' | 'done' | 'queued' | 'signed_out' | 'error';

/**
 * The session ended — not a network failure, and not a refusal a retry can
 * clear (2026-08-10).
 *
 * `/api/photos/*` answers **401** for a request carrying no identity, including
 * the husk Auth.js leaves after the five-minute operator idle window. iOS
 * suspends the page while the camera sheet is up, so a capture that involves
 * walking anywhere — the first-ever load rejection at Woodland did — routinely
 * outlives that window and comes back to a dead session.
 *
 * This is the classification the DRAIN path has had since ADR-0078 G7
 * (`isAuthResponse` in `offline-queue.ts`); the live path never learned it and
 * painted "Retry {{label}}" instead, which is an invitation to tap a button
 * that cannot work. 403 is deliberately NOT here, for the same reason it is not
 * there: a 403 is authenticated-but-refused (cross-site, wrong role) and a
 * sign-in does not fix it.
 */
function isSignedOut(res: Response): boolean {
  return res.status === 401;
}

/**
 * Audit D-17 — a raw English technical string on a trilingual iPad.
 *
 * The three `setError` sites in this file all did:
 *
 *     setError(e instanceof Error ? e.message : 'upload failed');
 *
 * which renders the literals thrown a few lines above — `mint failed (403)`,
 * `R2 PUT failed (500)` — straight at an operator, bypassing i18n entirely on a
 * floor that runs en/es/ur. It also compounds D-16: `onCaptured` never fires, so
 * the parent's Continue stays disabled with nothing connecting the two, under a
 * button reading "Retry BOL photo".
 *
 * 403 is the one worth special-casing, exactly as 401 already is at `isSignedOut`
 * above. A 403 on a mint is authenticated-but-refused, and on a SHARED iPad that
 * is almost always a load belonging to a different operator's login — so "Retry"
 * forever is the wrong instruction, and signing in again is not the fix either.
 * `conflicts-client.tsx` has had the right sentence for this since ADR-0086 Am.1
 * (`why_other_operator`); the live path never learned it. Same words, one
 * `photo.` key, because a floor operator should not read two different
 * explanations of one condition depending on which screen found it.
 */
function photoErrorCopy(e: unknown): string {
  return e instanceof Error && /\b403\b/.test(e.message)
    ? 'photo.other_operator'
    : 'photo.error_upload';
}

export function PhotoInput({ loadId, kind, labelKey, onCaptured }: Props) {
  const t = useT();
  const locale = useLocale();
  const ref = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const label = t(`photo.label_${labelKey}`);

  const handleFile = async (file: File) => {
    setStatus('uploading');
    setError(null);
    setName(file.name);

    // ADR-0078 / ADR-0086 — minted ONCE, here, at the operator's tap. It names
    // this photo across the live attempt and every later replay, and ADR-0086
    // binds it INTO the grant, which is what makes the grant single-use: the
    // confirm it authorises must present this same key.
    //
    // Follows the `dropoff-client.tsx` precedent exactly. A key minted per
    // attempt would make every retry a new write, which is the defect the whole
    // mechanism exists to close.
    const idempotencyKey = newIdempotencyKey();

    let storage_key: string | null = null;
    let upload_url: string | null = null;
    // ADR-0086 — the capture-time grant. Issued by the mint below WHILE THIS
    // SESSION PROVABLY EXISTS, and carried on the queued row so the photo can
    // drain later with no session at all. Stays null when the deployment has no
    // `PHOTO_GRANT_SECRET`, in which case everything here behaves exactly as it
    // did before this feature — the queue just needs a signed-in operator to
    // drain, which is the status quo, not a regression.
    let upload_grant: string | null = null;

    const queueAndAdvance = async (
      queuedStorageKey: string | null,
      queuedUploadUrl: string | null,
    ) => {
      await enqueueUpload({
        load_id: loadId,
        kind: kind as UploadKind,
        blob: file,
        content_type: file.type || 'application/octet-stream',
        storage_key: queuedStorageKey,
        upload_url: queuedUploadUrl,
        idempotency_key: idempotencyKey,
        upload_grant,
      });
      setStatus('queued');
      onCaptured(file);
    };

    // The session ended mid-capture. Keep the bytes, and stop.
    //
    // KEEP: this blob exists in exactly one place on earth. Discarding it is
    // how the 2026-08-10 reject ended with a load stranded at `unload_started`
    // and no rejection evidence. Queued, the drain engine's immediate sweep
    // (`subscribeToEnqueue`) marks the row `auth:session_expired` within a
    // second and the floor chrome's badge starts saying "Sign in to send 1
    // item" — the recovery ADR-0078 G8c already built.
    //
    // STOP: unlike the offline path this does NOT call `onCaptured`. Arming
    // Continue/Submit would hand the operator a Server Action sitting behind
    // the same expired session, whose throw reaches the browser REDACTED in
    // production (see `use-claim-loss-guard.ts`) — buying one honest failure a
    // second, unreadable one. One instruction, once: sign in.
    const queueForSignIn = async () => {
      await enqueueUpload({
        load_id: loadId,
        kind: kind as UploadKind,
        blob: file,
        content_type: file.type || 'application/octet-stream',
        storage_key: null,
        upload_url: null,
        idempotency_key: idempotencyKey,
        upload_grant,
      });
      setStatus('signed_out');
    };

    // Step 2: mint presigned URL.
    try {
      const mintRes = await fetch('/api/photos/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          load_id: loadId,
          kind,
          content_type: file.type || 'application/octet-stream',
          idempotency_key: idempotencyKey,
        }),
      });
      if (isSignedOut(mintRes)) {
        await queueForSignIn();
        return;
      }
      if (!mintRes.ok) throw new Error(`mint failed (${mintRes.status})`);
      const minted = (await mintRes.json()) as {
        storage_key: string;
        upload_url: string | null;
        upload_grant?: string | null;
      };
      storage_key = minted.storage_key;
      upload_url = minted.upload_url;
      upload_grant = minted.upload_grant ?? null;
    } catch (e) {
      if (isOfflineError(e)) {
        await queueAndAdvance(null, null);
        return;
      }
      setStatus('error');
      setError(t(photoErrorCopy(e)));
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
          await queueAndAdvance(storage_key, upload_url);
          return;
        }
        setStatus('error');
        setError(t(photoErrorCopy(e)));
        return;
      }
    }

    // Step 4: confirm — write the LoadPhoto row.
    try {
      const confirmRes = await fetch('/api/photos/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ADR-0078 D3 — the LIVE confirm now carries the key too, not just the
          // replay. Without it, a confirm that landed and lost its response was
          // queued under a key the server had never seen, and the replay wrote a
          // SECOND `load_photos` row — the exact duplicate-confirm defect D3
          // closed, still open on the one path that hands work to the queue.
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          load_id: loadId,
          kind,
          storage_key,
          byte_size: file.size,
        }),
      });
      // Same treatment as the mint. The bytes reached R2 but no `load_photos`
      // row exists, so the photo is not evidence yet — queue it and let the
      // replay re-PUT to a fresh key, which is exactly what the offline branch
      // below already does for this step.
      if (isSignedOut(confirmRes)) {
        await queueForSignIn();
        return;
      }
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
        await queueAndAdvance(null, null);
        return;
      }
      setStatus('error');
      setError(t(photoErrorCopy(e)));
      return;
    }

    setStatus('done');
    onCaptured(file);
  };

  const buttonText = (() => {
    if (status === 'uploading') return t('photo.uploading', { label });
    if (status === 'done') return t('photo.captured', { label });
    if (status === 'queued') return t('photo.queued', { label });
    if (status === 'signed_out') return t('photo.signed_out', { label });
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
      {status === 'signed_out' && (
        <p className="text-sm text-dr3-chartreuse">{t('photo.signed_out_caption')}</p>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
    </div>
  );
}
