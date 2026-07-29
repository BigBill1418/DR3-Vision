'use client';

// ADR-0067 §3.4 — register a document by its URL.
//
// The manual counterpart to enumeration. `sharedWithMe` is both deprecated and,
// in this tenant, under-reporting — it returns one item while more documents are
// genuinely shared with the service account — so there has to be a way for Bill
// to say "watch THIS one" with the only handle he has: the link.
//
// Per hard rule #10 there is NO HTML `<form>`: the button is an onClick handler.
// Enter-to-submit is wired on the input's onKeyDown for the same reason, since a
// formless input gets no implicit submit.
//
// Strings live here rather than in `messages.ts` because this component is the
// only consumer; if a second surface ever needs them they move, not before.

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

const COPY = {
  heading: 'Register a document by link',
  body:
    'Paste the SharePoint or OneDrive address of a document shared with the Vision service ' +
    'account. Use this when a document is shared but has not shown up on its own — Microsoft’s ' +
    'shared-with-me list is being retired and does not report every share.',
  placeholder: 'https://svdp.sharepoint.com/:x:/g/…',
  submit: 'Register',
  working: 'Resolving…',
  registered: 'Registered',
  alreadyWatched: 'Already watched',
  owner: 'Owner',
  ownerUnknown: 'Microsoft did not report an owner',
  needsClassifying: 'It is now in the queue above, waiting for you to confirm what it is.',
  failed: 'Could not register that link.',
} as const;

interface Registered {
  created: boolean;
  name: string;
  ownerUpn: string | null;
  kind: 'file' | 'folder';
}

export function RegisterShareClient() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Registered | null>(null);

  const submit = useCallback(async () => {
    const trimmed = url.trim();
    if (trimmed.length === 0 || pending) return;

    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/doc-ingest/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const body = (await res.json().catch(() => null)) as
        | (Partial<Registered> & { message?: string })
        | null;

      if (!res.ok) {
        // The route sends a SPECIFIC sentence per failure (unshared, deleted,
        // unrecognized link, connection halted). Showing a generic message
        // instead would throw away the only part that tells Bill what to do.
        setError(body?.message ?? COPY.failed);
        return;
      }

      setResult({
        created: body?.created ?? false,
        name: body?.name ?? '(unnamed)',
        ownerUpn: body?.ownerUpn ?? null,
        kind: body?.kind ?? 'file',
      });
      setUrl('');
      // Pull the new row into the list above without a full navigation.
      router.refresh();
    } catch {
      setError(COPY.failed);
    } finally {
      setPending(false);
    }
  }, [url, pending, router]);

  return (
    <section className="flex flex-col gap-3 rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20">
      <div>
        <h2 className="text-xl font-semibold">{COPY.heading}</h2>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">{COPY.body}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={COPY.heading}
          type="url"
          inputMode="url"
          value={url}
          placeholder={COPY.placeholder}
          disabled={pending}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          className="w-full max-w-2xl rounded bg-dr3-space px-2 py-1 text-sm ring-1 ring-dr3-steel-light/30 disabled:opacity-40"
        />
        <button
          type="button"
          disabled={pending || url.trim().length === 0}
          onClick={() => void submit()}
          className="rounded bg-dr3-cyan/20 px-3 py-1 text-sm text-dr3-cyan ring-1 ring-dr3-cyan/40 disabled:opacity-40"
        >
          {pending ? COPY.working : COPY.submit}
        </button>
      </div>

      {error ? (
        <p className="rounded-md bg-red-500/10 px-4 py-3 text-sm text-red-300 ring-1 ring-red-500/30">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="rounded-md bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200 ring-1 ring-emerald-500/30">
          <p>
            <span className="font-medium">
              {result.created ? COPY.registered : COPY.alreadyWatched}:
            </span>{' '}
            {result.name}
            {result.kind === 'folder' ? ' (folder)' : ''}
          </p>
          <p className="mt-1 text-emerald-200/80">
            {COPY.owner}: {result.ownerUpn ?? COPY.ownerUnknown}
          </p>
          {result.created && result.kind === 'file' ? (
            <p className="mt-1 text-emerald-200/80">{COPY.needsClassifying}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
