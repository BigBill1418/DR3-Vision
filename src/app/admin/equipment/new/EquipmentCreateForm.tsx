'use client';

// ADR-0063 / ADR-0135 D — the STRUCTURED "new asset" form.
//
// CLAUDE.md hard rule #10 — no `<form>` element, no submit handler; everything
// posts via `onClick`.
//
// Nobody types a name any more. The person says what the asset IS — type, unit
// number, make, optional details and VIN/serial — and the name is GENERATED with
// the seed's `<unit> — <make> <details> <type>` convention by `generateDisplayName`,
// the same function the server runs. Five naming styles for one kind of trailer
// (ADR-0135 §2 hole 5) cannot happen when there is no name field to type into.
//
// Contracts inherited from ADR-0017 Amendment 1, still load-bearing:
//   1. save AND cancel return to `backHref` — the list WITH the admin's filters;
//   2. the site select seeds from the list's `?site=` filter, not `sites[0]`
//      (`sites[0]` is always DR3 Eugene; defaulting to it would file a
//      Woodland-scoped create at Eugene — a hard-rule-#2 defect).
//
// ADR-0135 C — the server REFUSES a create that probably duplicates a live asset
// (409 `probable_duplicate`). That refusal is a fork, not a wall: the matches are
// shown with "Use this one" (when the caller can resolve against an existing
// asset), and "It's a different asset" resubmits with a written reason and EVERY
// match id the person was shown — the server re-checks that the list is complete
// (`override_incomplete` otherwise). A `name_taken` / `vin_taken` refusal is NOT
// overridable: two live assets cannot share a name or a VIN.

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { EquipmentCategory } from '@prisma/client';
// Pure-data modules only — a value import from `@/lib/admin-equipment` would
// pull Prisma into the client bundle.
import {
  ASSET_TYPES,
  DETAILS_MAX,
  MAKE_MAX,
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
  UNIT_NUMBER_MAX,
  VIN_SERIAL_MAX,
  assetTypeDef,
} from '@/app/admin/constants';
import { adminMessages as M } from '@/app/admin/messages';
import { generateDisplayName, unitKey } from '@/lib/equipment/match';
import { FLEET_SITE_CODE } from '../list-url';

interface SiteOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  sites: SiteOption[];
  /** Where save/cancel return to — the list *with the admin's filters*. */
  backHref?: string | undefined;
  /** Site code the list was filtered to (or `fleet`), if any. Seeds the site select. */
  initialSiteCode?: string | undefined;
  /** Category the list was filtered to, if any. Seeds the type select with its first type. */
  initialCategory?: EquipmentCategory | undefined;
  /** ADR-0135 E — the approver's structured request pre-fills these. */
  initialAssetType?: string | undefined;
  initialUnitNumber?: string | undefined;
  initialMake?: string | undefined;

  // ── ADR-0046 Amendment 9 (§2.5) — reuse hooks ──────────────────────────────
  // The equipment-request worklist resolves a request by registering the asset
  // through THIS form, posted at the resolve endpoint. One form, one validation.
  /** POST target. Defaults to the plain admin create endpoint. */
  endpoint?: string | undefined;
  /** Extra fields merged into the POST body (e.g. the resolve action + backfill flag). */
  extraBody?: Record<string, unknown> | undefined;
  /** Called on success INSTEAD of navigating to `backHref`. */
  onSaved?: (() => void) | undefined;
  /** Overrides the submit button label. */
  submitLabel?: string | undefined;

  // ── ADR-0075 / ADR-0135 — the collision fork ───────────────────────────────
  /**
   * Resolve against an asset that already exists instead of creating one. Only
   * a caller that HAS somewhere to send that choice (the equipment-request
   * worklist) passes it; without it the matches are shown read-only.
   */
  onUseExisting?: ((equipmentId: string, isActive: boolean) => void | Promise<void>) | undefined;
  /**
   * GET endpoint for the debounced "already in the fleet?" lookup, called as
   * `${similarEndpoint}?q=<generated name>&unit=&vin=&type=`. Absent = no lookup.
   */
  similarEndpoint?: string | undefined;
}

/** One candidate row, as returned by the API's `existing[]` (`SimilarEquipment`). */
interface SimilarRow {
  id: string;
  displayName: string;
  category: string;
  /** null = fleet-wide. */
  siteCode: string | null;
  isActive: boolean;
  mergedIntoId: string | null;
}

interface Collision {
  code: string;
  rows: SimilarRow[];
}

/** The two refusals a person may override with a reason. */
const OVERRIDABLE = new Set(['probable_duplicate', 'override_incomplete']);

/** Debounce for the "already in the fleet?" lookup. */
const SIMILAR_DEBOUNCE_MS = 350;

const INPUT_CLASS =
  'rounded-md border border-dr3-steel-light/30 bg-dr3-space-2 px-3 py-2 text-dr3-mist placeholder:text-dr3-mist-dim focus:outline-none focus:ring-2 focus:ring-dr3-cyan';

const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

function initialSite(sites: SiteOption[], code: string | undefined): string {
  if (code === FLEET_SITE_CODE) return FLEET_SITE_CODE;
  return sites.find((s) => s.code === code)?.id ?? sites[0]?.id ?? FLEET_SITE_CODE;
}

function initialType(assetType?: string, category?: EquipmentCategory): string {
  if (assetTypeDef(assetType)) return assetType as string;
  return ASSET_TYPES.find((t) => t.category === category)?.value ?? '';
}

export function EquipmentCreateForm({
  sites,
  backHref = '/admin/equipment',
  initialSiteCode,
  initialCategory,
  initialAssetType,
  initialUnitNumber,
  initialMake,
  endpoint = '/api/admin/equipment',
  extraBody,
  onSaved,
  submitLabel,
  onUseExisting,
  similarEndpoint,
}: Props) {
  const router = useRouter();
  const [assetType, setAssetType] = useState(() => initialType(initialAssetType, initialCategory));
  const [unitNumber, setUnitNumber] = useState(initialUnitNumber ?? '');
  const [make, setMake] = useState(initialMake ?? '');
  const [details, setDetails] = useState('');
  const [vinSerial, setVinSerial] = useState('');
  const [site, setSite] = useState(() => initialSite(sites, initialSiteCode));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The server's refusal, with the rows it refused on. */
  const [collision, setCollision] = useState<Collision | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [reason, setReason] = useState('');
  /** Passive "heads up, this may already exist" hits, from the debounced lookup. */
  const [similar, setSimilar] = useState<SimilarRow[]>([]);

  const def = assetTypeDef(assetType);
  const preview = def
    ? generateDisplayName({ unitNumber, make, details, assetType: def.label })
    : '';
  const lookup = useMemo(
    () => ({ q: preview, unit: tidy(unitNumber), vin: tidy(vinSerial), type: def?.label ?? '' }),
    [preview, unitNumber, vinSerial, def],
  );

  // Debounced fleet-wide lookup. Needs something identifying — a bare type
  // ("Trailer") would match nothing useful.
  useEffect(() => {
    if (!similarEndpoint) return;
    if (!lookup.q || (!lookup.unit && !lookup.vin && !tidy(make))) {
      setSimilar([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const qs = new URLSearchParams(lookup).toString();
          const res = await fetch(`${similarEndpoint}?${qs}`);
          const body = (await res.json().catch(() => ({}))) as { existing?: SimilarRow[] };
          if (!cancelled) setSimilar(res.ok && Array.isArray(body.existing) ? body.existing : []);
        } catch {
          // A failed hint is a non-event; the server gate re-checks on submit.
          if (!cancelled) setSimilar([]);
        }
      })();
    }, SIMILAR_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [lookup, make, similarEndpoint]);

  /** Any edit invalidates a refusal: the server judged DIFFERENT fields. */
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setCollision(null);
    setOverrideOpen(false);
  };

  const validate = (): string | null => {
    if (!def) return M.equipment.assetTypeRequired;
    const unit = tidy(unitNumber).replace(/^#\s*/, '');
    if (!unit && def.unitRequired) return M.equipment.unitNumberRequired;
    if (unit && (unitKey(unit) === '' || /[,;/&\s]/.test(unit))) {
      return M.equipment.unitNumberInvalid;
    }
    if (!site) return M.equipment.siteRequired;
    return null;
  };

  const submit = async (confirmDistinct?: { reason: string; distinctFromIds: string[] }) => {
    setError(null);
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const opt = (v: string) => tidy(v) || undefined;
    setPending(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: site === FLEET_SITE_CODE ? null : site,
          assetType,
          unitNumber: opt(unitNumber),
          make: opt(make),
          details: opt(details),
          vinSerial: opt(vinSerial),
          ...(confirmDistinct ? { confirmDistinct } : {}),
          ...extraBody,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          existing?: SimilarRow[];
        };
        // A refusal that names what it collided with becomes a choice. One with
        // no candidates (the P2002 race backstop) keeps the plain banner.
        if (res.status === 409 && Array.isArray(body.existing) && body.existing.length > 0) {
          setCollision({ code: body.code ?? 'name_taken', rows: body.existing });
          setOverrideOpen(false);
          setError(body.error ?? M.equipment.probableDuplicate);
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

  const reasonOk = tidy(reason).length >= OVERRIDE_REASON_MIN;
  const shown = collision?.rows ?? similar;

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

      {shown.length > 0 && (
        <SimilarBlock rows={shown} onUseExisting={onUseExisting}>
          {collision && OVERRIDABLE.has(collision.code) ? (
            overrideOpen ? (
              <div className="flex flex-col gap-2" data-testid="admin-equipment-override">
                <label className="flex flex-col gap-1 text-sm text-dr3-mist">
                  {M.equipment.differentAssetReasonLabel}
                  <textarea
                    value={reason}
                    rows={2}
                    maxLength={OVERRIDE_REASON_MAX}
                    onChange={(e) => setReason(e.target.value)}
                    className={INPUT_CLASS}
                    data-testid="admin-equipment-override-reason"
                  />
                  <span className="text-xs text-dr3-mist-dim">
                    {M.equipment.overrideReasonRequired}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() =>
                    void submit({
                      reason: tidy(reason),
                      distinctFromIds: collision.rows.map((r) => r.id),
                    })
                  }
                  disabled={pending || !reasonOk}
                  className="self-start rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-dr3-space disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="admin-equipment-override-submit"
                >
                  {M.equipment.differentAssetSubmit}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setOverrideOpen(true)}
                className="self-start text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
                data-testid="admin-equipment-different-asset"
              >
                {M.equipment.differentAsset}
              </button>
            )
          ) : null}
        </SimilarBlock>
      )}

      <Field label={M.equipment.typeLabel} helper={M.equipment.typeHelp}>
        <select
          value={assetType}
          onChange={(e) => edit(setAssetType)(e.target.value)}
          className={INPUT_CLASS}
          data-testid="admin-equipment-create-type"
        >
          <option value="" className="text-dr3-space">
            {M.equipment.typeChoose}
          </option>
          {ASSET_TYPES.map((t) => (
            <option key={t.value} value={t.value} className="text-dr3-space">
              {t.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label={M.equipment.unitLabel}
          helper={def && !def.unitRequired ? M.equipment.unitHelpOptional : M.equipment.unitHelp}
        >
          <input
            type="text"
            value={unitNumber}
            maxLength={UNIT_NUMBER_MAX}
            aria-required={def?.unitRequired ?? true}
            onChange={(e) => edit(setUnitNumber)(e.target.value)}
            className={INPUT_CLASS}
            data-testid="admin-equipment-create-unit"
          />
        </Field>
        <Field label={M.equipment.makeLabel} helper={M.equipment.makeHelp}>
          <input
            type="text"
            value={make}
            maxLength={MAKE_MAX}
            onChange={(e) => edit(setMake)(e.target.value)}
            className={INPUT_CLASS}
            data-testid="admin-equipment-create-make"
          />
        </Field>
        <Field label={M.equipment.detailsLabel} helper={M.equipment.detailsHelp}>
          <input
            type="text"
            value={details}
            maxLength={DETAILS_MAX}
            onChange={(e) => edit(setDetails)(e.target.value)}
            className={INPUT_CLASS}
            data-testid="admin-equipment-create-details"
          />
        </Field>
        <Field label={M.equipment.vinLabel} helper={M.equipment.vinHelp}>
          <input
            type="text"
            value={vinSerial}
            maxLength={VIN_SERIAL_MAX}
            onChange={(e) => edit(setVinSerial)(e.target.value)}
            className={INPUT_CLASS}
            data-testid="admin-equipment-create-vin"
          />
        </Field>
      </div>

      <Field label={M.equipment.siteLabel} helper={M.equipment.siteHelp}>
        <select
          value={site}
          onChange={(e) => edit(setSite)(e.target.value)}
          className={INPUT_CLASS}
          data-testid="admin-equipment-create-site"
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id} className="text-dr3-space">
              {s.name}
            </option>
          ))}
          <option value={FLEET_SITE_CODE} className="text-dr3-space">
            {M.equipment.fleetWide}
          </option>
        </select>
      </Field>

      <p className="text-sm text-dr3-mist" data-testid="admin-equipment-create-preview">
        <span className="text-dr3-mist-dim">{M.equipment.previewLabel}: </span>
        {preview ? (
          <b>{preview}</b>
        ) : (
          <span className="text-dr3-mist-dim">{M.equipment.previewEmpty}</span>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="admin-equipment-create-submit"
        >
          {submitLabel ?? M.equipment.submitCreate}
        </button>
        {onSaved ? null : (
          <button
            type="button"
            onClick={() => router.push(backHref)}
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
            data-testid="admin-equipment-create-cancel"
          >
            {M.equipment.cancel}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The matches, each one clickable when the caller can resolve against it.
 *
 * A merged row is listed but NOT offerable: it is shown so the name it holds
 * stops looking like it vanished, and badged so nobody picks a record that is no
 * longer a thing.
 */
function SimilarBlock({
  rows,
  onUseExisting,
  children,
}: {
  rows: SimilarRow[];
  onUseExisting?: ((equipmentId: string, isActive: boolean) => void | Promise<void>) | undefined;
  children?: React.ReactNode;
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
                · {r.category} · {r.siteCode ?? M.equipment.fleetWideShort}
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
      {children}
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
