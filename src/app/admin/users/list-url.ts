// ADR-0017 — admin Settings panel: canonical serializer for the user-list
// view state.
//
// The user list's filters live entirely in the URL (`?site=&role=&status=`)
// — "the URL IS the state" (see `page.tsx` Filters). That contract only
// holds if every navigation AWAY from the list and BACK carries the query
// string with it. Before this module the create/edit round trip pushed a
// bare `/admin/users`, which silently dropped the admin's working view
// (e.g. a Woodland-scoped list) back to the unfiltered all-users list.
//
// One serializer, one parser, used by the list page and by every surface
// that needs to return to it.

export const ROLES = ['operator', 'manager', 'admin'] as const;
export const STATUSES = ['active', 'inactive', 'all'] as const;

export type RoleFilter = (typeof ROLES)[number];
export type StatusFilter = (typeof STATUSES)[number];

/** Raw `searchParams` shape shared by the list, create and edit pages. */
export interface UsersListSearchParams {
  site?: string;
  role?: string;
  status?: string;
}

/** The parsed, validated view state. `site` stays a site *code*, not an id. */
export interface UsersListParams {
  site: string | undefined;
  role: RoleFilter | undefined;
  status: StatusFilter;
}

export function parseRole(v: string | undefined): RoleFilter | undefined {
  return v && (ROLES as readonly string[]).includes(v) ? (v as RoleFilter) : undefined;
}

export function parseStatus(v: string | undefined): StatusFilter {
  return v && (STATUSES as readonly string[]).includes(v) ? (v as StatusFilter) : 'active';
}

/**
 * Whitelist the list-view params out of an arbitrary `searchParams` bag.
 *
 * Deliberately a whitelist: the create/edit pages hand whatever they were
 * given straight back into a `router.push`, so passing arbitrary params
 * through would let an unexpected key ride the round trip. Only the three
 * filter keys survive, and only with values the list itself accepts.
 *
 * Note `site` is NOT validated against the live site table here (that needs
 * a DB read); an unknown code round-trips harmlessly and the list resolves
 * it to "no site filter" via its `siteByCode` lookup.
 */
export function pickUsersListParams(sp: UsersListSearchParams | undefined): UsersListParams {
  return {
    site: sp?.site || undefined,
    role: parseRole(sp?.role),
    status: parseStatus(sp?.status),
  };
}

/**
 * Serialize view state back into a `/admin/users` href.
 *
 * `status=active` is the list's default and is omitted so the canonical
 * "no filters" URL stays the bare path.
 */
export function buildUsersListHref(params: UsersListParams): string {
  const sp = new URLSearchParams();
  if (params.site) sp.set('site', params.site);
  if (params.role) sp.set('role', params.role);
  if (params.status !== 'active') sp.set('status', params.status);
  const qs = sp.toString();
  return qs ? `/admin/users?${qs}` : '/admin/users';
}

/**
 * The same params as a bare query string (no leading `?`), for appending to
 * a sub-route such as `/admin/users/new` or `/admin/users/<id>`.
 */
export function buildUsersListQuery(params: UsersListParams): string {
  const href = buildUsersListHref(params);
  const i = href.indexOf('?');
  return i === -1 ? '' : href.slice(i + 1);
}

/** Append the current view state to a sub-route path. */
export function withUsersListQuery(path: string, params: UsersListParams): string {
  const qs = buildUsersListQuery(params);
  return qs ? `${path}?${qs}` : path;
}
