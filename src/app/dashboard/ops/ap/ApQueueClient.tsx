'use client';

// ADR-0046 D4 — AP approval queue client. The request body is the sanitized HTML
// (already allowlisted server-side at ingest) rendered inside a MAXIMALLY
// restrictive sandboxed <iframe sandbox=""> (no scripts, no same-origin, no forms)
// — the belt-and-suspenders second control after ingest sanitization. Per hard
// rule #10, decisions use onClick handlers, never <form> elements.

import { useCallback, useEffect, useState } from 'react';
import {
  AP_ATTACHMENT_URL_TTL_SECONDS,
  isInlineImage,
  isInlinePdf,
  isInlinePreviewable,
  isPresignStale,
} from '@/lib/ap/inline-preview';

type Status =
  | 'pending'
  | 'pending_review'
  // ADR-0046 Amendment 5 (D-M5-3) — dual-approval hop (>= $1,000). Not actionable
  // from this panel (the second-approver flow handles it); typed here so a detail in
  // that state renders without a cast.
  | 'pending_second_approval'
  | 'approved'
  | 'rejected'
  | 'quarantined';
/**
 * ADR-0126 — the decided-but-unmailed view. Cuts across approved + rejected, so
 * it is a filter value rather than a status.
 */
const MAIL_UNSENT = 'decision_mail_unsent' as const;
type Filter = Status | 'all' | typeof MAIL_UNSENT;

// ─── ADR-0046 Amendment 5 client mirrors (D-M5-2/4/6). ────────────────────────
type Confidence = 'high' | 'medium' | 'low' | 'failed';
interface ExtractionPrefill {
  confidence: Confidence;
  bestAmountCents: number | null;
  bestVendor: string | null;
}
interface EquipmentOption {
  id: string;
  displayName: string;
  category: string;
  /**
   * ADR-0075 — which yard the asset is filed at. The picker has been fleet-wide
   * since 2026-07-28, so without this two similarly-named assets from different
   * sites are indistinguishable in one flat list.
   */
  siteCode?: string | null;
}
interface VarianceEvaluation {
  tripped: boolean;
  meanAmountCents: number;
  invoiceCount: number;
  varianceAbsCents: number;
  variancePct: number;
  direction: 'over' | 'under';
}
interface VarianceContext {
  established: boolean;
  vendorDisplayName?: string;
  evaluation?: VarianceEvaluation;
  recent?: Array<{ invoiceDate: string; amountCents: number }>;
}
interface EquipmentLinkView {
  equipmentId: string | null;
  displayName: string | null;
  isNotEquipmentRelated: boolean;
  /** Amendment 9 (§2.2) — set on the escape-hatch disposition. Mirrors
   * `ApEquipmentLinkView` in `@/lib/ap/queue`; this file keeps its own view
   * types so the client bundle never imports the Prisma-backed module. */
  equipmentRequest: { id: string; description: string; status: string } | null;
}

interface ListRow {
  id: string;
  /**
   * ADR-0068 Amendment 3 — the queue is one worklist over two objects. Optional
   * so a payload from an older deploy (no `kind`) still renders as an invoice
   * rather than throwing.
   */
  kind?: 'invoice' | 'reimbursement';
  status: Status;
  subject: string | null;
  senderAddress: string;
  senderValidated: boolean;
  receivedAt: string;
  vendor: string | null;
  amountCents: number | null;
  attachmentCount: number;
  followupCount: number;
  heldByName: string | null;
  holdNote: string | null;
  /**
   * ADR-0126 — decided, with no confirmed decision email. Computed server-side
   * from the shared predicate; optional so a payload from an older deploy simply
   * renders no badge rather than throwing.
   */
  decisionMailUnsent?: boolean;
  /** Present iff `kind === 'reimbursement'`. */
  reimbursement?: {
    siteCode: string;
    siteName: string;
    beneficiary: string;
    submitterName: string;
    routedToName: string;
    purpose: string;
    category: string;
    escalated: boolean;
    url: string;
  } | null;
}
interface AttachmentView {
  id: string;
  kind: 'file' | 'nested_message' | 'reference_link';
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  storageKey: string | null;
  linkUrl: string | null;
  nestedSubject: string | null;
}
interface Detail extends ListRow {
  conversationId: string | null;
  bodyHtmlSanitized: string | null;
  bodyText: string | null;
  quarantineReason: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decisionMailSentAt: string | null;
  heldByName: string | null;
  heldAt: string | null;
  holdNote: string | null;
  // Amendment 5 (D-M5-1/2/4/6) — structured-decide surface.
  extraction: ExtractionPrefill | null;
  vendorFreeform: string | null;
  explanation: string | null;
  confirmedAmountCents: number | null;
  varianceFlagState: string | null;
  varianceAcknowledgmentNote: string | null;
  equipmentLinks: EquipmentLinkView[];
  // Amendment 5 (D-M5-3) — dual-approval read surface + viewer-scoped eligibility.
  firstApproverName: string | null;
  firstApprovedAt: string | null;
  secondApproverName: string | null;
  secondApprovedAt: string | null;
  secondApproverNote: string | null;
  secondApproval: {
    eligible: boolean;
    isFirstApprover: boolean;
    selfWaitRemainingMs: number;
  } | null;
  attachments: AttachmentView[];
  followups: Array<{
    id: string;
    receivedAt: string;
    senderAddress: string;
    bodyText: string | null;
  }>;
}

const TABS: Filter[] = [
  'pending',
  'pending_review',
  // D-M5-3 — the $1,000 second-approval queue tab (second approvers work from here).
  'pending_second_approval',
  'approved',
  'rejected',
  'quarantined',
  // ADR-0126 — rendered ONLY when the count is non-zero (or it is the active
  // tab). A permanently-visible "mail not sent (0)" is clutter that trains the
  // eye to skip it; a tab that appears exactly when something is wrong is a
  // signal. See `visibleTabs` below.
  MAIL_UNSENT,
  'all',
];

/** Tab/label text — the raw enum value `pending_review` reads as "On hold". */
const STATUS_LABEL: Record<Filter, string> = {
  pending: 'pending',
  pending_review: 'on hold',
  pending_second_approval: 'awaiting 2nd approval',
  approved: 'approved',
  rejected: 'rejected',
  quarantined: 'quarantined',
  [MAIL_UNSENT]: 'mail not sent',
  all: 'all',
};

// Render timestamps in Bill's Pacific wall clock, not the browser's local zone —
// toLocaleString() with no timeZone trusts wherever the viewer's machine is set.
// Pin the zone explicitly and label ' PT', matching the AP email + stamp surfaces
// (formatPacificDateTime's medium/short shape).
function fmt(iso: string): string {
  const at = new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${at} PT`;
}
function dollars(cents: number | null): string {
  return cents === null ? '' : `$${(cents / 100).toFixed(2)}`;
}

/**
 * Parse an operator-typed USD amount to integer cents (M4). `parseFloat` stops at
 * the first comma — `parseFloat('1,234.56')` is `1`, so a $1,234.56 invoice was
 * filed to Great Plains as $1.00. Strip US thousands separators, accept a plain
 * or grouped number with ≤2 decimals, and REJECT anything ambiguous (a `$`
 * prefix, letters, odd grouping) with a message rather than silently coercing it.
 * Returns cents on success, or `{ error }` for the caller to surface.
 */
export function parseUsdToCents(raw: string): number | { error: string } {
  const s = raw.trim().replace(/\s+/g, '');
  if (!s) return { error: 'Enter an amount, or clear the field to omit it.' };
  if (/[^0-9.,]/.test(s)) {
    return { error: 'Enter a plain dollar amount like 1234.56 — no $, letters, or symbols.' };
  }
  const grouped = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/; // 1,234 or 1,234.56
  const plain = /^\d+(\.\d{1,2})?$/; // 1234 or 1234.56
  let numeric: string;
  if (grouped.test(s)) numeric = s.replace(/,/g, '');
  else if (plain.test(s)) numeric = s;
  else return { error: 'Enter a valid dollar amount like 1234.56 or 1,234.56.' };
  const value = Number(numeric);
  if (!Number.isFinite(value) || value < 0) {
    return { error: 'Amount must be a positive number.' };
  }
  return Math.round(value * 100);
}

export function ApQueueClient() {
  const [filter, setFilter] = useState<Filter>('pending');
  const [rows, setRows] = useState<ListRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (f: Filter) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ops/ap?status=${f}`);
      if (!res.ok) throw new Error(`list failed (${res.status})`);
      const body = await res.json();
      setRows(body.rows);
      setCounts(body.counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/ops/ap/${id}`);
      if (!res.ok) throw new Error(`detail failed (${res.status})`);
      const body = await res.json();
      setDetail(body.request);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load request');
    }
  }, []);

  // Tier-1 deep link: the new-request email links to /dashboard/ops/ap?request=<id>.
  // Open that request on mount (client-only — 'use client', no SSR/Suspense concern).
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('request');
    if (requested) {
      setFilter('all');
      setSelectedId(requested);
    }
  }, []);

  useEffect(() => {
    void loadList(filter);
  }, [filter, loadList]);
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const refresh = useCallback(() => {
    void loadList(filter);
    if (selectedId) void loadDetail(selectedId);
  }, [filter, selectedId, loadList, loadDetail]);

  // ADR-0126 — the mail-not-sent tab appears only when something is actually
  // stuck. The `filter === MAIL_UNSENT` clause keeps it from vanishing out from
  // under an operator who is standing on it when the last row clears.
  const visibleTabs = TABS.filter(
    (t) => t !== MAIL_UNSENT || (counts[MAIL_UNSENT] ?? 0) > 0 || filter === MAIL_UNSENT,
  );

  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-2">
        {visibleTabs.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`rounded-full px-3 py-1 text-sm capitalize ${
              filter === t
                ? 'bg-dr3-cyan text-dr3-space'
                : t === MAIL_UNSENT
                  ? // Unselected, it still reads as a problem — it only exists
                    // when one exists.
                    'bg-red-500/25 text-red-200 hover:bg-red-500/40'
                  : 'bg-dr3-steel/30 text-dr3-mist hover:bg-dr3-steel/50'
            }`}
          >
            {STATUS_LABEL[t]}
            {t !== 'all' && ` (${counts[t] ?? 0})`}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-4 rounded bg-red-900/40 px-3 py-2 text-sm text-red-100">{error}</p>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(280px,360px)_1fr]">
        <ul className="space-y-2">
          {loading && rows.length === 0 && <li className="text-sm opacity-70">Loading…</li>}
          {!loading && rows.length === 0 && <li className="text-sm opacity-70">No requests.</li>}
          {rows.map((r) =>
            // ── ADR-0068 Amendment 3 — a reimbursement is VISIBLE here, decided
            // ELSEWHERE. Only one person can act on any given one, and the
            // authorisation that decides who lives on the site surface, so this
            // row is a link rather than a selectable detail. Rendering it through
            // the invoice DetailPanel would offer the Amendment 5 vendor panel
            // (vendor freeform / confirmed amount / equipment) for something with
            // no vendor and no equipment — which is exactly what D7 forbids.
            r.kind === 'reimbursement' && r.reimbursement ? (
              <li key={r.id}>
                <a
                  href={r.reimbursement.url}
                  className="block w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left hover:bg-white/10"
                  data-testid="ap-queue-reimbursement-row"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {r.subject ?? '(no subject)'}
                    </span>
                    <span className="shrink-0 rounded-full bg-teal-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-dr3-ink">
                      Reimbursement
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs opacity-70">
                    {r.senderAddress} · {r.reimbursement.siteName} · {fmt(r.receivedAt)}
                  </div>
                  <div className="mt-1 text-xs opacity-60">
                    {r.amountCents !== null && `${dollars(r.amountCents)} · `}
                    {r.reimbursement.category} · waiting on {r.reimbursement.routedToName}
                    {r.reimbursement.escalated && ' · ESCALATED'}
                  </div>
                  <div className="mt-1 truncate text-xs opacity-60">{r.reimbursement.purpose}</div>
                  <div className="mt-1 text-xs text-dr3-cyan">
                    Open {r.reimbursement.siteName} reimbursements →
                  </div>
                </a>
              </li>
            ) : (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left ${
                    selectedId === r.id
                      ? 'border-dr3-cyan bg-white/10'
                      : 'border-white/10 bg-white/5 hover:bg-white/10'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {r.subject ?? '(no subject)'}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {/* ADR-0126 — the delivery failure is visible on the ROW.
                          It used to live only inside the detail pane, which meant
                          finding it required opening every decided request one by
                          one; nobody does that, so two rejections went unnoticed
                          for weeks. */}
                      {r.decisionMailUnsent && <MailUnsentBadge />}
                      <StatusBadge status={r.status} />
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs opacity-70">
                    {r.senderAddress}
                    {!r.senderValidated && ' · external'} · {fmt(r.receivedAt)}
                  </div>
                  <div className="mt-1 text-xs opacity-60">
                    {r.attachmentCount} attachment{r.attachmentCount === 1 ? '' : 's'}
                    {r.followupCount > 0 &&
                      ` · ${r.followupCount} follow-up${r.followupCount === 1 ? '' : 's'}`}
                    {r.vendor && ` · ${r.vendor}`}
                    {r.amountCents !== null && ` · ${dollars(r.amountCents)}`}
                  </div>
                </button>
              </li>
            ),
          )}
        </ul>

        <div>
          {detail ? (
            <DetailPanel detail={detail} onDecided={refresh} />
          ) : (
            <p className="text-sm opacity-60">Select a request to review.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ADR-0126 — "accounting was never told about this one."
 *
 * Deliberately the loudest chip in the list (solid red, not a tint): every other
 * badge here reports a STATE OF WORK, and this one reports that the system failed
 * to do something it said it did. `title` carries the plain-language explanation
 * for the operator who has not read the ADR.
 */
function MailUnsentBadge() {
  return (
    <span
      data-testid="ap-queue-mail-unsent-badge"
      title="This decision was recorded, but no decision email to accounting was ever confirmed sent. Open the request to re-send."
      className="shrink-0 rounded bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white"
    >
      mail not sent
    </span>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const color: Record<Status, string> = {
    // pending shifts to sky so the amber hold chip is unmistakably distinct.
    pending: 'bg-sky-400 text-dr3-ink',
    pending_review: 'bg-amber-400 text-dr3-ink',
    pending_second_approval: 'bg-violet-400 text-dr3-ink',
    approved: 'bg-emerald-500 text-white',
    rejected: 'bg-red-500 text-white',
    quarantined: 'bg-zinc-500 text-white',
  };
  const label =
    status === 'pending_review'
      ? 'on hold'
      : status === 'pending_second_approval'
        ? 'awaiting 2nd approval'
        : status;
  return (
    <span
      className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase ${color[status]}`}
    >
      {label}
    </span>
  );
}

// ADR-0046 Amendment 5 (D-M5-2) — the extraction-confidence badge on the confirmed-
// amount input. HIGH → green "Verified"; MEDIUM → yellow "Please verify"; LOW → red
// "Low confidence"; FAILED renders no badge (the input is blank with a placeholder).
function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  if (confidence === 'failed') return null;
  const map: Record<Exclude<Confidence, 'failed'>, { cls: string; label: string }> = {
    high: { cls: 'bg-emerald-500 text-white', label: '✓ Verified' },
    medium: { cls: 'bg-amber-400 text-dr3-ink', label: '⚠ Please verify' },
    low: { cls: 'bg-red-500 text-white', label: '⚠ Low confidence' },
  };
  const { cls, label } = map[confidence];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${cls}`}>{label}</span>
  );
}

function confidenceHint(confidence: Confidence): string {
  switch (confidence) {
    case 'high':
      return 'Extracted with high confidence — verify it matches the invoice.';
    case 'medium':
      return 'Multiple amounts were found — please verify against the invoice.';
    case 'low':
      return 'Low confidence — verify the amount against the invoice.';
    case 'failed':
      return 'Amount not extracted — please enter it manually from the invoice.';
  }
}

export function DetailPanel({ detail, onDecided }: { detail: Detail; onDecided: () => void }) {
  // Single reason/note field — Reject / Hold / NOT-DR3 (unchanged; Amendment 5 §5.4
  // constraint #4: these keep their single field, they are NOT structured).
  const [note, setNote] = useState('');
  const [siteCode, setSiteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // ── Amendment 5 (D-M5-1/2/4/6) — the STRUCTURED Approve fields. Extraction
  // PRE-FILLS; the approver still confirms every field (hard rule #5). Seeded from
  // the extraction result, falling back to any prior structured value.
  const [vendorFreeform, setVendorFreeform] = useState(
    detail.vendorFreeform ?? detail.extraction?.bestVendor ?? detail.vendor ?? '',
  );
  const [explanation, setExplanation] = useState('');
  const prefillAmountCents = detail.confirmedAmountCents ?? detail.extraction?.bestAmountCents;
  const [confirmedAmount, setConfirmedAmount] = useState(
    typeof prefillAmountCents === 'number' ? (prefillAmountCents / 100).toFixed(2) : '',
  );
  const [equipmentOptions, setEquipmentOptions] = useState<EquipmentOption[]>([]);
  const [equipmentIds, setEquipmentIds] = useState<string[]>([]);
  const [notEquipmentRelated, setNotEquipmentRelated] = useState(false);
  // Amendment 9 (§2.2) — the ESCAPE HATCH. `equipmentNotListed` is the third
  // mutually exclusive choice; `equipmentDescription` is REQUIRED once it is on.
  const [equipmentNotListed, setEquipmentNotListed] = useState(false);
  const [equipmentDescription, setEquipmentDescription] = useState('');
  const [equipmentQuery, setEquipmentQuery] = useState('');
  const [variance, setVariance] = useState<VarianceContext | null>(null);
  const [varianceAck, setVarianceAck] = useState(false);
  const [varianceAckNote, setVarianceAckNote] = useState('');

  // Structured Approve applies only to a real DR3 site (Woodland/Eugene). NOT-DR3
  // (and an unselected site) uses the single-note path.
  const isRealSite = siteCode === 'eugene' || siteCode === 'woodland';
  const varianceTripped = !!variance?.evaluation?.tripped;

  // D-M5-6 — load the site-filtered equipment options whenever the site changes.
  // Reset the selection (options differ per site). NOT-DR3/blank clears the list.
  useEffect(() => {
    setEquipmentIds([]);
    setNotEquipmentRelated(false);
    setEquipmentNotListed(false);
    setEquipmentDescription('');
    setEquipmentQuery('');
    if (!isRealSite) {
      setEquipmentOptions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/ops/ap/equipment?site=${siteCode}`);
        const body = await res.json().catch(() => ({}));
        if (!cancelled)
          setEquipmentOptions(res.ok && Array.isArray(body.options) ? body.options : []);
      } catch {
        if (!cancelled) setEquipmentOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteCode, isRealSite]);

  // D-M5-4 — re-check variance (debounced) whenever the typed vendor or confirmed
  // amount changes on the structured path. A changed amount/vendor re-gates: the
  // acknowledgment resets so the approver must re-acknowledge a still-tripped flag.
  useEffect(() => {
    setVarianceAck(false);
    if (!isRealSite || !vendorFreeform.trim() || !confirmedAmount.trim()) {
      setVariance(null);
      return;
    }
    const parsed = parseUsdToCents(confirmedAmount);
    if (typeof parsed !== 'number') {
      setVariance(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/ops/ap/variance-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vendor: vendorFreeform.trim(), confirmedAmountCents: parsed }),
        });
        const body = (await res.json().catch(() => ({}))) as VarianceContext;
        if (!cancelled) setVariance(res.ok ? body : null);
      } catch {
        if (!cancelled) setVariance(null);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [vendorFreeform, confirmedAmount, isRealSite]);

  // Amendment 9 — the three choices are MUTUALLY EXCLUSIVE, so each setter clears
  // the other two. Selecting from the list also clears the hatch (and its text, so
  // a half-typed description can never ride along on an equipment-id decision).
  const toggleEquipment = useCallback((id: string) => {
    setNotEquipmentRelated(false);
    setEquipmentNotListed(false);
    setEquipmentDescription('');
    setEquipmentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const chooseNotEquipmentRelated = useCallback((checked: boolean) => {
    setNotEquipmentRelated(checked);
    if (checked) {
      setEquipmentIds([]);
      setEquipmentNotListed(false);
      setEquipmentDescription('');
    }
  }, []);

  const chooseEquipmentNotListed = useCallback((checked: boolean) => {
    setEquipmentNotListed(checked);
    if (checked) {
      setEquipmentIds([]);
      setNotEquipmentRelated(false);
    } else {
      setEquipmentDescription('');
    }
  }, []);

  const decide = useCallback(
    async (decision: 'approved' | 'rejected') => {
      // Operator directive 2026-07-15 — every decision files against a location.
      if (!siteCode) {
        setMsg('Select the location (Woodland, Eugene, or NOT DR3) before deciding.');
        return;
      }
      let payload: Record<string, unknown>;
      if (decision === 'approved' && isRealSite) {
        // ── STRUCTURED APPROVE (D-M5-1/4/6) — four required fields + variance gate.
        // The server re-validates all of this; these are plain-English client guards.
        const v = vendorFreeform.trim();
        if (!v) {
          setMsg('Enter the vendor name to approve.');
          return;
        }
        if (!confirmedAmount.trim()) {
          setMsg('Confirm the invoice amount to approve.');
          return;
        }
        // M4 — normalize the currency input BEFORE trusting it (comma-truncation
        // would file $1,234.56 as $1.00).
        const parsed = parseUsdToCents(confirmedAmount);
        if (typeof parsed !== 'number') {
          setMsg(parsed.error);
          return;
        }
        if (!explanation.trim()) {
          setMsg('Enter what this transaction was for (explanation) to approve.');
          return;
        }
        // Amendment 9 (§2.2) — exactly one of the three equipment dispositions. The
        // hatch is NOT the cheap way out: it costs a required description.
        if (equipmentNotListed && !equipmentDescription.trim()) {
          setMsg('Describe the equipment so Morena and Rick can add it to the fleet.');
          return;
        }
        if (!notEquipmentRelated && !equipmentNotListed && equipmentIds.length === 0) {
          setMsg(
            'Select the equipment this invoice relates to, describe it if it isn’t in the list, or choose "Not equipment-related".',
          );
          return;
        }
        if (varianceTripped && !varianceAck) {
          setMsg('Acknowledge the variance ("I’ve verified the variance") before approving.');
          return;
        }
        payload = {
          decision,
          siteId: siteCode,
          vendorFreeform: v,
          explanation: explanation.trim(),
          confirmedAmountCents: parsed,
          ...(equipmentNotListed
            ? { equipmentRequestDescription: equipmentDescription.trim() }
            : notEquipmentRelated
              ? { notEquipmentRelated: true }
              : { equipmentIds }),
          ...(varianceTripped
            ? { varianceAcknowledged: true, varianceAckNote: varianceAckNote.trim() || undefined }
            : {}),
        };
      } else {
        // ── Single-note path — Reject (any site), or Approve + NOT-DR3. Keeps the
        // pre-Amendment-5 contract (§5.4 #4).
        if (!note.trim()) {
          setMsg(
            siteCode === 'not_dr3'
              ? 'NOT DR3 requires a reason — add it in the note, then decide.'
              : 'A rejection needs a note explaining why. Add a note, then Reject.',
          );
          return;
        }
        payload = {
          decision,
          note: note.trim(),
          ...(siteCode === 'not_dr3' ? { notDr3: true } : { siteId: siteCode }),
        };
      }
      setBusy(true);
      setMsg(null);
      try {
        const res = await fetch(`/api/ops/ap/${detail.id}/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.alreadyDecided) {
          setMsg(`This request was ${body.error}. Refreshing.`);
        } else if (!res.ok) {
          setMsg(body.error ?? `decide failed (${res.status})`);
        } else if (body.secondApprovalPending) {
          // D-M5-3 — a >= $1,000 Approve went to second approval instead of
          // terminating. No decision email yet; the second approver was notified.
          setMsg(
            `Approved — this invoice is ≥ $1,000, so it now needs a SECOND approval${
              body.secondApproverLabel ? ` from ${body.secondApproverLabel}` : ''
            } before payment. No decision email is sent until the second approval is confirmed.`,
          );
        } else {
          const mailNote =
            body.mail === 'sent'
              ? 'decision emailed to accounting.'
              : body.mail === 'refused_no_recipients'
                ? 'DECIDED, but no decision-recipient configured — email NOT sent (an operator alert was raised). Configure recipients, then Re-send.'
                : body.mail === 'disabled'
                  ? 'decided (mail disabled — M365 not configured).'
                  : body.mail === 'too_large'
                    ? // ADR-0114 — this used to say "re-sending will not help", which was
                      // true only while the transport could not carry anything over 3 MB.
                      // It now carries up to the mailbox limit, so this outcome means the
                      // message is too big for the MAILBOX and Re-send genuinely cannot
                      // help until it shrinks. Kept honest in both directions: the
                      // operator is told to forward manually, not sent to click a button
                      // that will refuse again.
                      'DECIDED, but the stamped invoice exceeds the sending mailbox’s per-message limit — accounting was NOT told. Re-sending will not help at this size; open the request and forward the stamped PDF manually.'
                    : 'decided, but the decision email failed to send. Use Re-send.';
          setMsg(`Request ${decision}; ${mailNote}`);
        }
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'decide failed');
      } finally {
        setBusy(false);
        onDecided();
      }
    },
    [
      note,
      siteCode,
      isRealSite,
      vendorFreeform,
      explanation,
      confirmedAmount,
      equipmentIds,
      notEquipmentRelated,
      equipmentNotListed,
      equipmentDescription,
      varianceTripped,
      varianceAck,
      varianceAckNote,
      detail.id,
      onDecided,
    ],
  );

  const resend = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/ops/ap/${detail.id}/resend`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      setMsg(
        res.ok ? `Re-send result: ${body.mail}` : (body.error ?? `re-send failed (${res.status})`),
      );
    } finally {
      setBusy(false);
      onDecided();
    }
  }, [detail.id, onDecided]);

  // Amendment 3 — place the request on hold ("pending review"), REQUIRED note.
  const placeHold = useCallback(async () => {
    if (!note.trim()) {
      setMsg('A hold needs a note explaining why it is being held. Add a note, then Hold.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/ops/ap/${detail.id}/hold`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.alreadyDecided)
        setMsg(`This request was ${body.error}. Refreshing.`);
      else if (!res.ok) setMsg(body.error ?? `hold failed (${res.status})`);
      else setMsg('Placed on hold; accounting was notified it is under review.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'hold failed');
    } finally {
      setBusy(false);
      onDecided();
    }
  }, [note, detail.id, onDecided]);

  // Amendment 3 — update the hold note on an on-hold request, REQUIRED note.
  const saveHoldNote = useCallback(async () => {
    if (!note.trim()) {
      setMsg('The hold note cannot be empty.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/ops/ap/${detail.id}/hold`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? 'Hold note updated.' : (body.error ?? `update failed (${res.status})`));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'update failed');
    } finally {
      setBusy(false);
      onDecided();
    }
  }, [note, detail.id, onDecided]);

  const actionable = detail.status === 'pending' || detail.status === 'pending_review';

  // Approve gating: a real-site Approve needs all four structured fields (+ variance
  // ack when tripped); a NOT-DR3 Approve needs the single note. The server re-checks.
  const structuredComplete =
    !!vendorFreeform.trim() &&
    !!confirmedAmount.trim() &&
    !!explanation.trim() &&
    // Amendment 9 — the hatch satisfies the equipment requirement only with a
    // NON-EMPTY description. An empty one leaves Approve disabled, exactly like an
    // empty selection would.
    (notEquipmentRelated ||
      equipmentIds.length > 0 ||
      (equipmentNotListed && !!equipmentDescription.trim())) &&
    (!varianceTripped || varianceAck);
  const approveDisabled = busy || !siteCode || (isRealSite ? !structuredComplete : !note.trim());

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{detail.subject ?? '(no subject)'}</h2>
          <p className="mt-0.5 text-xs opacity-70">
            {detail.senderAddress}{' '}
            {detail.senderValidated ? '· internal' : '· EXTERNAL (unapprovable)'} ·{' '}
            {fmt(detail.receivedAt)}
          </p>
        </div>
        <StatusBadge status={detail.status} />
      </div>

      {detail.status === 'quarantined' && (
        <p className="mt-3 rounded bg-zinc-700/40 px-3 py-2 text-sm">
          Quarantined ({detail.quarantineReason ?? 'unprocessable'}) — admin review only, not
          approvable.
        </p>
      )}

      {detail.status === 'pending_review' && (
        <div className="mt-3 rounded border border-amber-400/60 bg-amber-400/15 px-3 py-2 text-sm">
          <span className="font-semibold text-amber-200">ON HOLD — pending review</span>
          {detail.heldByName && <span className="opacity-90"> · held by {detail.heldByName}</span>}
          {detail.heldAt && <span className="opacity-70"> · {fmt(detail.heldAt)}</span>}
          {detail.holdNote && <div className="mt-1 opacity-90">“{detail.holdNote}”</div>}
        </div>
      )}

      {detail.decidedByName && (
        <p className="mt-3 text-sm opacity-80">
          Decided by {detail.decidedByName}
          {detail.decidedAt && ` at ${fmt(detail.decidedAt)}`}
          {detail.decisionNote && ` — “${detail.decisionNote}”`}
          {detail.decisionMailSentAt
            ? ' · decision emailed.'
            : ' · decision email NOT confirmed sent.'}
        </p>
      )}

      {/* D-M5-3 — a decided >= $1,000 request shows BOTH approvers + timestamps. */}
      {detail.firstApproverName &&
        (detail.status === 'approved' || detail.status === 'rejected') && (
          <p className="mt-1 text-sm opacity-80">
            First approval by {detail.firstApproverName}
            {detail.firstApprovedAt && ` at ${fmt(detail.firstApprovedAt)}`}
            {detail.secondApproverName && (
              <>
                {' · '}
                {detail.status === 'rejected' ? 'overridden' : 'second approval'} by{' '}
                {detail.secondApproverName}
                {detail.secondApprovedAt && ` at ${fmt(detail.secondApprovedAt)}`}
              </>
            )}
            {detail.status === 'rejected' &&
              detail.secondApproverNote &&
              ` — “${detail.secondApproverNote}”`}
          </p>
        )}

      {detail.status === 'pending_second_approval' && (
        <SecondApprovalPanel detail={detail} onDecided={onDecided} />
      )}

      <section className="mt-4">
        <h3 className="text-sm font-semibold opacity-90">Message body</h3>
        {detail.bodyHtmlSanitized ? (
          <iframe
            // Maximally restrictive sandbox: no scripts, no same-origin, no forms.
            sandbox=""
            srcDoc={detail.bodyHtmlSanitized}
            title="invoice message body (sanitized)"
            className="mt-2 h-64 w-full rounded border border-white/10 bg-white"
          />
        ) : detail.bodyText ? (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-white/10 bg-black/30 p-3 text-sm">
            {detail.bodyText}
          </pre>
        ) : (
          <p className="mt-2 text-sm opacity-60">(no body)</p>
        )}
      </section>

      {detail.attachments.length > 0 && (
        <section className="mt-4">
          <h3 className="text-sm font-semibold opacity-90">Attachments</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.attachments.map((a) => (
              <AttachmentRow key={a.id} requestId={detail.id} att={a} />
            ))}
          </ul>
        </section>
      )}

      {detail.followups.length > 0 && (
        <section className="mt-4">
          <h3 className="text-sm font-semibold opacity-90">Follow-ups</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {detail.followups.map((f) => (
              <li key={f.id} className="rounded border border-white/10 bg-white/5 p-2">
                <div className="text-xs opacity-70">
                  {f.senderAddress} · {fmt(f.receivedAt)}
                </div>
                {f.bodyText && (
                  <div className="mt-1 whitespace-pre-wrap opacity-90">{f.bodyText}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {actionable && (
        <section className="mt-5 border-t border-white/10 pt-4">
          <h3 className="text-sm font-semibold opacity-90">Decision</h3>

          {/* Location — required, and it drives the structured-Approve vs single-note split. */}
          <label className="mt-2 block text-xs opacity-80 sm:max-w-xs">
            Location <span className="text-amber-300">(required)</span>
            <select
              value={siteCode}
              onChange={(e) => setSiteCode(e.target.value)}
              className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
            >
              <option value="">— select site —</option>
              <option value="eugene">Eugene</option>
              <option value="woodland">Woodland</option>
              <option value="not_dr3">NOT DR3 – See Reason</option>
            </select>
            {siteCode === 'not_dr3' && (
              <span className="mt-1 block text-amber-300">
                NOT DR3 — add the reason in the note below (required). This will NOT be filed
                against a DR3 site.
              </span>
            )}
          </label>

          {/* D-M5-1/4/6 — structured Approve fields (real site only). Reject/Hold use the note below. */}
          {isRealSite && (
            <div className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/5 p-3">
              <p className="text-xs font-semibold text-emerald-200">
                To Approve, complete all four fields (extraction pre-fills; you confirm each):
              </p>

              <label className="mt-2 block text-xs opacity-80">
                Vendor <span className="text-amber-300">(required to approve)</span>
                <span className="mt-0.5 block opacity-70">
                  Enter the vendor name carefully — check spelling and capitalization. This appears
                  on the returned decision email and Mary’s GP filing.
                </span>
                <input
                  value={vendorFreeform}
                  onChange={(e) => setVendorFreeform(e.target.value)}
                  className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
                />
              </label>

              <label className="mt-2 block text-xs opacity-80">
                <span className="inline-flex items-center gap-2">
                  Confirmed amount USD <span className="text-amber-300">(required to approve)</span>
                  {detail.extraction && (
                    <ConfidenceBadge confidence={detail.extraction.confidence} />
                  )}
                </span>
                <input
                  value={confirmedAmount}
                  inputMode="decimal"
                  placeholder={
                    detail.extraction?.confidence === 'failed'
                      ? 'Enter amount from invoice'
                      : undefined
                  }
                  onChange={(e) => setConfirmedAmount(e.target.value)}
                  className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
                />
                {detail.extraction && (
                  <span className="mt-0.5 block opacity-60">
                    {confidenceHint(detail.extraction.confidence)}
                  </span>
                )}
              </label>

              <label className="mt-2 block text-xs opacity-80">
                Explanation <span className="text-amber-300">(required to approve)</span>
                <span className="mt-0.5 block opacity-70">
                  What was this transaction for? Include any relevant context (site work, repair
                  reason, event, etc.).
                </span>
                <textarea
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
                />
              </label>

              <div className="mt-2 text-xs opacity-80">
                Equipment{' '}
                <span className="text-amber-300">
                  (required — pick one or more, describe one that isn’t listed, or “Not
                  equipment-related”)
                </span>
                <label className="mt-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={notEquipmentRelated}
                    onChange={(e) => chooseNotEquipmentRelated(e.target.checked)}
                  />
                  <span>Not equipment-related</span>
                </label>
                {/* Amendment 9 (§2.2) — the ESCAPE HATCH. Third mutually exclusive
                    option, for the asset the registry does not carry (C-28: the
                    ADR-0062 seed is a coarse jurisdiction mapping with no real DR3
                    Eugene facility). The alternative it replaces is an approver
                    quietly picking a wrong asset or ticking "not equipment-related"
                    — a mis-filing with no trace. */}
                <label className="mt-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={equipmentNotListed}
                    onChange={(e) => chooseEquipmentNotListed(e.target.checked)}
                    data-testid="ap-equipment-not-listed"
                  />
                  <span>Equipment not in list — describe it</span>
                </label>
                {equipmentNotListed && (
                  <div className="mt-1 rounded border border-dr3-cyan/40 bg-dr3-cyan/10 p-2">
                    <p className="opacity-90">
                      Describe the equipment as specifically as you can — type, make/model if known,
                      unit number or the nickname the crew uses, and which site it lives at. Morena
                      and Rick will add it to the fleet properly.
                    </p>
                    <textarea
                      value={equipmentDescription}
                      onChange={(e) => setEquipmentDescription(e.target.value)}
                      rows={3}
                      maxLength={2000}
                      placeholder="e.g. Yellow Hyster forklift, unit 7 — the one the crew calls “Big Bird” — lives at Woodland"
                      className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
                      data-testid="ap-equipment-description"
                    />
                  </div>
                )}
                {!notEquipmentRelated && !equipmentNotListed && (
                  <>
                    <input
                      value={equipmentQuery}
                      onChange={(e) => setEquipmentQuery(e.target.value)}
                      placeholder="Search equipment…"
                      className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
                    />
                    <div className="mt-1 max-h-40 overflow-auto rounded border border-white/10">
                      {equipmentOptions.length === 0 && (
                        <p className="px-2 py-1 opacity-60">
                          No active equipment registered. Describe it above instead of guessing, or
                          Hold the invoice.
                        </p>
                      )}
                      {equipmentOptions
                        .filter((o) =>
                          o.displayName.toLowerCase().includes(equipmentQuery.trim().toLowerCase()),
                        )
                        .map((o) => (
                          <label
                            key={o.id}
                            className="flex items-center gap-2 px-2 py-1 hover:bg-white/5"
                          >
                            <input
                              type="checkbox"
                              checked={equipmentIds.includes(o.id)}
                              onChange={() => toggleEquipment(o.id)}
                            />
                            <span>
                              {o.displayName}{' '}
                              <span className="opacity-50">
                                · {o.category}
                                {o.siteCode ? ` · ${o.siteCode}` : ''}
                              </span>
                            </span>
                          </label>
                        ))}
                    </div>
                    {equipmentIds.length > 0 && (
                      <p className="mt-1 opacity-70">{equipmentIds.length} selected</p>
                    )}
                  </>
                )}
              </div>

              {/* D-M5-4 — RED variance banner + block-until-acknowledged gate. */}
              {varianceTripped && variance?.evaluation && (
                <div className="mt-3 rounded border border-red-500 bg-red-600/20 p-3 text-sm text-red-100">
                  <p className="font-bold">
                    ⚠ VARIANCE FLAG — {variance.vendorDisplayName} usually bills{' '}
                    {dollars(variance.evaluation.meanAmountCents)} (avg from{' '}
                    {variance.evaluation.invoiceCount} invoices, last 12 months).
                  </p>
                  <p className="mt-1">
                    This invoice is ${confirmedAmount}, a{' '}
                    {variance.evaluation.direction === 'over' ? 'increase' : 'decrease'} of{' '}
                    {dollars(variance.evaluation.varianceAbsCents)} (
                    {(variance.evaluation.variancePct * 100).toFixed(1)}%).
                  </p>
                  {variance.recent && variance.recent.length > 0 && (
                    <p className="mt-1 opacity-90">
                      Recent:{' '}
                      {variance.recent
                        .map((r) => `${r.invoiceDate} ${dollars(r.amountCents)}`)
                        .join(' · ')}
                    </p>
                  )}
                  <label className="mt-2 block">
                    Acknowledgment note (optional — e.g. “confirmed with Morena”)
                    <input
                      value={varianceAckNote}
                      onChange={(e) => setVarianceAckNote(e.target.value)}
                      className="mt-1 w-full rounded border border-red-400/40 bg-black/30 px-2 py-1 text-red-50"
                    />
                  </label>
                  <button
                    onClick={() => setVarianceAck(true)}
                    disabled={varianceAck}
                    className="mt-2 rounded bg-red-500 px-3 py-1.5 font-semibold text-white disabled:opacity-60"
                  >
                    {varianceAck ? '✓ Variance verified' : 'I’ve verified the variance'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Single reason/note — Reject / Hold / NOT-DR3 (unchanged single-field pattern). */}
          <label className="mt-3 block text-xs opacity-80">
            Reason / note{' '}
            <span className="opacity-70">
              {isRealSite
                ? '(required to Reject or Hold · appears on the returned invoice)'
                : '(required — NOT-DR3 reason, or rejection/hold reason · appears on the returned invoice)'}
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder={
                detail.status === 'pending_review'
                  ? 'Reason to reject, or update the hold note'
                  : 'Reason to reject or hold (or the NOT-DR3 reason)'
              }
              className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => decide('approved')}
              disabled={approveDisabled}
              title={
                approveDisabled && isRealSite
                  ? 'Approve requires vendor, confirmed amount, explanation, an equipment choice, and a variance acknowledgment if flagged'
                  : undefined
              }
              className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => decide('rejected')}
              disabled={busy || !siteCode || !note.trim()}
              title={note.trim() ? undefined : 'A rejection requires a note'}
              className="rounded bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Reject
            </button>
            {detail.status === 'pending' && (
              <button
                onClick={placeHold}
                disabled={busy || !note.trim()}
                title={note.trim() ? undefined : 'A hold requires a note'}
                className="rounded bg-amber-400 px-4 py-2 text-sm font-semibold text-dr3-ink disabled:opacity-50"
              >
                Hold — pending review
              </button>
            )}
            {detail.status === 'pending_review' && (
              <button
                onClick={saveHoldNote}
                disabled={busy || !note.trim()}
                title={note.trim() ? undefined : 'Enter a note to update the hold'}
                className="rounded bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20 disabled:opacity-50"
              >
                Update hold note
              </button>
            )}
          </div>
        </section>
      )}

      {(detail.status === 'approved' || detail.status === 'rejected') && (
        <div className="mt-4">
          <button
            onClick={resend}
            disabled={busy}
            className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-50"
          >
            Re-send decision email
          </button>
        </div>
      )}

      {msg && <p className="mt-3 rounded bg-black/30 px-3 py-2 text-sm">{msg}</p>}
    </div>
  );
}

// ADR-0046 Amendment 5 (D-M5-3) — the $1,000 SECOND-APPROVAL panel. Rendered when a
// request is `pending_second_approval`. Shows the first approver's decision facts
// read-only, then — for the SITE's eligible second approver — Approve (→ approved)
// or Reject (→ rejected override, note required). When the viewer is ALSO the first
// approver (self-fulfillment, decision (c)), a re-confirmation checkbox + a 30-second
// countdown gate the buttons. All of this is advisory: the server re-checks
// eligibility, the reconfirm flag, and the 30s wait before it will commit.
function SecondApprovalPanel({ detail, onDecided }: { detail: Detail; onDecided: () => void }) {
  const sa = detail.secondApproval;
  const [note, setNote] = useState('');
  const [reconfirm, setReconfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [waitMs, setWaitMs] = useState(sa?.selfWaitRemainingMs ?? 0);

  // Count the self-reconfirm wait down to zero (only meaningful on the self path).
  useEffect(() => {
    setWaitMs(sa?.selfWaitRemainingMs ?? 0);
  }, [sa?.selfWaitRemainingMs]);
  useEffect(() => {
    if (waitMs <= 0) return;
    const t = setInterval(() => setWaitMs((ms) => Math.max(0, ms - 1000)), 1000);
    return () => clearInterval(t);
  }, [waitMs]);

  const isSelf = !!sa?.isFirstApprover;
  const waitSec = Math.ceil(waitMs / 1000);
  const gated = isSelf && (waitMs > 0 || !reconfirm);

  const submit = useCallback(
    async (decision: 'approved' | 'rejected') => {
      if (decision === 'rejected' && !note.trim()) {
        setMsg(
          'A second-approval rejection needs a note explaining why the first approval is being overridden.',
        );
        return;
      }
      if (isSelf && !reconfirm) {
        setMsg(
          'You are both approvers — check the re-confirmation box to fulfill the second approval.',
        );
        return;
      }
      setBusy(true);
      setMsg(null);
      try {
        const res = await fetch(`/api/ops/ap/${detail.id}/second-approval`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision,
            ...(decision === 'rejected' ? { note: note.trim() } : {}),
            ...(isSelf ? { reconfirm: true } : {}),
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.alreadyDecided)
          setMsg(`This request was ${body.error}. Refreshing.`);
        else if (!res.ok) setMsg(body.error ?? `second approval failed (${res.status})`);
        else if (decision === 'approved')
          setMsg(
            'Second approval confirmed — the invoice is APPROVED and the decision was emailed to accounting.',
          );
        else
          setMsg(
            'First approval OVERRIDDEN — the invoice is REJECTED; the first approver was CC’d on the rejection.',
          );
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'second approval failed');
      } finally {
        setBusy(false);
        onDecided();
      }
    },
    [note, isSelf, reconfirm, detail.id, onDecided],
  );

  return (
    <section className="mt-5 border-t border-white/10 pt-4">
      <div className="rounded border border-violet-400/60 bg-violet-400/10 px-3 py-2 text-sm">
        <span className="font-semibold text-violet-200">AWAITING SECOND APPROVAL (≥ $1,000)</span>
        {detail.firstApproverName && (
          <span className="opacity-90"> · first-approved by {detail.firstApproverName}</span>
        )}
        {detail.firstApprovedAt && (
          <span className="opacity-70"> · {fmt(detail.firstApprovedAt)}</span>
        )}
      </div>

      {/* First approver's decision facts — read-only context for the second approver. */}
      <div className="mt-3 rounded border border-white/10 bg-white/5 p-3 text-sm">
        <h3 className="text-sm font-semibold opacity-90">First approver’s decision</h3>
        <ul className="mt-1 space-y-0.5 opacity-90">
          {detail.vendorFreeform && <li>Vendor: {detail.vendorFreeform}</li>}
          {detail.confirmedAmountCents !== null && (
            <li>Amount: {dollars(detail.confirmedAmountCents)}</li>
          )}
          {detail.explanation && <li>Explanation: {detail.explanation}</li>}
          {detail.equipmentLinks.length > 0 &&
            (() => {
              // Amendment 9 — three dispositions, exactly one of which is set.
              const hatch = detail.equipmentLinks.find((l) => l.equipmentRequest);
              if (hatch?.equipmentRequest) {
                return (
                  <li>
                    Equipment: described (not in the fleet list) — “
                    {hatch.equipmentRequest.description}”
                    <span className="opacity-70"> · request {hatch.equipmentRequest.status}</span>
                  </li>
                );
              }
              return (
                <li>
                  Equipment:{' '}
                  {detail.equipmentLinks.some((l) => l.isNotEquipmentRelated)
                    ? 'Not equipment-related'
                    : detail.equipmentLinks.map((l) => l.displayName ?? '(unknown)').join(', ')}
                </li>
              );
            })()}
          {detail.varianceFlagState === 'acknowledged' && (
            <li className="text-amber-200">
              ⚠ Variance acknowledged
              {detail.varianceAcknowledgmentNote ? ` — ${detail.varianceAcknowledgmentNote}` : ''}
            </li>
          )}
        </ul>
      </div>

      {sa?.eligible ? (
        <div className="mt-3">
          {isSelf && (
            <div className="rounded border border-amber-400/60 bg-amber-400/15 p-3 text-sm">
              <p className="font-semibold text-amber-200">
                You are both the first and second approver on this invoice.
              </p>
              <p className="mt-1 opacity-90">
                Please re-review the decision above, then re-confirm below. A 30-second pause is
                required before you can self-fulfill.
              </p>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={reconfirm}
                  onChange={(e) => setReconfirm(e.target.checked)}
                />
                <span>I have re-reviewed and re-confirm this decision.</span>
              </label>
              {waitMs > 0 && (
                <p className="mt-1 text-amber-200">Please wait {waitSec}s before confirming…</p>
              )}
            </div>
          )}

          <label className="mt-3 block text-xs opacity-80">
            Rejection note{' '}
            <span className="opacity-70">(required only to Reject — explains the override)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Why is the first approval being overridden?"
              className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm text-white"
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => submit('approved')}
              disabled={busy || gated}
              title={
                gated ? 'Re-confirm and wait out the 30-second pause to self-fulfill' : undefined
              }
              className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Confirm second approval
            </button>
            <button
              onClick={() => submit('rejected')}
              disabled={busy || !note.trim() || gated}
              title={note.trim() ? undefined : 'A rejection requires a note'}
              className="rounded bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Reject (override)
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded bg-black/30 px-3 py-2 text-sm opacity-80">
          This invoice is waiting for its site’s designated second approver to confirm or override.
          You are not the second approver for this site.
        </p>
      )}

      {msg && <p className="mt-3 rounded bg-black/30 px-3 py-2 text-sm">{msg}</p>}
    </section>
  );
}

// ADR-0046 Amendment 4/6 — inline preview render rules. The inline predicates are
// the SHARED `inline-preview` helpers (same code the server route decides with, so
// the two can't drift): they strip MIME params and fall back to the filename
// extension for mislabeled octet-stream/empty types. The server is authoritative and
// signs the inline URL (with a canonical Content-Type) only for these; anything past
// the cap opens in a new tab instead of framing.
const PREVIEW_SIZE_CAP = 15 * 1024 * 1024; // 15 MB

// iOS/iPadOS Safari (WebKit) has NO inline <iframe> PDF viewer — a framed PDF renders
// BLANK on the Eugene iPad. Detect it so the PDF preview surfaces a prominent
// tap-to-open action instead of a dead frame. Covers iPadOS 13+, which masquerades as
// desktop macOS (MacIntel) but reports touch points. Client-only (this block never
// renders during SSR/hydration — it appears only after a user taps Preview).
const isIosWebkit = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return (
    /iP(hone|od|ad)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
};

interface Presigned {
  url: string;
  inline: boolean;
  contentType: string | null;
  // ADR-0046 Amendment 6 — freshness: when the cached URL was minted (client clock)
  // and the server-declared TTL, so `resolve()` re-mints before R2 expiry instead of
  // serving a stale URL (→ R2 403 → blank iframe / dead download).
  mintedAt: number;
  expiresIn: number;
}

function AttachmentRow({ requestId, att }: { requestId: string; att: AttachmentView }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [presigned, setPresigned] = useState<Presigned | null>(null);

  // Fetch + cache the short-lived presigned URL. ADR-0046 Amendment 6: reuse the
  // cache only while FRESH; re-mint once within the skew of expiry so a re-expand or
  // read-then-download minutes later never hits an expired (403) URL.
  const resolve = useCallback(async (): Promise<Presigned | null> => {
    if (presigned && !isPresignStale(presigned.mintedAt, presigned.expiresIn)) return presigned;
    const res = await fetch(`/api/ops/ap/${requestId}/attachment/${att.id}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.url) {
      const p: Presigned = {
        url: body.url,
        inline: !!body.inline,
        contentType: body.contentType ?? att.contentType,
        mintedAt: Date.now(),
        expiresIn:
          typeof body.expiresIn === 'number' ? body.expiresIn : AP_ATTACHMENT_URL_TTL_SECONDS,
      };
      setPresigned(p);
      return p;
    }
    setErr(body.error ?? `download failed (${res.status})`);
    return null;
  }, [presigned, requestId, att.id, att.contentType]);

  const open = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await resolve();
      if (p) window.open(p.url, '_blank', 'noopener');
    } finally {
      setBusy(false);
    }
  }, [resolve]);

  // Collapse/expand the in-panel preview (so many attachments don't all render at
  // once). On first expand, resolve the URL; if the server declined inline (or the
  // file is over the cap), fall back to opening it in a new tab.
  const togglePreview = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const p = await resolve();
      if (p && p.inline) setExpanded(true);
      else if (p) window.open(p.url, '_blank', 'noopener');
    } finally {
      setBusy(false);
    }
  }, [expanded, resolve]);

  if (att.kind === 'reference_link') {
    return (
      <li className="rounded border border-white/10 bg-white/5 px-2 py-1">
        🔗 Reference link: {att.filename ?? 'link'} —{' '}
        {att.linkUrl ? (
          <a
            href={att.linkUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline"
          >
            open in SharePoint/OneDrive
          </a>
        ) : (
          '(no url)'
        )}
        <span className="ml-1 opacity-60">(Vision never fetches this)</span>
      </li>
    );
  }
  if (att.kind === 'nested_message') {
    return (
      <li className="rounded border border-white/10 bg-white/5 px-2 py-1">
        ✉️ Nested message: {att.nestedSubject ?? att.filename ?? '(forwarded message)'}
      </li>
    );
  }
  const previewable = isInlinePreviewable(att.contentType, att.filename);
  const oversize = att.byteSize != null && att.byteSize > PREVIEW_SIZE_CAP;
  return (
    <li className="rounded border border-white/10 bg-white/5 px-2 py-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="truncate">
          📄 {att.filename ?? 'attachment'} {att.byteSize ? `(${att.byteSize} bytes)` : ''}
        </span>
        {previewable && !oversize && (
          <button onClick={togglePreview} disabled={busy} className="underline disabled:opacity-50">
            {expanded ? 'Hide preview' : 'Preview'}
          </button>
        )}
        {previewable && oversize && (
          <button onClick={open} disabled={busy} className="underline disabled:opacity-50">
            Preview large file →
          </button>
        )}
        <button onClick={open} disabled={busy} className="underline disabled:opacity-50">
          download
        </button>
        {err && <span className="text-red-300">{err}</span>}
      </div>
      {expanded && presigned?.inline && (
        <div className="mt-2">
          {isInlineImage(presigned.contentType, att.filename) ? (
            // Presigned R2 image preview; Next/Image can't sign/proxy R2 GETs.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={presigned.url}
              alt={att.filename ?? 'attachment preview'}
              className="max-h-[32rem] w-auto max-w-full rounded border border-white/10 bg-white"
            />
          ) : isInlinePdf(presigned.contentType, att.filename) ? (
            // iPad Safari (WebKit) renders a framed PDF BLANK. ALWAYS surface a
            // prominent, touch-sized "Open PDF" action so the approver can read the
            // invoice on the iPad. On iOS that action REPLACES the (blank) iframe; on
            // desktop it rides above Chromium's working inline viewer.
            <div>
              <button
                onClick={open}
                disabled={busy}
                className="mb-2 inline-flex w-full items-center justify-center rounded-md border border-white/25 bg-white/10 px-4 py-3 text-base font-semibold hover:bg-white/20 disabled:opacity-50 sm:w-auto"
              >
                Open PDF in new tab ↗
              </button>
              {!isIosWebkit() && (
                // No sandbox="" here: a full sandbox kills Chromium's built-in PDF
                // viewer. The frame is cross-origin (R2) and cannot script our origin;
                // CSP frame-src scopes it to the R2 host (ADR-0046 Amendment 4).
                <iframe
                  src={presigned.url}
                  title={att.filename ?? 'attachment preview'}
                  className="h-[32rem] w-full rounded border border-white/10 bg-white"
                />
              )}
            </div>
          ) : (
            // Any other inline type — keep the plain frame.
            <iframe
              src={presigned.url}
              title={att.filename ?? 'attachment preview'}
              className="h-[32rem] w-full rounded border border-white/10 bg-white"
            />
          )}
        </div>
      )}
    </li>
  );
}
