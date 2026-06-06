'use client';
/* eslint-disable @next/next/no-img-element -- proxied Graph photo (/api/me/photo)
   with a runtime initials fallback; next/image can't proxy the auth-gated route and
   would fight the preload-then-swap pattern below. */

// Vision Dashboard avatar (ADR-0020 / T-119). Initials are the DEFAULT render; we
// preload the Microsoft Graph profile photo client-side and only swap it in once it
// loads successfully. This avoids the broken-image glyph entirely and sidesteps the
// React gotcha where an <img> 404 fires before hydration attaches onError (so the
// handler never runs). No photo / no token / Graph down → initials stay. The browser
// caches a successful photo for 24h (Cache-Control on /api/me/photo).

import { useEffect, useState } from 'react';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function DashboardAvatar({ name }: { name: string }) {
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new window.Image();
    const url = '/api/me/photo';
    img.onload = () => {
      if (!cancelled) setPhotoSrc(url);
    };
    img.onerror = () => {
      if (!cancelled) setPhotoSrc(null);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, []);

  if (photoSrc) {
    return (
      <img
        src={photoSrc}
        alt=""
        width={40}
        height={40}
        className="h-10 w-10 rounded-full bg-dr3-space-2 object-cover ring-1 ring-dr3-steel-light/30"
      />
    );
  }

  return (
    <span
      className="flex h-10 w-10 items-center justify-center rounded-full bg-dr3-cyan text-sm font-bold text-dr3-space"
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
