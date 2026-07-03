import { describe, expect, it } from 'vitest';
import { parseWorkbook } from './parser';
import { recomputeSummary, resolveInboundSites } from './summary-recompute';
import { inMemoryAliasResolver } from './site-alias';
import { buildDriftWorkbook } from './__fixtures__/build-workbook';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow } from '../types';

const config = defaultCheckConfigMap().get('summary_recompute')!;
const window: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-07-01' };

describe('recomputeSummary — sum-range drift (fuel rows 71–130 clipping)', () => {
  it('catches the dropped fuel rows and quantifies the money already lost', async () => {
    const parsed = await parseWorkbook(await buildDriftWorkbook());
    const findings = recomputeSummary(window, parsed, config);

    const fuel = findings.find((f) => (f.detail as { figure?: string }).figure === 'Fuel');
    expect(fuel).toBeDefined();
    expect(fuel!.kind).toBe('dropped_row');
    // stored 600, recomputed 700, delta +100 across 10 clipped rows.
    expect(fuel!.expected).toEqual({ recomputed: 700 });
    expect(fuel!.actual).toEqual({ storedValue: 600 });
    expect(fuel!.detail).toMatchObject({ delta: 100, droppedRowCount: 10, droppedSum: 100 });
  });

  it('does NOT flag the balanced control figure', async () => {
    const parsed = await parseWorkbook(await buildDriftWorkbook());
    const findings = recomputeSummary(window, parsed, config);
    expect(findings.find((f) => (f.detail as { figure?: string }).figure === 'Transport')).toBeUndefined();
  });
});

describe('resolveInboundSites — alias resolution', () => {
  it('resolves drift spellings via aliases and flags unresolvable names (never drops them)', async () => {
    const parsed = await parseWorkbook(await buildDriftWorkbook());
    const resolver = inMemoryAliasResolver({
      'Depot Alpha': { siteId: 's-alpha', canonicalName: 'Depot Alpha', isNonProgram: false },
      VAcaville: { siteId: 's-vaca', canonicalName: 'Vacaville', isNonProgram: true },
      Vacaville: { siteId: 's-vaca', canonicalName: 'Vacaville', isNonProgram: true },
    });
    const findings = resolveInboundSites(window, parsed.inbound, resolver, config);
    // Only 'All about Buidling' is unresolvable → exactly one unresolved_site finding.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('unresolved_site');
    expect(findings[0]!.actual).toEqual({ siteNameRaw: 'All about Buidling' });
  });
});
