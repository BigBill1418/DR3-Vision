'use client';

// ADR-0141 D3 — manage the accounting-staff list on the AP configuration page.
// onClick handlers only, no <form> (CLAUDE.md hard rule #10). Every write goes
// through /api/admin/ap/accounting-contacts, which audits it.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { adminMessages as M } from '@/app/admin/messages';
import type { AccountingContactDto } from '@/lib/ap/accounting-contacts';

const T = M.apAccounting;
const API = '/api/admin/ap/accounting-contacts';

async function send(method: 'POST' | 'PATCH', body: object): Promise<string | null> {
  const res = await fetch(API, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? M.errors.invalidPayload;
}

export function AccountingContactsPanel({ contacts }: { contacts: AccountingContactDto[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(method: 'POST' | 'PATCH', body: object, after?: () => void) {
    setBusy(true);
    setError(null);
    const err = await send(method, body);
    setBusy(false);
    if (err) return setError(err);
    after?.();
    router.refresh();
  }

  return (
    <section
      id="accounting"
      data-testid="ap-accounting-contacts"
      className="flex flex-col gap-4 rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-6"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{T.heading}</h2>
        <p className="max-w-4xl text-sm text-dr3-mist-dim">{T.intro}</p>
      </header>

      {contacts.length === 0 ? (
        <p className="text-sm text-amber-300">{T.empty}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-dr3-mist-dim">
            <tr>
              <th className="py-2 pr-4 font-medium">{T.colName}</th>
              <th className="py-2 pr-4 font-medium">{T.colEmail}</th>
              <th className="py-2 pr-4 font-medium">{T.colStatus}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className="border-t border-dr3-steel-light/15">
                <td className="py-2 pr-4">{c.displayName}</td>
                <td className="py-2 pr-4 font-mono text-xs">{c.email}</td>
                <td className="py-2 pr-4">{c.active ? T.active : T.inactive}</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run('PATCH', { id: c.id, active: !c.active })}
                    className="rounded border border-dr3-steel-light/40 px-3 py-1 text-xs hover:border-dr3-cyan disabled:opacity-50"
                  >
                    {c.active ? T.deactivate : T.reactivate}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{T.addHeading}</h3>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label={T.colName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={T.namePlaceholder}
            className="min-w-48 flex-1 rounded border border-dr3-steel-light/40 bg-dr3-space px-3 py-2 text-sm"
          />
          <input
            aria-label={T.colEmail}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={T.emailPlaceholder}
            className="min-w-48 flex-1 rounded border border-dr3-steel-light/40 bg-dr3-space px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run('POST', { display_name: name, email }, () => {
                setName('');
                setEmail('');
              })
            }
            className="rounded-md bg-dr3-cyan/20 px-4 py-2 text-sm font-semibold text-dr3-mist ring-1 ring-dr3-cyan/40 transition hover:bg-dr3-cyan/30 disabled:opacity-50"
          >
            {busy ? T.saving : T.add}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
