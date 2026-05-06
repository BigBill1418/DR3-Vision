'use client';

import type { PhotoKind } from '@prisma/client';
import { useRef, useState } from 'react';

// Touch-first camera input + R2 upload (T-007). Sequence:
//   1. operator taps the button → file picker / rear camera
//   2. POST /api/photos/upload-url for a presigned URL + storage_key
//   3. PUT the file bytes directly to R2 (or skip if R2 not yet
//      provisioned — `upload_url` is null and we proceed with the
//      placeholder storage_key for backward compat)
//   4. POST /api/photos/confirm to write the LoadPhoto row
//   5. fire `onCaptured(file)` so the parent stage enables Continue
//
// CLAUDE.md hard rules respected:
//   #7  photos go to R2, never local disk or DB
//   #10 onClick handlers, no native <form>

type Props = {
  loadId: string;
  kind: PhotoKind;
  label: string;
  onCaptured: (file: File) => void;
};

type Status = 'idle' | 'uploading' | 'done' | 'error';

export function PhotoInput({ loadId, kind, label, onCaptured }: Props) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setStatus('uploading');
    setError(null);
    setName(file.name);
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
      const { storage_key, upload_url } = (await mintRes.json()) as {
        storage_key: string;
        upload_url: string | null;
      };

      if (upload_url) {
        const putRes = await fetch(upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!putRes.ok) throw new Error(`R2 PUT failed (${putRes.status})`);
      }

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

      setStatus('done');
      onCaptured(file);
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'upload failed');
    }
  };

  const buttonText = (() => {
    if (status === 'uploading') return `Uploading ${label}…`;
    if (status === 'done') return `✓ ${label} captured`;
    if (status === 'error') return `Retry ${label}`;
    return `📸 ${label}`;
  })();

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
      {error && <p className="text-sm text-red-300">{error}</p>}
    </div>
  );
}
