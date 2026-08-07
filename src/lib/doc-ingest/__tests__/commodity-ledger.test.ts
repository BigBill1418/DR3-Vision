// ADR-0080 Phase 2 — the coverage read's arithmetic, pinned so it cannot drift.
//
// This repo has shipped green-because-the-mock-lied twice (ADR-0076, and again in
// `terex-ledger.test.ts` where a mock that always sorted newest-first left the
// newest-revision-wins rule with NO guard at all). So the fake below is built to
// be falsifiable rather than agreeable:
//
//   - `where.status` is honoured ONLY when the caller supplies it, so deleting the
//     scope clause from the module changes the ANSWER instead of nothing.
//   - `where.doc_source_version_id` likewise, so deleting the version pin returns
//     both revisions and the count DOUBLES to a number the assertion names.
//   - `where.site_id` likewise, so site scoping is measured rather than assumed.
//   - `orderBy.absorbed_at` is READ, not hardcoded. Flipping the module to `asc`
//     picks the older revision, and because each revision's rows are IDENTIFIABLE
//     (distinct initials) that shows up as a different answer. Byte-identical
//     fixtures would have left the direction unpinned — which is exactly how the
//     production triple-count got through.
//
// The pinned figures are the live document's own shape (verified 2026-08-07):
// "Commodity Audit 2026" = 7 streams × 12 months = 84 rows, "Commodity Audit 2025"
// = 6 × 12 = 72, one workbook = 156. NO tonnage and NO money anywhere in it — the
// only honest number this document produces is a count of months.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

interface Row {
  site_id: string;
  status: string;
  doc_source_version_id: string;
  absorbed_at: Date;
  sheet_name: string;
  sheet_year: number | null;
  stream_group: string;
  stream_label: string;
  month_label: string;
  month_number: number | null;
  audited: boolean | null;
  initials: string | null;
  audit_date: Date | null;
  audit_date_raw: string | null;
  second_audit: boolean | null;
  second_initials: string | null;
  second_audit_date: Date | null;
  second_audit_date_raw: string | null;
  row_index: number;
}

const store = {
  rows: [] as Row[],
  sites: [] as { id: string; name: string }[],
};

function matches(r: Row, where: Record<string, unknown>): boolean {
  if (where['site_id'] !== undefined && r.site_id !== where['site_id']) return false;
  if (where['status'] !== undefined && r.status !== where['status']) return false;
  if (
    where['doc_source_version_id'] !== undefined &&
    r.doc_source_version_id !== where['doc_source_version_id']
  ) {
    return false;
  }
  return true;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    docCommodityAuditRow: {
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: Record<string, unknown>;
          orderBy?: { absorbed_at?: 'asc' | 'desc' };
        }) => {
          // Reads the direction the CALLER asked for. A mock that always sorted
          // descending would make `desc` untestable: flipping the module to `asc`
          // would still return the newest revision and the suite would stay green
          // while the rule it exists to protect had no guard.
          const dir = orderBy?.absorbed_at ?? 'asc';
          const rows = store.rows
            .filter((r) => matches(r, where))
            .sort((a, b) =>
              dir === 'desc'
                ? b.absorbed_at.getTime() - a.absorbed_at.getTime()
                : a.absorbed_at.getTime() - b.absorbed_at.getTime(),
            );
          return rows[0] ?? null;
        },
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.rows
          .filter((r) => matches(r, where))
          .sort(
            (a, b) => a.sheet_name.localeCompare(b.sheet_name) || a.row_index - b.row_index,
          ),
      ),
    },
    site: {
      findMany: vi.fn(async () => store.sites.map((s) => ({ id: s.id, name: s.name }))),
    },
  },
}));

import { computeCommodityCoverage, sitesWithCommodityCoverage } from '../commodity-ledger';

// ── The live document, in fixture form ──────────────────────────────────────

/** The 2026 sheet's seven stream banners, verbatim (note "WOOD-" has no space). */
const STREAMS_2026: [string, string][] = [
  ['METAL', 'METAL - GreenZone'],
  ['WOOD', 'WOOD- Biomass'],
  ['TOPPERS', 'TOPPERS - All Vendors'],
  ['FOAM', 'FOAM - All Vendors'],
  ['TRASH', 'TRASH - Yolo (Including Bulky)'],
  ['XTRACTION', 'XTRACTION'],
  ['DAILY LOG/MYMRC/SPREADSHEET', 'DAILY LOG/MYMRC/SPREADSHEET'],
];

/** The 2025 sheet has SIX — no DAILY LOG block. Never counted off; read. */
const STREAMS_2025 = STREAMS_2026.slice(0, 6);

const MONTHS: [string, number][] = [
  ['Jan', 1],
  ['Feb', 2],
  ['March', 3],
  ['April', 4],
  ['May', 5],
  ['June', 6],
  ['July', 7],
  ['Aug', 8],
  ['Sept', 9],
  ['Oct', 10],
  ['Nov', 11],
  ['Dec', 12],
];

/**
 * One sheet of one revision.
 *
 * The three-way distribution is FIXED per stream — months 1–8 audited, 9–10 not
 * audited, 11–12 not recorded — so every assertion below is a hard number rather
 * than something recomputed from the fixture (a test that derives its expectation
 * from the same data it is checking cannot fail).
 *
 * `initials` carries the REVISION id. That is what makes the newest-wins rule
 * measurable: the totals are identical across revisions, faithfully to a real
 * re-upload, so only row identity can prove `desc` was honoured.
 */
function seedSheet(args: {
  sheetName: string;
  year: number;
  streams: [string, string][];
  versionId: string;
  absorbedAt: string;
  status?: string;
  siteId?: string;
}): void {
  let rowIndex = 4;
  for (const [group, label] of args.streams) {
    for (const [monthLabel, monthNumber] of MONTHS) {
      rowIndex += 1;
      const audited = monthNumber <= 8 ? true : monthNumber <= 10 ? false : null;
      store.rows.push({
        site_id: args.siteId ?? WOODLAND,
        status: args.status ?? 'confirmed',
        doc_source_version_id: args.versionId,
        absorbed_at: new Date(args.absorbedAt),
        sheet_name: args.sheetName,
        sheet_year: args.year,
        stream_group: group,
        stream_label: label,
        month_label: monthLabel,
        month_number: monthNumber,
        audited,
        initials: audited === null ? null : `from-${args.versionId}`,
        audit_date: audited === true ? new Date('2026-03-04T00:00:00Z') : null,
        audit_date_raw: audited === true ? '2026-03-04' : '',
        second_audit: monthNumber <= 4 ? true : null,
        second_initials: monthNumber <= 4 ? `2nd-${args.versionId}` : null,
        second_audit_date: null,
        second_audit_date_raw: null,
        row_index: rowIndex,
      });
    }
  }
}

/** A whole workbook revision: 84 + 72 = 156 rows. */
function seedRevision(versionId: string, absorbedAt: string, status = 'confirmed'): void {
  seedSheet({
    sheetName: 'Commodity Audit 2026',
    year: 2026,
    streams: STREAMS_2026,
    versionId,
    absorbedAt,
    status,
  });
  seedSheet({
    sheetName: 'Commodity Audit 2025',
    year: 2025,
    streams: STREAMS_2025,
    versionId,
    absorbedAt,
    status,
  });
}

beforeEach(() => {
  store.rows.length = 0;
  store.sites.length = 0;
});

// ────────────────────────────────────────────────────────────────
// THE DOUBLE-COUNT FALSIFICATION.
//
// The unique key is (version, sheet, stream_label, month_label), so two confirmed
// revisions of ONE workbook coexist by design, each a complete copy. The
// 2026-08-06 TEREX incident was exactly this and it reported 3× the truth
// (ADR-0077 D9). Here the unit is a COUNT OF MONTHS, so the same failure reports
// 168 months of coverage on a 12-month year — a number with no interpretation.
//
// The superseded revisions are left CONFIRMED on purpose. A total that is only
// right when somebody remembered to tidy up is not a guarantee.
// ────────────────────────────────────────────────────────────────
describe('computeCommodityCoverage — one document, many revisions', () => {
  function seedTwoRevisions(): void {
    seedRevision('v-first', '2026-08-01T10:00:00Z');
    seedRevision('v-newest', '2026-08-07T18:30:00Z');
  }

  it('reports ONE revision — 156 rows, not 312', async () => {
    seedTwoRevisions();
    expect(store.rows).toHaveLength(312); // both revisions really are in the table
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.rowsConsidered).toBe(156);
    expect(c.rowsConsidered).not.toBe(312);
    expect(c.audit.rows).toBe(156);
    expect(c.audit.rows).not.toBe(312);
  });

  it('the 2026 sheet is 84 months of coverage, not 168', async () => {
    seedTwoRevisions();
    const c = await computeCommodityCoverage(WOODLAND);
    const sheet = c.sheets.find((s) => s.sheetName === 'Commodity Audit 2026');
    expect(sheet?.audit.rows).toBe(84);
    expect(sheet?.audit.rows).not.toBe(168);
    expect(sheet?.streams).toHaveLength(7);
    // Per stream: 12 months, never 24.
    for (const s of sheet?.streams ?? []) expect(s.audit.rows).toBe(12);
  });

  it('the 2025 sheet is 72 months across SIX streams — read, not counted off', async () => {
    seedTwoRevisions();
    const c = await computeCommodityCoverage(WOODLAND);
    const sheet = c.sheets.find((s) => s.sheetName === 'Commodity Audit 2025');
    expect(sheet?.audit.rows).toBe(72);
    expect(sheet?.audit.rows).not.toBe(144);
    expect(sheet?.streams).toHaveLength(6);
  });

  it('every bucket is one revision deep — 104 / 26 / 26, not 208 / 52 / 52', async () => {
    seedTwoRevisions();
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.audit).toEqual({ audited: 104, notAudited: 26, notRecorded: 26, rows: 156 });
  });

  it('picks the NEWEST revision — a revision supersedes, it does not add', async () => {
    seedTwoRevisions();
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.versionId).toBe('v-newest');
  });

  // Deliberately SEPARATE from the assertion above, and asserting no version id:
  // the reported `versionId` is a label, and a label can be right while the rows
  // beside it came from somewhere else. The totals are identical across both
  // revisions, so only ROW IDENTITY can prove which one was actually returned.
  it('returns the newest revision’s ROWS, not just its name', async () => {
    seedTwoRevisions();
    const c = await computeCommodityCoverage(WOODLAND);
    const initials = new Set(
      c.sheets.flatMap((s) => s.streams).flatMap((s) => s.cells.map((cell) => cell?.initials)),
    );
    expect([...initials]).toContain('from-v-newest');
    expect([...initials]).not.toContain('from-v-first');
  });

  it('never returns the older revision, whatever the insertion order', async () => {
    seedRevision('v-newest', '2026-08-07T18:30:00Z');
    seedRevision('v-first', '2026-08-01T10:00:00Z'); // inserted LAST, older
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.versionId).toBe('v-newest');
    expect(c.rowsConsidered).toBe(156);
  });

  it('does not depend on the superseded revision having been tidied away', async () => {
    seedTwoRevisions();
    // Both revisions are still CONFIRMED, exactly as production sits between an
    // absorption and whatever housekeeping may or may not follow it.
    expect(store.rows.filter((r) => r.status === 'confirmed')).toHaveLength(312);
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.rowsConsidered).toBe(156);
  });

  it('the grid stays 12 wide — it is a lookup, and cannot show the doubling itself', async () => {
    seedTwoRevisions();
    const c = await computeCommodityCoverage(WOODLAND);
    const sheet = c.sheets.find((s) => s.sheetName === 'Commodity Audit 2026');
    expect(sheet?.monthLabels).toHaveLength(12);
    // Stated as a test because it is the reason the TALLIES count rows rather
    // than grid positions: a de-duplicating lookup would render a plausible
    // 12-month grid out of two different revisions and no count would move.
    expect(sheet?.streams[0]?.cells).toHaveLength(12);
  });
});

// ────────────────────────────────────────────────────────────────
// THREE-WAY BUCKETING. "Not recorded" is not "no".
//
// The entire operational value of this document is finding the months nobody has
// audited. If NULL collapsed into `false`, that finding disappears while every
// total still adds up — the quietest possible failure.
// ────────────────────────────────────────────────────────────────
describe('computeCommodityCoverage — audited=true / false / null are three answers', () => {
  /** One stream, three months, one of each answer. Nothing to add up wrongly. */
  function seedOneOfEach(): void {
    const base = {
      site_id: WOODLAND,
      status: 'confirmed',
      doc_source_version_id: 'v1',
      absorbed_at: new Date('2026-08-07T18:30:00Z'),
      sheet_name: 'Commodity Audit 2026',
      sheet_year: 2026,
      stream_group: 'METAL',
      stream_label: 'METAL - GreenZone',
      audit_date: null,
      audit_date_raw: null,
      second_audit: null,
      second_initials: null,
      second_audit_date: null,
      second_audit_date_raw: null,
    };
    store.rows.push(
      { ...base, month_label: 'Jan', month_number: 1, audited: true, initials: 'MB', row_index: 5 },
      { ...base, month_label: 'Feb', month_number: 2, audited: false, initials: 'MB', row_index: 6 },
      { ...base, month_label: 'March', month_number: 3, audited: null, initials: null, row_index: 7 },
    );
  }

  it('counts one of each — never 2 audited, never 2 not-audited', async () => {
    seedOneOfEach();
    const c = await computeCommodityCoverage(WOODLAND);
    // Asserted as ONE object on purpose: if NULL were bucketed with false, a
    // bare `expect(notAudited).toBe(1)` reds with "expected 2 to be 1" and never
    // says which bucket swallowed which. The object diff names both fields —
    // `notAudited: 2` beside `notRecorded: 0` — so the failure is readable
    // without opening the source.
    expect(c.audit).toEqual({ audited: 1, notAudited: 1, notRecorded: 1, rows: 3 });
  });

  it('a NULL never appears as false on the cell either', async () => {
    seedOneOfEach();
    const c = await computeCommodityCoverage(WOODLAND);
    const cells = c.sheets[0]?.streams[0]?.cells ?? [];
    expect(cells.map((x) => x?.audited)).toEqual([true, false, null]);
  });

  it('the three buckets always account for every row and nothing twice', async () => {
    seedRevision('v1', '2026-08-07T18:30:00Z');
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.audit.audited + c.audit.notAudited + c.audit.notRecorded).toBe(c.audit.rows);
    expect(c.audit.rows).toBe(c.rowsConsidered);
  });

  it('the SECOND audit is bucketed three ways too — 52 done, 104 not recorded', async () => {
    seedRevision('v1', '2026-08-07T18:30:00Z');
    const c = await computeCommodityCoverage(WOODLAND);
    // 13 streams × 4 months carry a second audit; the other 104 rows recorded none.
    expect(c.secondAudit).toEqual({ audited: 52, notAudited: 0, notRecorded: 104, rows: 156 });
  });
});

// ────────────────────────────────────────────────────────────────
// SCOPING — site, then absorption state. Both are measured by the mock's `where`.
// ────────────────────────────────────────────────────────────────
describe('computeCommodityCoverage — scoping', () => {
  it('reads only THIS site (hard rule #2)', async () => {
    seedRevision('v-woodland', '2026-08-07T18:30:00Z');
    seedSheet({
      sheetName: 'Commodity Audit 2026',
      year: 2026,
      streams: STREAMS_2026,
      versionId: 'v-eugene',
      absorbedAt: '2026-08-07T19:00:00Z', // NEWER — would win if site were ignored
      siteId: EUGENE,
    });

    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.versionId).toBe('v-woodland');
    expect(c.rowsConsidered).toBe(156);
  });

  // The site clause appears TWICE — on the version pin and on the row read — and
  // the second one is not measured by the test above: version ids are disjoint
  // per site, so pinning `v-woodland` already excludes Eugene and deleting the
  // second clause changes nothing. That is a clause with no guard, which is the
  // same shape as a lint that skips every input and reports green.
  //
  // So this seeds the case the second clause actually defends: a row carrying
  // THIS site's version id under ANOTHER site. The absorber cannot produce it
  // today (a version belongs to one source, which belongs to one site) — which is
  // exactly why nothing else would catch it if that ever stopped being true.
  it('a foreign-site row wearing this version id is still refused', async () => {
    seedRevision('v-woodland', '2026-08-07T18:30:00Z');
    store.rows.push({
      ...store.rows[0]!,
      site_id: EUGENE,
      month_label: 'Jan',
      stream_label: 'METAL - GreenZone',
      row_index: 999,
    });

    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.rowsConsidered).toBe(156);
    expect(c.rowsConsidered).not.toBe(157);
  });

  it('returns an empty, AWAITING coverage for a site with nothing', async () => {
    seedRevision('v1', '2026-08-07T18:30:00Z');
    const c = await computeCommodityCoverage(EUGENE);
    expect(c.awaiting).toBe(true);
    expect(c.versionId).toBeNull();
    expect(c.sheets).toEqual([]);
    // Zero rows, not zero coverage — nothing here claims Eugene audited nothing.
    expect(c.audit.rows).toBe(0);
  });

  it('CONFIRMED is the default scope — staged rows are a proposal, not a total', async () => {
    seedRevision('v-staged', '2026-08-07T18:30:00Z', 'staged');
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.awaiting).toBe(true);
    expect(c.rowsConsidered).toBe(0);
  });

  it('reads the staged batch only when explicitly asked for it', async () => {
    seedRevision('v-staged', '2026-08-07T18:30:00Z', 'staged');
    const c = await computeCommodityCoverage(WOODLAND, { scope: 'staged' });
    expect(c.scope).toBe('staged');
    expect(c.versionId).toBe('v-staged');
    expect(c.rowsConsidered).toBe(156);
  });

  it('never blends staged with confirmed — each scope is one revision deep', async () => {
    seedRevision('v-confirmed', '2026-08-01T10:00:00Z');
    seedRevision('v-staged', '2026-08-07T18:30:00Z', 'staged');
    const confirmed = await computeCommodityCoverage(WOODLAND);
    const staged = await computeCommodityCoverage(WOODLAND, { scope: 'staged' });
    expect(confirmed.rowsConsidered).toBe(156);
    expect(confirmed.versionId).toBe('v-confirmed');
    expect(staged.rowsConsidered).toBe(156);
    expect(staged.versionId).toBe('v-staged');
    // 312 would mean the two states were read as one document.
    expect(confirmed.rowsConsidered + staged.rowsConsidered).toBe(312);
  });

  it('a discarded batch is neither scope', async () => {
    seedRevision('v-discarded', '2026-08-07T18:30:00Z', 'discarded');
    expect((await computeCommodityCoverage(WOODLAND)).rowsConsidered).toBe(0);
    expect((await computeCommodityCoverage(WOODLAND, { scope: 'staged' })).rowsConsidered).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// THE MESS SURVIVES. The extractor keeps what the sheet said; so must this read.
// ────────────────────────────────────────────────────────────────
describe('computeCommodityCoverage — the sheet is quoted, not tidied', () => {
  const base = {
    site_id: WOODLAND,
    status: 'confirmed',
    doc_source_version_id: 'v1',
    absorbed_at: new Date('2026-08-07T18:30:00Z'),
    sheet_name: 'Commodity Audit 2026',
    sheet_year: 2026,
    stream_group: 'METAL',
    stream_label: 'METAL - GreenZone',
    second_audit: null,
    second_initials: null,
    second_audit_date: null,
    second_audit_date_raw: null,
  };

  it('surfaces the literal "working" and leaves the date NULL', async () => {
    store.rows.push({
      ...base,
      month_label: 'March',
      month_number: 3,
      audited: true,
      initials: 'MB',
      audit_date: null,
      audit_date_raw: 'working',
      row_index: 7,
    });
    const c = await computeCommodityCoverage(WOODLAND);
    const cell = c.sheets[0]?.streams[0]?.cells[0];
    expect(cell?.auditDateISO).toBeNull();
    expect(cell?.auditDateRaw).toBe('working');
  });

  it('keeps "NONE" as an answer — it is what an operator wrote, not an absence', async () => {
    store.rows.push({
      ...base,
      month_label: 'Aug',
      month_number: 8,
      audited: true,
      initials: 'NONE',
      audit_date: null,
      audit_date_raw: '',
      row_index: 12,
    });
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.sheets[0]?.streams[0]?.cells[0]?.initials).toBe('NONE');
  });

  it('keeps an unmapped month label and parks it at the end of the axis', async () => {
    store.rows.push(
      {
        ...base,
        month_label: 'June/July',
        month_number: null,
        audited: true,
        initials: 'MB',
        audit_date: null,
        audit_date_raw: '',
        row_index: 10,
      },
      {
        ...base,
        month_label: 'Dec',
        month_number: 12,
        audited: null,
        initials: null,
        audit_date: null,
        audit_date_raw: '',
        row_index: 16,
      },
    );
    const c = await computeCommodityCoverage(WOODLAND);
    // Not dropped, and not guessed into a position between June and July.
    expect(c.sheets[0]?.monthLabels).toEqual(['Dec', 'June/July']);
  });

  it('orders sheets newest year first without changing any count', async () => {
    seedRevision('v1', '2026-08-07T18:30:00Z');
    const c = await computeCommodityCoverage(WOODLAND);
    expect(c.sheets.map((s) => s.sheetYear)).toEqual([2026, 2025]);
    expect(c.sheets.map((s) => s.audit.rows)).toEqual([84, 72]);
  });
});

describe('sitesWithCommodityCoverage', () => {
  it('lists the sites the surface should offer', async () => {
    store.sites.push({ id: WOODLAND, name: 'DR3 Woodland' });
    expect(await sitesWithCommodityCoverage()).toEqual([{ id: WOODLAND, name: 'DR3 Woodland' }]);
  });
});
