'use client';

// ADR-0063 — admin equipment master: create form.
//
// CLAUDE.md hard rule #10 — no `<form>` element, no submit handler; everything
// posts via `onClick`.
//
// Two contracts inherited from ADR-0017 Amendment 1, deliberately built in
// from day one rather than retrofitted:
//   1. save AND cancel return to `backHref` — the list WITH the admin's
//      filters — never a bare `/admin/equipment`;
//   2. the site select seeds from the list's `?site=` filter, not `sites[0]`.
//      `orderBy: { name: 'asc' }` makes `sites[0]` always DR3 Eugene, so
//      creating from a Woodland-scoped list would silently register the asset
//      in Eugene. That is a hard-rule-#2 site-separation defect, not a
//      cosmetic default: the asset would surface in the wrong site's AP
//      approver picker.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { EquipmentCategory } from '@prisma/client';
// Pure-data constants module — a value import from `@/lib/admin-equipment`
// would pull Prisma into the client bundle.
import { DISPLAY_NAME_MAX, EQUIPMENT_CATEGORIES } from '@/app/admin/constants';
import { adminMessages as M } from '@/app/admin/messages';
import { CATEGORY_LABEL } from '../labels';

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  sites: SiteOption[];
  /** Where save/cancel return to — the list *with the admin's filters*. */
  backHref?: string | undefined;
  /** Site code the list was filtered to, if any. Seeds the site select. */
  initialSiteCode?: string | undefined;
  /** Category the list was filtered to, if any. Seeds the category select. */
  initialCategory?: EquipmentCategory | undefined;

  // ── ADR-0046 Amendment 9 (§2.5) — reuse hooks ──────────────────────────────
  // The equipment-request worklist RESOLVES a request by creating the real asset,
  // which is this form, pre-filled from the approver's description. Rebuilding it
  // there would fork the validation, the category list, the site-defaulting rule
  // (the hard-rule-#2 defect this form was careful about) and the styling. These
  // four optional props are the whole seam; nothing about the admin create page
  // changes.
  /** Seeds the name field — the resolver edits the approver's description into a name. */
  initialDisplayName?: string | undefined;
  /** POST target. Defaults to the plain admin create endpoint. */
  endpoint?: string | undefined;
  /** Extra fields merged into the POST body (e.g. the resolve action + backfill flag). */
  extraBody?: Record<string, unknown> | undefined;
  /** Called on success INSTEAD of navigating to `backHref`. */
  onSaved?: (() => void) | undefined;
  /** Overrides the submit button label. */
  submitLabel?: string | undefined;

  // ── ADR-0075 — the collision fork ──────────────────────────────────────────
  // Both optional, and the admin create page passes NEITHER, so its behaviour is
  // byte-identical to before this ADR: no lookups fire, and a 409 renders the
  // same plain banner it always did.
  /**
   * Resolve against an asset that already exists instead of creating one.
   *
   * When absent, a collision still shows the candidates — but read-only, as an
   * explanation of what the name clashed with. Only a caller that HAS somewhere
   * to send that choice (the equipment-request worklist) gets the buttons.
   */
  onUseExisting?: ((equipmentId: string, isActive: boolean) => void | Promise<void>) | undefined;
  /**
   * GET endpoint for the debounced "already in the fleet?" lookup, called as
   * `${similarEndpoint}?siteId=…&name=…`. Absent = no lookup at all.
   */
  similarEndpoint?: string | undefined;
}

/** One candidate row, as returned by the API's `existing[]`. */
interface SimilarRow {
  id: string;
  displayName: string;
  category: string;
  siteCode: string | null;
  isActive: boolean;
  mergedIntoId: string | null;
}

/** Debounce for the similar-name lookup — a typeahead on an admin desktop. */
const SIMILAR_DEBOUNCE_MS = 350;

export function EquipmentCreateForm({
  sites,
  backHref = '/admin/equipment',
  initialSiteCode,
  initialCategory,
  initialDisplayName,
  endpoint = '/api/admin/equipment',
  extraBody,
  onSaved,
  submitLabel,
  onUseExisting,
  similarEndpoint,
}: Props) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialDisplayName ?? '');
  const [category, setCategory] = useState<EquipmentCategory>(initialCategory ?? 'vehicle');
  const [siteId, setSiteId] = useState<string>(
    () => sites.find((s) => s.code === initialSiteCode)?.id ?? sites[0]?.id ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * ADR-0075 D2 — candidates to offer INSTEAD of the name that collided.
   *
   * Separate from `error` on purpose: a collision is not the same kind of event
   * as "the server is down", and rendering it as one is what left the operator
   * with nothing to click. Every OTHER failure still lands in `error` and still
   * renders the plain banner — including a 409 that arrives with no candidates.
   */
  const [collision, setCollision] = useState<SimilarRow[]>([]);
  /** Passive "heads up, this may already exist" hits, from the debounced lookup. */
  const [similar, setSimilar] = useState<SimilarRow[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  // Debounced similar-name lookup. Only ever runs for a caller that supplied an
  // endpoint, so the admin create page issues no requests at all.
  useEffect(() => {
    if (!similarEndpoint || !siteId) return;
    const name = displayName.trim();
    if (!name) {
      setSimilar([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `${similarEndpoint}?siteId=${encodeURIComponent(siteId)}&name=${encodeURIComponent(name)}`,
          );
          const body = (await res.json().catch(() => ({}))) as { existing?: SimilarRow[] };
          if (!cancelled) setSimilar(res.ok && Array.isArray(body.existing) ? body.existing : []);
        } catch {
          // A failed hint is a non-event — it must never block or annoy. The
          // authoritative collision check still happens server-side on submit.
          if (!cancelled) setSimilar([]);
        }
      })();
    }, SIMILAR_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [displayName, siteId, similarEndpoint]);

  const handleSubmit = async () => {
    setError(null);
    setCollision([]);

    const name = displayName.trim();
    if (!name) {
      setError(M.equipment.nameRequired);
      return;
    }
    if (name.length > DISPLAY_NAME_MAX) {
      setError(M.equipment.nameTooLong);
      return;
    }
    if (!siteId) {
      setError(M.equipment.siteRequired);
      return;
    }

    setPending(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `site_id` / `display_name` / `category` are the admin-create contract;
        // the resolve endpoint reads its own camelCase names out of `extraBody`.
        // Both are sent so ONE form body serves both callers.
        body: JSON.stringify({
          site_id: siteId,
          display_name: name,
          category,
          siteId,
          displayName: name,
          ...extraBody,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          existing?: SimilarRow[];
        };
        // ADR-0075 D2 — a collision that names alternatives becomes a choice.
        // Anything else (and a collision with an EMPTY list, e.g. the P2002 race
        // backstop, which has no candidates to offer) keeps the plain banner.
        if (res.status === 409 && Array.isArray(body.existing) && body.existing.length > 0) {
          setCollision(body.existing);
          setError(body.error ?? M.equipment.nameTakenSuggest);
          return;
        }
        setError(body.error ?? M.errors.serverError);
        return;
      }
      if (onSaved) {
        onSaved();
        router.refresh();
        return;
      }
      router.push(backHref);
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-5">
      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="admin-equipment-create-error"
        >
          {error}
        </p>
      ) : null}

      {/* ADR-0075 D2 — the fork. Rendered whenever the server answered a
          collision with candidates; falls back to the passive typeahead hits so
          the near-duplicate is visible BEFORE the submit that would fork it. */}
      {(collision.length > 0 || similar.length > 0) && (
        <SimilarBlock
          rows={collision.length > 0 ? collision : similar}
          {...(onUseExisting ? { onUseExisting } : {})}
          onRename={() => {
            setCollision([]);
            setError(null);
            setDisplayName('');
            nameRef.current?.focus();
          }}
        />
      )}

      <Field label={M.equipment.nameLabel} helper={M.equipment.nameHelp}>
        <input
          ref={nameRef}
          type="text"
          value={displayName}
          maxLength={DISPLAY_NAME_MAX}
          onChange={(e) => setDisplayName(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-create-name"
        />
      </Field>

      <Field label={M.equipment.categoryLabel} helper={M.equipment.categoryHelp}>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as EquipmentCategory)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-create-category"
        >
          {EQUIPMENT_CATEGORIES.map((c) => (
            <option key={c} value={c} className="text-dr3-space">
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </Field>

      <Field label={M.equipment.siteLabel} helper={M.equipment.siteHelp}>
        <select
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          className="rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="admin-equipment-create-site"
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id} className="text-dr3-space">
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="admin-equipment-create-submit"
        >
          {submitLabel ?? M.equipment.submitCreate}
        </button>
        <button
          type="button"
          onClick={() => router.push(backHref)}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          data-testid="admin-equipment-create-cancel"
        >
          {M.equipment.cancel}
        </button>
      </div>
    </section>
  );
}

/**
 * ADR-0075 D2 — the candidates, each one clickable.
 *
 * A merged row is listed but NOT offerable: it is shown so the name it holds
 * stops looking like it vanished, and badged so nobody picks a record that is no
 * longer a thing.
 */
function SimilarBlock({
  rows,
  onUseExisting,
  onRename,
}: {
  rows: SimilarRow[];
  onUseExisting?: ((equipmentId: string, isActive: boolean) => void | Promise<void>) | undefined;
  onRename: () => void;
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3"
      data-testid="admin-equipment-similar"
    >
      <p className="text-sm font-semibold text-amber-200">{M.equipment.similarHeading}</p>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-dr3-space-2/70 px-3 py-2"
            data-testid={`admin-equipment-similar-${r.id}`}
          >
            <span className="text-sm text-dr3-mist">
              {r.displayName}
              <span className="text-dr3-mist-dim">
                {' '}
                · {r.category}
                {r.siteCode ? ` · ${r.siteCode}` : ''}
              </span>
              {r.mergedIntoId ? (
                <span className="ms-2 rounded-full bg-stone-900/60 px-2 py-0.5 text-xs text-stone-300">
                  {M.equipment.mergedBadge}
                </span>
              ) : !r.isActive ? (
                <span className="ms-2 rounded-full bg-stone-900/60 px-2 py-0.5 text-xs text-stone-300">
                  {M.equipment.statusInactive}
                </span>
              ) : null}
            </span>
            {onUseExisting && !r.mergedIntoId ? (
              <button
                type="button"
                onClick={() => void onUseExisting(r.id, r.isActive)}
                className="rounded-md bg-dr3-cyan px-3 py-1 text-xs font-semibold text-dr3-space hover:bg-dr3-cyan-bright"
                data-testid={`admin-equipment-use-existing-${r.id}`}
              >
                {r.isActive ? M.equipment.useExisting : M.equipment.reactivateAndUse}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onRename}
        className="self-start text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        data-testid="admin-equipment-rename-mine"
      >
        {M.equipment.renameMine}
      </button>
    </section>
  );
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-dr3-mist">{label}</span>
      {children}
      {helper ? <span className="text-xs text-dr3-mist-dim">{helper}</span> : null}
    </label>
  );
}
