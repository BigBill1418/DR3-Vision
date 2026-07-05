import { describe, expect, it } from 'vitest';
import { matchesTopic, resolveRouteFrom, type RouteRule } from './routing';

const rules: RouteRule[] = [
  { id: 'r-tour', topicMatch: 'tour*', routeToEmail: 'rick.albritton@svdp.us', priority: 10 },
  { id: 'r-default', topicMatch: '*', routeToEmail: 'morena.gomez@svdp.us', priority: 1000 },
];

describe('matchesTopic', () => {
  it('exact match is case-insensitive', () => {
    expect(matchesTopic('Donation', 'donation')).toBe(true);
    expect(matchesTopic('donation', 'DONATION ')).toBe(true);
    expect(matchesTopic('donation', 'tour')).toBe(false);
  });
  it('suffix glob matches a prefix', () => {
    expect(matchesTopic('tour*', 'Tour Request')).toBe(true);
    expect(matchesTopic('tour*', 'tours')).toBe(true);
    expect(matchesTopic('tour*', 'donation')).toBe(false);
  });
  it('catch-all matches anything', () => {
    expect(matchesTopic('*', 'literally anything')).toBe(true);
  });
});

describe('resolveRouteFrom — first active match by priority', () => {
  it('routes a tour to Rick (lower priority wins over the catch-all)', () => {
    expect(resolveRouteFrom(rules, 'Tour of facility')?.routeToEmail).toBe('rick.albritton@svdp.us');
  });
  it('routes everything else to the default (Morena)', () => {
    expect(resolveRouteFrom(rules, 'Donation question')?.routeToEmail).toBe('morena.gomez@svdp.us');
  });
  it('priority ordering is respected regardless of input order', () => {
    const reversed = [...rules].reverse();
    expect(resolveRouteFrom(reversed, 'tour today')?.id).toBe('r-tour');
  });
  it('returns null when nothing matches (no default configured)', () => {
    const noDefault = rules.filter((r) => r.topicMatch !== '*');
    expect(resolveRouteFrom(noDefault, 'donation')).toBeNull();
  });
});
