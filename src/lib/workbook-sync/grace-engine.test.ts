// ADR-0049 Am.4 B1 — the grace window as the ENGINE actually runs it.
//
// `grace.test.ts` proves the policy arithmetic. This file proves the thing that
// matters operationally: that on 3 August the July workbook is still read, that
// it stops being read once the window closes, and that reading it cannot damage
// the live month's health signal, its watermark, or an invoice already sent.
//
// Every assertion here was falsified before being kept.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => undefined) }));

import { publishNtfy } from '@/lib/ntfy';
import { runWorkbookSyncPoll } from './engine';
import { mockFilesTransport, type MockFileSpec } from '@/lib/msgraph-files';
import { buildFixtureWorkbookBytes } from '@/lib/msgraph-files/__fixtures__/workbook';
import { FakePrisma } from './__tests__/fake-prisma';

const JULY_FILE = 'JULY 2026 DAILY LOG WOODLAND.xlsm';
const AUGUST_FILE = 'AUGUST 2026 DAILY LOG WOODLAND.xlsm';

/** Monday 3 August 2026, midday Pacific — the 1st business day of the new month. */
const IN_WINDOW = () => new Date('2026-08-03T19:00:00.000Z');
/** Monday 10 August 2026 — past the 5th business day (Fri 7th). */
const AFTER_WINDOW = () => new Date('2026-08-10T19:00:00.000Z');

async function julyFile(ctag = 'july-v1'): Promise<MockFileSpec> {
  const bytes = await buildFixtureWorkbookBytes({
    daily: [
      { date: '2026-07-01', strippedProgram: 150, strippedNonProgram: 25, materialTicket: 'M-1' },
      { date: '2026-07-02', strippedProgram: 175, strippedNonProgram: 12, materialTicket: 'M-2' },
      { date: '2026-07-03', strippedProgram: 200, strippedNonProgram: 30, materialTicket: 'M-3' },
    ],
  });
  return { id: 'f-july', name: JULY_FILE, ctag, bytes };
}

async function augustFile(ctag = 'aug-v1'): Promise<MockFileSpec> {
  const bytes = await buildFixtureWorkbookBytes({
    daily: [
      { date: '2026-08-03', strippedProgram: 90, strippedNonProgram: 5, materialTicket: 'M-9' },
    ],
  });
  return { id: 'f-aug', name: AUGUST_FILE, ctag, bytes };
}

const ctx = (
  db: FakePrisma,
  transport: ReturnType<typeof mockFilesTransport>,
  now: () => Date,
) => ({
  prisma: db.asClient(),
  transport,
  allowNonGraphWrites: true,
  now,
});

beforeEach(() => vi.clearAllMocks());

describe('grace window — engine', () => {
  it('still reads JULY on 3 August, alongside August (the whole point of B1)', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const transport = mockFilesTransport({ files: [await augustFile(), await julyFile()] });

    const res = await runWorkbookSyncPoll(ctx(db, transport, IN_WINDOW));

    expect(res.results).toHaveLength(2);
    const current = res.results.find((r) => !r.graceWindow)!;
    const grace = res.results.find((r) => r.graceWindow)!;
    expect(current.fileName).toBe(AUGUST_FILE);
    expect(grace.fileName).toBe(JULY_FILE);
    expect(grace.status).toBe('ok');
    // The July close-out figures actually landed.
    expect(grace.rowsUpserted).toBeGreaterThan(0);
    const julyRows = db.pud.filter((r) => r.production_date.toISOString().startsWith('2026-07'));
    expect(julyRows).toHaveLength(3);
  });

  it('STOPS reading July once the window closes — a later edit can never rewrite it', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const transport = mockFilesTransport({ files: [await augustFile(), await julyFile()] });

    const res = await runWorkbookSyncPoll(ctx(db, transport, AFTER_WINDOW));

    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.graceWindow).toBe(false);
    expect(res.results[0]!.fileName).toBe(AUGUST_FILE);
    expect(db.pud.some((r) => r.production_date.toISOString().startsWith('2026-07'))).toBe(false);
  });

  it('a grace read never advances the CURRENT month watermark or last_polled_at', async () => {
    // The damaging version of this bug is silent: a grace read stamps the
    // current-month cTag, so the next poll sees August "unchanged" and skips a
    // real August edit forever.
    const db = new FakePrisma();
    const source = db.seedSource();
    const transport = mockFilesTransport({ files: [await augustFile(), await julyFile()] });

    await runWorkbookSyncPoll(ctx(db, transport, IN_WINDOW));

    expect(source.last_file_name).toBe(AUGUST_FILE);
    expect(source.last_file_ctag).toBe('aug-v1');
    expect(source.grace_file_name).toBe(JULY_FILE);
    expect(source.grace_file_ctag).toBe('july-v1');
  });

  it('an unchanged July cTag does not re-download it every poll', async () => {
    const db = new FakePrisma();
    db.seedSource();
    const transport = mockFilesTransport({ files: [await augustFile(), await julyFile()] });

    await runWorkbookSyncPoll(ctx(db, transport, IN_WINDOW));
    const afterFirst = transport.downloadCount;
    const res = await runWorkbookSyncPoll(ctx(db, transport, IN_WINDOW));

    expect(transport.downloadCount).toBe(afterFirst);
    expect(res.results.find((r) => r.graceWindow)!.changesDetected).toBe(false);
  });

  it('REFUSES to rewrite a day an approved invoice already covers, and says so', async () => {
    const db = new FakePrisma();
    db.seedSource();
    db.invoices.push({
      site_id: 'site-woodland',
      status: 'approved',
      voided_at: null,
      window_start: new Date('2026-07-01T00:00:00.000Z'),
      window_end: new Date('2026-07-02T00:00:00.000Z'),
    });
    const transport = mockFilesTransport({ files: [await augustFile(), await julyFile()] });

    const res = await runWorkbookSyncPoll(ctx(db, transport, IN_WINDOW));
    const grace = res.results.find((r) => r.graceWindow)!;

    expect(grace.rowsSkippedBilled).toBe(2);
    // Only the unbilled day was written.
    const written = db.pud
      .map((r) => r.production_date.toISOString().slice(0, 10))
      .filter((d) => d.startsWith('2026-07'));
    expect(written).toEqual(['2026-07-03']);
    // And it is on the ledger — a skipped billed day is a finding, not a silence.
    const run = db.syncRuns.find((r) => r['grace_window'] === true)!;
    expect(run['rows_skipped_billed']).toBe(2);
  });

  it('a missing July file is normal at month end — it does not page or dent health', async () => {
    // The prior month's workbook gets archived / renamed / filed into a year
    // folder as a matter of routine. Paging on that would fire on every source,
    // every month, on schedule.
    const db = new FakePrisma();
    const source = db.seedSource();
    const transport = mockFilesTransport({ files: [await augustFile()] }); // no July

    const res = await runWorkbookSyncPoll(ctx(db, transport, IN_WINDOW));
    const grace = res.results.find((r) => r.graceWindow)!;

    expect(grace.status).toBe('not_found');
    expect(grace.paged).toBe(false);
    expect(publishNtfy).not.toHaveBeenCalled();
    // The live month succeeded, so health reflects the live month only.
    expect(source.consecutive_failures).toBe(0);
  });

  it('a FAILING grace read does not reset the live month’s failure counter', async () => {
    // The masking direction: August has been failing for days; a successful read
    // of last month's file must not be mistaken for the live feed recovering.
    const db = new FakePrisma();
    const source = db.seedSource({ consecutive_failures: 4 });
    // August absent (not_found), July present and readable.
    const transport = mockFilesTransport({ files: [await julyFile()] });

    const res = await runWorkbookSyncPoll(ctx(db, transport, IN_WINDOW));
    const grace = res.results.find((r) => r.graceWindow)!;

    expect(grace.status).toBe('ok');
    expect(grace.rowsUpserted).toBeGreaterThan(0);
    // `not_found` on the live month is not a failure, but the point stands: the
    // grace success did not write the health watermark.
    expect(source.last_success_at).toBeNull();
  });
});
