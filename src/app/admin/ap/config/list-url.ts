// ADR-0017 Amendment 1 (the URL-view-state contract) applied to the ADR-0066
// AP configuration surface.
//
// `/admin/ap/routing` and `/admin/ap/notifications` are two doors into ONE
// screen — Bill's instruction was explicit ("two separate pages for six rows of
// config is worse"). Because they are one surface, the admin's working view has
// to survive the move between them: setting the routing filter to "all" and then
// clicking through to the prefs half must not silently reset it to "active
// only", which is exactly the class of drop Amendment 1 was written about.
//
// One serializer, one parser, used by both routes. Saves never navigate at all
// (`router.refresh()` only), so the query string survives every mutation for
// free — the round trip that needs the serializer is the cross-link between the
// two halves.

import { ROUTING_STATUSES, type RoutingStatusFilter } from '@/lib/ap/admin-config';

/** The two routes that render the combined screen, and which half each anchors. */
export const AP_CONFIG_ROUTES = {
  routing: '/admin/ap/routing',
  notifications: '/admin/ap/notifications',
} as const;

export type ApConfigView = keyof typeof AP_CONFIG_ROUTES;

/** Raw `searchParams` shape shared by both routes. */
export interface ApConfigSearchParams {
  status?: string;
}

/** The parsed, validated view state. */
export interface ApConfigParams {
  status: RoutingStatusFilter;
}

export function parseRoutingStatus(v: string | undefined): RoutingStatusFilter {
  return v && (ROUTING_STATUSES as readonly string[]).includes(v)
    ? (v as RoutingStatusFilter)
    : 'active';
}

/**
 * Whitelist the view params out of an arbitrary `searchParams` bag — a
 * whitelist, not a pass-through, so an unexpected key cannot ride the
 * cross-link between the two halves (Amendment 1's stated rule).
 */
export function pickApConfigParams(sp: ApConfigSearchParams | undefined): ApConfigParams {
  return { status: parseRoutingStatus(sp?.status) };
}

/** Bare query string (no leading `?`). `status=active` is the default and is omitted. */
export function buildApConfigQuery(params: ApConfigParams): string {
  const sp = new URLSearchParams();
  if (params.status !== 'active') sp.set('status', params.status);
  return sp.toString();
}

/** Serialize view state onto one of the two routes. */
export function buildApConfigHref(view: ApConfigView, params: ApConfigParams): string {
  return withApConfigQuery(AP_CONFIG_ROUTES[view], params);
}

/** Append the current view state to any path. */
export function withApConfigQuery(path: string, params: ApConfigParams): string {
  const qs = buildApConfigQuery(params);
  return qs ? `${path}?${qs}` : path;
}
