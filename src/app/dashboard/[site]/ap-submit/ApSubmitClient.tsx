'use client';

// ADR-0141 — the submit form. onClick handlers only, no <form> (CLAUDE.md hard
// rule #10). Strings arrive translated from the server page (en/es/ur).

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

export interface ApSubmitStrings {
  title: string;
  site_label: string;
  file_label: string;
  file_hint: string;
  vendor_label: string;
  invoice_number_label: string;
  amount_label: string;
  purpose_label: string;
  accountant_label: string;
  accountant_placeholder: string;
  submit: string;
  submitting: string;
  success: string;
  missing_fields: string;
  no_accountants: string;
  errors: Record<string, string>;
}

export interface MySubmissionRow {
  id: string;
  submittedAt: string;
  invoice: string;
  amountCents: number;
  accountant: string;
  status: string;
}

interface Props {
  siteCode: string;
  siteName: string;
  /** Admins pick the site; managers get their own, fixed. Empty for a manager. */
  adminSites: { code: string; name: string }[];
  accountants: { id: string; name: string }[];
  accept: string;
  strings: ApSubmitStrings;
}

const field =
  'w-full rounded border border-dr3-steel-light/40 bg-dr3-space px-3 py-2 text-base text-dr3-mist';
const label = 'mb-1 block text-sm font-medium';

export function ApSubmitClient({
  siteCode,
  siteName,
  adminSites,
  accountants,
  accept,
  strings: s,
}: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [site, setSite] = useState(siteCode);
  const [files, setFiles] = useState<File[]>([]);
  const [vendor, setVendor] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [accountantId, setAccountantId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (accountants.length === 0) {
    return (
      <p className="rounded border border-amber-400/40 p-4 text-sm text-amber-300">
        {s.no_accountants}
      </p>
    );
  }

  async function submit() {
    setMessage(null);
    if (
      files.length === 0 ||
      !vendor.trim() ||
      !invoiceNumber.trim() ||
      !amount.trim() ||
      !purpose.trim() ||
      !accountantId
    ) {
      setMessage({ ok: false, text: s.missing_fields });
      return;
    }
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.set('vendor', vendor);
    fd.set('invoiceNumber', invoiceNumber);
    fd.set('amount', amount);
    fd.set('purpose', purpose);
    fd.set('accountantId', accountantId);
    setBusy(true);
    try {
      const res = await fetch(`/api/dashboard/${encodeURIComponent(site)}/ap-submit`, {
        method: 'POST',
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const code = res.status === 403 ? 'forbidden' : (data.error ?? 'generic');
        setMessage({ ok: false, text: s.errors[code] ?? s.errors['generic'] ?? '' });
        return;
      }
      setFiles([]);
      if (fileRef.current) fileRef.current.value = '';
      setVendor('');
      setInvoiceNumber('');
      setAmount('');
      setPurpose('');
      setAccountantId('');
      setMessage({ ok: true, text: s.success });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: s.errors['generic'] ?? '' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="ap-submit-form">
      <div>
        <span className={label}>{s.site_label}</span>
        {adminSites.length > 0 ? (
          <select
            aria-label={s.site_label}
            value={site}
            onChange={(e) => setSite(e.target.value)}
            className={field}
          >
            {adminSites.map((x) => (
              <option key={x.code} value={x.code}>
                {x.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-base" data-testid="ap-submit-site">
            {siteName}
          </p>
        )}
      </div>

      <div>
        <label className={label} htmlFor="ap-submit-files">
          {s.file_label}
        </label>
        <input
          id="ap-submit-files"
          ref={fileRef}
          type="file"
          multiple
          accept={accept}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="block w-full text-sm"
        />
        <p className="mt-1 text-xs text-dr3-mist-dim">{s.file_hint}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="ap-submit-vendor">
            {s.vendor_label}
          </label>
          <input
            id="ap-submit-vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label className={label} htmlFor="ap-submit-invoice">
            {s.invoice_number_label}
          </label>
          <input
            id="ap-submit-invoice"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label className={label} htmlFor="ap-submit-amount">
            {s.amount_label}
          </label>
          <input
            id="ap-submit-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label className={label} htmlFor="ap-submit-accountant">
            {s.accountant_label}
          </label>
          <select
            id="ap-submit-accountant"
            value={accountantId}
            onChange={(e) => setAccountantId(e.target.value)}
            className={field}
          >
            <option value="">{s.accountant_placeholder}</option>
            {accountants.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={label} htmlFor="ap-submit-purpose">
          {s.purpose_label}
        </label>
        <textarea
          id="ap-submit-purpose"
          rows={3}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          className={field}
        />
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={submit}
        data-testid="ap-submit-button"
        className="rounded-md bg-dr3-cyan/20 px-4 py-3 text-base font-semibold text-dr3-mist ring-1 ring-dr3-cyan/40 transition hover:bg-dr3-cyan/30 disabled:opacity-50"
      >
        {busy ? s.submitting : s.submit}
      </button>

      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={message.ok ? 'text-sm text-emerald-300' : 'text-sm text-red-300'}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
