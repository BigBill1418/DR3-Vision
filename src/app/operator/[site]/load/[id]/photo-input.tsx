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
import { MAX_PHOTOS_PER_KIND, canAddPhoto } from '@/lib/loads/photo-limit';
import { useLiveControl, type StageDisableReason } from './stage-liveness';

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
  /**
   * ADR-0109 — photos of THIS kind the load already holds, from the server.
   *
   * Seeding matters and is not defensive padding. The BOL stage is gated by a
   * client latch (`bolDone` in `load-workflow.tsx`), so an operator who reloads
   * the page — or whose iPad reloads it for them — lands back on a stage whose
   * photos are already in the database. Starting the counter at 0 would offer
   * three more taps on a load that has room for none, and the server would
   * refuse the fourth. CONTRIBUTING.md's floor bar (ADR-0074 Am.1) forbids
   * exactly that: never ship a control the server will reject.
   */
  initialCount?: number;
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
  if (!(e instanceof Error)) return 'photo.error_upload';
  // ADR-0109 — the load is full. Distinct from both siblings below because it is
  // the only one where trying again is not merely useless but WRONG: nothing is
  // broken, the step simply holds all the pictures it holds. Checked first —
  // `photo.error_upload`'s "tap to try again" would be a lie here.
  if (/\b409\b/.test(e.message)) return 'photo.limit_reached';
  return /\b403\b/.test(e.message) ? 'photo.other_operator' : 'photo.error_upload';
}

export function PhotoInput({ loadId, kind, labelKey, onCaptured, initialCount = 0 }: Props) {
  const t = useT();
  const locale = useLocale();
  const ref = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ADR-0109 — photos of this kind that WILL exist on the server.
  //
  // Incremented for a queued or sign-in-parked capture as well as an uploaded
  // one, because all three are rows the load is going to hold: the blob is in
  // IndexedDB and `replayAll` will confirm it. Counting only completed uploads
  // would let an operator working offline queue three and then add three more,
  // and the surplus would be discovered as conflicts on a drain hours later —
  // the ADR-0078 failure shape of learning about a refusal long after the tap.
  const [count, setCount] = useState(initialCount);

  const label = t(`photo.label_${labelKey}`);
  const atLimit = !canAddPhoto(count);

  // ADR-0122 — the two controls this component owns, declared to the enclosing
  // stage so the detector counts them. HALF THE 2026-08-20 TRAP lived here: on a
  // re-entry with a photo already on the server, capture is withheld (correctly,
  // ADR-0109) and "add another" is not rendered (a fresh mount is `idle`), so the
  // stage's own Continue was the only thing left and it was disabled too.
  //
  // Each reason chain below is truth-equivalent to the `disabled` / render
  // condition it feeds, and the SAME value drives both — a second expression
  // restating the rule is how the registration would drift away from the DOM.
  const captureReason: StageDisableReason | null =
    status === 'uploading'
      ? 'uploading'
      : atLimit
        ? 'photo_limit'
        : count > 0 && status !== 'error'
          ? 'photo_present'
          : null;
  const addAnotherShown = (status === 'done' || status === 'queued') && !atLimit;
  useLiveControl('photo_capture', captureReason);
  useLiveControl(
    'photo_add_another',
    addAnotherShown ? null : atLimit ? 'photo_limit' : 'not_captured',
  );

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
      setCount((n) => n + 1);
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
      setCount((n) => n + 1);
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
      setError(t(photoErrorCopy(e), { max: String(MAX_PHOTOS_PER_KIND) }));
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
        setError(t(photoErrorCopy(e), { max: String(MAX_PHOTOS_PER_KIND) }));
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
      // ADR-0109 — the server says this step is full, and the client thought
      // otherwise. Trust the server and RESYNC the counter from its `held`
      // rather than merely showing the message: a stale count that stays stale
      // re-offers the control on the next render, and the operator taps into the
      // same refusal again. This is reachable whenever another device drained a
      // queued photo for the same load — ordinary since ADR-0078 Am.1 made the
      // photo gate site-scoped rather than owner-scoped.
      if (confirmRes.status === 409) {
        const held = await confirmRes
          .clone()
          .json()
          .then((b: { error?: unknown; held?: unknown }) =>
            b.error === 'photo_limit_reached' && typeof b.held === 'number' ? b.held : null,
          )
          .catch(() => null);
        if (held !== null) setCount(held);
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
      setError(t(photoErrorCopy(e), { max: String(MAX_PHOTOS_PER_KIND) }));
      return;
    }

    setCount((n) => n + 1);
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
          // ADR-0109 — the last gate before a byte moves. The two controls above
          // are already withdrawn at the limit; this catches the path neither of
          // them owns, which is a camera sheet opened just before the count
          // reached the ceiling and returned from afterwards. iOS suspends the
          // page for the whole time the sheet is up, so that interval is real.
          if (f && !atLimit) void handleFile(f);
          // Reset the input so re-selecting the same file re-fires onChange
          // (browsers suppress the event when value is unchanged).
          e.target.value = '';
        }}
      />
      <button
        type="button"
        data-testid="photo-capture"
        onClick={() => ref.current?.click()}
        // ADR-0109 — this button takes the REQUIRED photo and retries a failed
        // one. Nothing else. Once a photo exists and the last attempt did not
        // fail, extras come from the quiet control below, so the screen never
        // carries two identical-looking ways to do the same thing — and it is
        // disabled rather than hidden so the captured state stays legible.
        disabled={status === 'uploading' || atLimit || (count > 0 && status !== 'error')}
        className="w-full rounded-lg bg-dr3-green px-6 py-8 text-xl font-semibold text-dr3-ink transition-colors hover:bg-dr3-green-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {buttonText}
      </button>
      {/* ADR-0109 — the "add another photo" affordance. GENERIC and unnamed on
          purpose (handoff #264 Item 1): no slot labels, no second-photo/third-
          photo language, because the floor's extra photo is whatever the
          operator needed a picture of — damage, contamination, a placard — and
          naming the slots would ask them to classify it before they can take
          it.

          WITHDRAWN at the limit rather than disabled-with-an-explanation: a tap
          target that exists only to say no is the shape ADR-0074 Am.1 rules out
          on floor surfaces. The caption below states the count either way, so
          the control disappearing is explained rather than mysterious.

          OFFERED ONLY from `done` and `queued`, and the exclusions are the
          interesting part:

            - `signed_out` — the session ended and the photo is parked waiting
              for a PIN. The existing contract for that state is "one
              instruction, once: sign in" (see `queueForSignIn`); adding a
              second control that says "take another one" both dilutes that
              instruction and grows a queue that cannot drain until the same
              single action is taken. `photo-input.auth.test.tsx` asserts this
              screen carries exactly one button, and it is right to.
            - `error` — the primary button is the retry in that state, and two
              controls disagreeing about whether the last photo counted is worse
              than one.
            - `uploading` — nothing is settled yet. */}
      {(status === 'done' || status === 'queued') && !atLimit && (
        <button
          type="button"
          data-testid="photo-add-another"
          onClick={() => ref.current?.click()}
          className="min-h-[56px] w-full rounded-lg border border-dr3-cream/30 px-4 py-3 text-base font-semibold text-dr3-cream/90 transition-colors hover:border-dr3-cream/60 hover:text-dr3-cream"
        >
          {t('photo.add_another')}
        </button>
      )}
      {count > 0 && (
        <p className="text-xs text-dr3-cream/70" data-testid="photo-count">
          {t(atLimit ? 'photo.count_full' : 'photo.count', {
            count: String(count),
            max: String(MAX_PHOTOS_PER_KIND),
          })}
        </p>
      )}
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
