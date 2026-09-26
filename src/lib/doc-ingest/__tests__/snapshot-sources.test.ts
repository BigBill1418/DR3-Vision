// ADR-0139 — frozen Outlook attachment copies.
//
// Fixtures are the REAL 2026-09-25 measurement (direct Graph item GETs against
// production's eleven watched documents), not invented shapes. The two copies
// whose `path_hint` column was EMPTY are included on purpose: they are why the
// check asks Graph instead of trusting the column.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true, outcome: 'sent' })) }));
import { publishNtfy } from '@/lib/ntfy';

import type { DocIngestGraph, GraphDriveItem } from '../graph';
import { DocIngestNotFoundError } from '../graph';
import {
  isOutlookAttachmentPath,
  runSnapshotSourceCheck,
  shouldRunSnapshotCheck,
  SNAPSHOT_SUBJECT,
} from '../snapshot-sources';
import {
  asPrisma,
  makeFakePrisma,
  resetFakeIds,
  type FakeDocIngestPrisma,
} from '../__testutils__/fake-prisma';

const NOW = new Date('2026-09-26T15:05:00Z'); // 08:05 PDT
const KELSEY = 'b!4CzvoBCatkKoV1oZd9MkhSzOViAhiXNFthpKKUzGJEHt66jhPKMvTLNpGh1zvpwT';
const JANETTE = 'b!bcdH9g_Pl06E3lDo97KbaG1GwDY1getJsoZP-EbLB_7oeK1a7djzQogo_4-nX8Q2';
const BILL = 'b!0qdek2Vb40OOiVdThQy0tgCyBZJXkDRCulCe-5IGKYWhC7UF3DWeRLCFPkNend8E';
const ATT = (d: string) => `/drives/${d}/root:/Attachments`;

interface Live {
  id: string;
  drive: string;
  name: string;
  path: string;
  modified: string;
  enabled?: boolean;
}

/** The eleven watched documents as Graph described them on 2026-09-25. */
const LIVE: Live[] = [
  {
    id: 'data',
    drive: KELSEY,
    name: 'DR3 Data Tracking.xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-29T20:10:50Z',
  },
  {
    id: 'machine',
    drive: BILL,
    name: 'DR3 Machine List (2).xlsx',
    path: ATT(BILL),
    modified: '2026-07-28T19:02:59Z',
  },
  {
    id: 'notes',
    drive: KELSEY,
    name: 'DR3 Meeting Notes Log 2026.xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-29T20:10:46Z',
  },
  {
    id: 'tasks',
    drive: KELSEY,
    name: 'DR3 Task Lists for 2025.xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-29T20:10:43Z',
  },
  {
    id: 'journal',
    drive: KELSEY,
    name: 'JOURNAL Woodland Facility.xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-29T20:10:58Z',
  },
  // Janette's TEREX is the LIVE file — drive root, not Attachments. Must never trip.
  {
    id: 'terex',
    drive: JANETTE,
    name: 'TEREX.xlsx',
    path: `/drives/${JANETTE}/root:`,
    modified: '2026-08-19T01:14:36Z',
  },
  // Kelsey's TEREX copy is disabled — the kill switch is one of the two answers.
  {
    id: 'terex-copy',
    drive: KELSEY,
    name: 'TEREX.xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-29T20:11:02Z',
    enabled: false,
  },
  // These two had an EMPTY path_hint in doc_sources; Graph puts them in Attachments.
  {
    id: 'tracker',
    drive: KELSEY,
    name: 'Woodland Data Auditing Tracker (1).xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-30T00:09:48Z',
  },
  {
    id: 'invoices',
    drive: KELSEY,
    name: 'Woodland Invoices tracking.xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-29T20:11:01Z',
  },
  {
    id: 'outbound',
    drive: KELSEY,
    name: 'Woodland Outbound Auditing 2026.xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-30T00:09:46Z',
  },
  {
    id: 'trailer',
    drive: KELSEY,
    name: 'Woodland Trailer list.xlsx',
    path: ATT(KELSEY),
    modified: '2026-07-29T20:10:49Z',
  },
];

function item(l: Live): GraphDriveItem {
  return {
    id: l.id,
    driveId: l.drive,
    name: l.name,
    isFolder: false,
    webUrl: null,
    ctag: '"c:{X},2"',
    etag: null,
    size: 1,
    contentType: null,
    lastModifiedAt: l.modified,
    lastModifiedBy: null,
    ownerUpn: null,
    parentItemId: null,
    parentPath: l.path,
    deleted: false,
  };
}

function graphFor(live: Live[], failIds: Set<string> = new Set()): DocIngestGraph {
  const byKey = new Map(live.map((l) => [`${l.drive}:${l.id}`, l]));
  return {
    getItem: vi.fn(async (driveId: string, itemId: string) => {
      if (failIds.has(itemId)) throw new DocIngestNotFoundError(itemId);
      const l = byKey.get(`${driveId}:${itemId}`);
      if (!l) throw new DocIngestNotFoundError(itemId);
      return item(l);
    }),
  } as unknown as DocIngestGraph;
}

async function seed(fake: FakeDocIngestPrisma, live: Live[]) {
  for (const l of live) {
    await fake.docSource.create({
      data: {
        drive_id: l.drive,
        item_id: l.id,
        display_name: l.name,
        kind: 'file',
        state: 'active',
        enabled: l.enabled ?? true,
        owner_upn:
          l.drive === JANETTE
            ? 'janette.tomas@svdp.us'
            : l.drive === BILL
              ? 'bill.barnard@svdp.us'
              : 'kelsey.ruhland@svdp.us',
        // The column the check must NOT trust: empty for two of the copies.
        path_hint: l.id === 'tracker' || l.id === 'trailer' ? null : l.path,
      },
    });
  }
}

let fake: FakeDocIngestPrisma;
beforeEach(() => {
  resetFakeIds();
  fake = makeFakePrisma();
  vi.mocked(publishNtfy).mockClear();
});

describe('isOutlookAttachmentPath', () => {
  it('matches the drive-root Attachments folder only', () => {
    expect(isOutlookAttachmentPath(ATT(KELSEY))).toBe(true);
    expect(isOutlookAttachmentPath(`${ATT(KELSEY)}/`)).toBe(true);
    expect(isOutlookAttachmentPath(`/drives/${KELSEY}/root:/attachments`)).toBe(true);
    // A user folder merely NAMED Attachments deeper in the tree is not Outlook's.
    expect(isOutlookAttachmentPath(`/drives/${KELSEY}/root:/DR3/Attachments`)).toBe(false);
    expect(isOutlookAttachmentPath(`/drives/${KELSEY}/root:/Attachments/Sub`)).toBe(false);
    expect(isOutlookAttachmentPath(`/drives/${JANETTE}/root:`)).toBe(false);
    expect(isOutlookAttachmentPath(null)).toBe(false);
  });
});

describe('shouldRunSnapshotCheck', () => {
  it('runs on scheduled sweeps in the 08:00–08:29 PT window, and always on manual', () => {
    expect(shouldRunSnapshotCheck(new Date('2026-09-26T15:05:00Z'), 'scheduled')).toBe(true); // 08:05 PDT
    expect(shouldRunSnapshotCheck(new Date('2026-09-26T15:29:59Z'), 'scheduled')).toBe(true); // 08:29 PDT
    expect(shouldRunSnapshotCheck(new Date('2026-09-26T15:30:00Z'), 'scheduled')).toBe(false); // 08:30 PDT
    expect(shouldRunSnapshotCheck(new Date('2026-09-26T08:05:00Z'), 'scheduled')).toBe(false); // 01:05 PDT (08:05 UTC)
    // Winter: PST is UTC-8, so 08:05 PST is 16:05 UTC.
    expect(shouldRunSnapshotCheck(new Date('2026-12-01T16:05:00Z'), 'scheduled')).toBe(true);
    expect(shouldRunSnapshotCheck(new Date('2026-09-26T05:24:00Z'), 'manual')).toBe(true);
    expect(shouldRunSnapshotCheck(new Date('2026-09-26T15:05:00Z'), 'notification')).toBe(false);
  });
});

describe('runSnapshotSourceCheck', () => {
  it('finds all nine frozen copies — including the two with an empty path_hint — and not the live TEREX', async () => {
    await seed(fake, LIVE);
    const res = await runSnapshotSourceCheck(asPrisma(fake), graphFor(LIVE), { now: NOW });

    expect(res.checked).toBe(10); // 11 minus the disabled TEREX copy
    expect(res.snapshots.map((s) => s.name).sort()).toEqual([
      'DR3 Data Tracking.xlsx',
      'DR3 Machine List (2).xlsx',
      'DR3 Meeting Notes Log 2026.xlsx',
      'DR3 Task Lists for 2025.xlsx',
      'JOURNAL Woodland Facility.xlsx',
      'Woodland Data Auditing Tracker (1).xlsx',
      'Woodland Invoices tracking.xlsx',
      'Woodland Outbound Auditing 2026.xlsx',
      'Woodland Trailer list.xlsx',
    ]);
    expect(res.raised).toBe(true);

    const open = fake._stores.anomalies.filter((a) => a['status'] === 'open');
    expect(open).toHaveLength(1); // ONE row for the condition, not nine
    expect(open[0]?.['kind']).toBe('snapshot_source');
    expect(String(open[0]?.['detail'])).toContain('9 of 10 watched documents');
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const call = vi.mocked(publishNtfy).mock.calls[0]?.[0] as { priority?: string };
    expect(call.priority).toBe('default');
  });

  it('a second run bumps the same row and does not re-page inside the week', async () => {
    await seed(fake, LIVE);
    await runSnapshotSourceCheck(asPrisma(fake), graphFor(LIVE), { now: NOW });
    const res = await runSnapshotSourceCheck(asPrisma(fake), graphFor(LIVE), {
      now: new Date(NOW.getTime() + 24 * 3600 * 1000),
    });
    expect(res.raised).toBe(false);
    expect(fake._stores.anomalies.filter((a) => a['status'] === 'open')).toHaveLength(1);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
  });

  it('a copy someone is still editing is live, not a snapshot', async () => {
    const edited = LIVE.map((l) =>
      l.id === 'notes'
        ? { ...l, modified: new Date(NOW.getTime() - 2 * 86400000).toISOString() }
        : l,
    );
    await seed(fake, edited);
    const res = await runSnapshotSourceCheck(asPrisma(fake), graphFor(edited), { now: NOW });
    expect(res.snapshots.map((s) => s.name)).not.toContain('DR3 Meeting Notes Log 2026.xlsx');
    expect(res.snapshots).toHaveLength(8);
  });

  it('clears once every copy is disabled or replaced', async () => {
    await seed(fake, LIVE);
    await runSnapshotSourceCheck(asPrisma(fake), graphFor(LIVE), { now: NOW });
    for (const s of fake._stores.sources) if (s['item_id'] !== 'terex') s['enabled'] = false;
    const res = await runSnapshotSourceCheck(asPrisma(fake), graphFor(LIVE), { now: NOW });
    expect(res.resolved).toBe(true);
    expect(fake._stores.anomalies.filter((a) => a['status'] === 'open')).toHaveLength(0);
  });

  it('an unreadable source blocks the all-clear — "could not see" is never "clear"', async () => {
    const liveOnly = LIVE.filter((l) => l.id === 'terex' || l.id === 'data');
    await seed(fake, liveOnly);
    await runSnapshotSourceCheck(asPrisma(fake), graphFor(liveOnly), { now: NOW }); // raises on 'data'
    for (const s of fake._stores.sources) if (s['item_id'] === 'data') s['enabled'] = false;
    const res = await runSnapshotSourceCheck(
      asPrisma(fake),
      graphFor(liveOnly, new Set(['terex'])),
      { now: NOW },
    );
    expect(res.unreadable).toBe(1);
    expect(res.resolved).toBe(false);
    expect(fake._stores.anomalies.filter((a) => a['status'] === 'open')).toHaveLength(1);
  });

  it('SUBJECT is stable (one fingerprint across runs)', () => {
    expect(SNAPSHOT_SUBJECT).toBe('discovery:snapshot_sources');
  });
});
