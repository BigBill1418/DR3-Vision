// ADR-0063 — admin equipment master: canonical serializer for the list's view
// state. Mirrors the ADR-0017 Amendment 1 contract established by
// `src/app/admin/users/list-url.ts`.
//
// The list's filters live entirely in the URL (`?site=&category=&status=&q=`)
// — "the URL IS the state". That contract only holds if every navigation AWAY
// from the list and BACK carries the query string with it. The users list
// shipped without that and silently dropped a Woodland-scoped view back to the
// unfiltered list on every create/edit save; PR #176 fixed it. This module
// exists so the equipment surface is born with the fix rather than repeating
// the bug.
//
// DELIBERATELY A SIBLING, NOT A GENERALISATION (ADR-0063 D5). The param sets
// differ (`role` vs `category` + `q`) and each surface's whitelist is
// intentionally its own closed set — a shared generic would need a
// schema-descriptor argument that reads worse at both call sites than the
// duplication buys. Function names are kept structurally identical to the
// users module so a future extraction is mechanical.

// Imported from the pure-data constants module, NOT from `@/lib/admin-equipment`
// — this file is pulled in by client components, and a value import from the
// data layer would drag Prisma into the browser bundle.
import { EQUIPMENT_CATEGORIES, type EquipmentCategoryValue } from '@/app/admin/constants';

export const CATEGORIES = EQUIPMENT_CATEGORIES;
export const STATUSES = ['active', 'inactive', 'all'] as const;

export type CategoryFilter = EquipmentCategoryValue;
export type StatusFilter = (typeof STATUSES)[number];

/** Longest `?q=` we round-trip. Anything past this is user error, not a query. */
export const SEARCH_MAX = 100;

/** Raw `searchParams` shape shared by the list, create and edit pages. */
export interface EquipmentListSearchParams {
  site?: string;
  category?: string;
  status?: string;
  q?: string;
}

/** The parsed, validated view state. `site` stays a site *code*, not an id. */
export interface EquipmentListParams {
  site: string | undefined;
  category: CategoryFilter | undefined;
  status: StatusFilter;
  q: string | undefined;
}

export function parseCategory(v: string | undefined): CategoryFilter | undefined {
  return v && (CATEGORIES as readonly string[]).includes(v) ? (v as CategoryFilter) : undefined;
}

export function parseStatus(v: string | undefined): StatusFilter {
  return v && (STATUSES as readonly string[]).includes(v) ? (v as StatusFilter) : 'active';
}

/**
 * Trim and length-clamp a search term. Whitespace-only collapses to
 * `undefined` so a stray space never pins the list to an empty result set and
 * never rides along in the round-trip query string.
 */
export function parseSearch(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t.slice(0, SEARCH_MAX) : undefined;
}

/**
 * Whitelist the list-view params out of an arbitrary `searchParams` bag.
 *
 * Deliberately a whitelist: the create/edit pages hand whatever they were
 * given straight back into a `router.push`, so passing arbitrary params
 * through would let an unexpected key ride the round trip. Only the four
 * filter keys survive, and only with values the list itself accepts.
 *
 * `site` is NOT validated against the live site table here (that needs a DB
 * read); an unknown code round-trips harmlessly and the list resolves it to
 * "no site filter" via its `siteByCode` lookup.
 */
export function pickEquipmentListParams(
  sp: EquipmentListSearchParams | undefined,
): EquipmentListParams {
  return {
    site: sp?.site || undefined,
    category: parseCategory(sp?.category),
    status: parseStatus(sp?.status),
    q: parseSearch(sp?.q),
  };
}

/**
 * Serialize view state back into an `/admin/equipment` href.
 *
 * `status=active` is the list's default and is omitted so the canonical
 * "no filters" URL stays the bare path.
 */
export function buildEquipmentListHref(params: EquipmentListParams): string {
  const sp = new URLSearchParams();
  if (params.site) sp.set('site', params.site);
  if (params.category) sp.set('category', params.category);
  if (params.status !== 'active') sp.set('status', params.status);
  if (params.q) sp.set('q', params.q);
  const qs = sp.toString();
  return qs ? `/admin/equipment?${qs}` : '/admin/equipment';
}

/**
 * The same params as a bare query string (no leading `?`), for appending to a
 * sub-route such as `/admin/equipment/new` or `/admin/equipment/<id>`.
 */
export function buildEquipmentListQuery(params: EquipmentListParams): string {
  const href = buildEquipmentListHref(params);
  const i = href.indexOf('?');
  return i === -1 ? '' : href.slice(i + 1);
}

/** Append the current view state to a sub-route path. */
export function withEquipmentListQuery(path: string, params: EquipmentListParams): string {
  const qs = buildEquipmentListQuery(params);
  return qs ? `${path}?${qs}` : path;
}
