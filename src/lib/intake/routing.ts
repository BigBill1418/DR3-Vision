// ADR-0045 D3 — contact-route matching.
//
// First ACTIVE route (by ascending priority) whose `topic_match` matches the
// submission's topic wins. `topic_match` supports: exact (case-insensitive), a
// `*`-suffix glob (`tour*` → any topic starting "tour"), and the catch-all `*`.
// The seeded routes are `tour* → Rick` (priority 10) and `* → Morena` (1000), so
// a tour always beats the default. The default `*` guarantees every submission
// routes somewhere (D4: a lost lead is a task, not an outage).

import { prisma } from '@/lib/prisma';

export interface RouteRule {
  id: string;
  topicMatch: string;
  routeToEmail: string;
  priority: number;
}

/** Does a single rule's pattern match this topic? Pure. */
export function matchesTopic(pattern: string, topic: string): boolean {
  const p = pattern.trim().toLowerCase();
  const t = topic.trim().toLowerCase();
  if (p === '*') return true;
  if (p.endsWith('*')) return t.startsWith(p.slice(0, -1));
  return p === t;
}

/** First matching active rule by ascending priority. Pure over a rule list. */
export function resolveRouteFrom(rules: RouteRule[], topic: string): RouteRule | null {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const r of ordered) {
    if (matchesTopic(r.topicMatch, topic)) return r;
  }
  return null;
}

/** Load active routes and resolve the topic against them. */
export async function resolveRoute(topic: string): Promise<RouteRule | null> {
  const rows = await prisma.contactRoute.findMany({
    where: { active: true },
    orderBy: { priority: 'asc' },
    select: { id: true, topic_match: true, route_to_email: true, priority: true },
  });
  const rules: RouteRule[] = rows.map((r) => ({
    id: r.id,
    topicMatch: r.topic_match,
    routeToEmail: r.route_to_email,
    priority: r.priority,
  }));
  return resolveRouteFrom(rules, topic);
}
