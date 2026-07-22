import { describe, expect, it, vi } from 'vitest';
import { buildBackfillTargets } from './backfill-targets';
import type { BackfillPortalClient } from './backfill';
import type { SfField, SfRecord } from './types';

const AT = new Date('2026-08-04T12:00:00.000Z');

function f(value: unknown, displayValue: string | null = null): SfField {
  return { displayValue, value };
}

function fakeMirror() {
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const upserts: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
  return {
    updates,
    upserts,
    model: {
      upsert: vi.fn(async (a: (typeof upserts)[number]) => void upserts.push(a)),
      findMany: vi.fn(async () => [] as { id: string }[]),
      update: vi.fn(async (a: (typeof updates)[number]) => void updates.push(a)),
    },
  };
}

function makeFakePrisma() {
  const hauls = fakeMirror();
  const processed = fakeMirror();
  const outbound = fakeMirror();
  const dock = fakeMirror();
  const prisma = {
    mymrcHaulsMirror: hauls.model,
    mymrcProcessedMirror: processed.model,
    mymrcOutboundMirror: outbound.model,
    mymrcDockAvailabilityMirror: dock.model,
    site: {
      findUnique: vi.fn(async (a: { where: { code: string } }) => {
        if (a.where.code === 'woodland') return { id: 'site-wood' };
        if (a.where.code === 'eugene') return { id: 'site-eug' };
        return null;
      }),
    },
  };
  return { prisma, hauls, processed, outbound, dock };
}

const stubClient: BackfillPortalClient = {
  fetchListPage: vi.fn(async () => ({ ids: [], hasMoreData: false })),
  fetchRecordDetail: vi.fn(async (id: string) => ({ apiName: 'X', id, fields: {} })),
};

type P = Parameters<typeof buildBackfillTargets>[0]['prisma'];

describe('buildBackfillTargets — the 8 cursors (active + history) over the 4 real objects', () => {
  it('binds each (object, list-view) to the right mirror, active then history', () => {
    const { prisma } = makeFakePrisma();
    const targets = buildBackfillTargets({ prisma: prisma as unknown as P, client: stubClient });
    expect(targets.map((t) => [t.objectApiName, t.listViewApiName])).toEqual([
      ['Haul_Request__c', 'docking_appointments_rc'],
      ['Haul_Request__c', 'consumer_drop_off_rc'],
      ['Haul_Request__c', 'completed_hauls'],
      ['Materials__c', 'processed_active'],
      ['Materials__c', 'processed_inactive'],
      ['Materials__c', 'outbound_active'],
      ['Materials__c', 'outbound_inactive'],
      ['Dock_Availability_Schedule__c', ''],
    ]);
  });
});

describe('haul detail write — derives site_id from recycler_name, maps billing columns', () => {
  it('resolves "DR3 Woodland" → site row and stamps detail_fetched_at', async () => {
    const { prisma, hauls } = makeFakePrisma();
    const [docking] = buildBackfillTargets({ prisma: prisma as unknown as P, client: stubClient });
    const record: SfRecord = {
      apiName: 'Haul_Request__c',
      id: 'a2Kxx',
      fields: {
        Name: f('H-900001'),
        Status__c: f('Confirmed'),
        Type__c: f('General'),
        Recycler_Program_Unit_Count__c: f(412),
        Recycler_Non_Program_Unit_Count__c: f(3),
        Recycling_Center_Lookup__c: f('001460000SYNTHTVLAAQ'),
        Recycling_Center_Lookup__r: f(
          { apiName: 'Account', id: '001460000SYNTHTVLAAQ', fields: { Name: f('DR3 Woodland') } },
          'DR3 Woodland',
        ),
      },
    };
    await docking?.writeDetail(record, AT);

    expect(hauls.updates).toHaveLength(1);
    const data = hauls.updates[0]?.data;
    expect(hauls.updates[0]?.where).toEqual({ id: 'a2Kxx' });
    expect(data?.['site_id']).toBe('site-wood');
    expect(data?.['external_haul_id']).toBe('H-900001');
    expect(data?.['program_unit_count']).toBe(412);
    expect(data?.['recycler_account_id']).toBe('001460000SYNTHTVLAAQ');
    expect(data?.['detail_fetched_at']).toBe(AT);
  });

  it('leaves site_id NULL for an unrecognized recycler name (never mis-attributed)', async () => {
    const { prisma, hauls } = makeFakePrisma();
    const [docking] = buildBackfillTargets({ prisma: prisma as unknown as P, client: stubClient });
    const record: SfRecord = {
      apiName: 'Haul_Request__c',
      id: 'a2Kzz',
      fields: {
        Name: f('H-000001'),
        Recycling_Center_Lookup__r: f({ apiName: 'Account', id: 'x', fields: { Name: f('Some Other Recycler') } }, 'Some Other Recycler'),
      },
    };
    await docking?.writeDetail(record, AT);
    expect(hauls.updates[0]?.data?.['site_id']).toBeNull();
  });
});

describe('materials detail write — Type__c mismatch warns but still persists', () => {
  it('warns when an Outbound-typed record surfaces under the processed view', async () => {
    const { prisma, processed } = makeFakePrisma();
    const log = vi.fn();
    const targets = buildBackfillTargets({ prisma: prisma as unknown as P, client: stubClient, log });
    const processedTarget = targets[3]; // processed_active
    const record: SfRecord = {
      apiName: 'Materials__c',
      id: 'a2Lxx',
      fields: {
        Name: f('M-900001'),
        Type__c: f('Outbound'),
        Number_of_Program_Units__c: f(510),
        Account__r: f({ apiName: 'Account', id: 'x', fields: { Name: f('DR3 Eugene') } }, 'DR3 Eugene'),
      },
    };
    await processedTarget?.writeDetail(record, AT);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('Type__c=Outbound under Processing view'));
    expect(processed.updates).toHaveLength(1); // persisted regardless (traceable via type column)
    expect(processed.updates[0]?.data?.['site_id']).toBe('site-eug');
  });

  it('routes an INACTIVE Processing record by Type__c to the processed mirror with no mismatch warning', async () => {
    const { prisma, processed } = makeFakePrisma();
    const log = vi.fn();
    const targets = buildBackfillTargets({ prisma: prisma as unknown as P, client: stubClient, log });
    const processedInactive = targets[4]; // processed_inactive (HISTORY view)
    expect(processedInactive?.listViewApiName).toBe('processed_inactive');
    const record: SfRecord = {
      apiName: 'Materials__c',
      id: 'a2Linactive',
      fields: {
        Name: f('M-800001'),
        Type__c: f('Processing'), // an inactive record still routes by Type__c
        Number_of_Program_Units__c: f(120),
        Account__r: f({ apiName: 'Account', id: 'x', fields: { Name: f('DR3 Woodland') } }, 'DR3 Woodland'),
      },
    };
    await processedInactive?.writeDetail(record, AT);
    // Correct Type → no mismatch warning; persists to the SAME processed mirror as the active view.
    expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('under Processing view'));
    expect(processed.updates).toHaveLength(1);
    expect(processed.updates[0]?.where).toEqual({ id: 'a2Linactive' });
    expect(processed.updates[0]?.data?.['type']).toBe('Processing');
    expect(processed.updates[0]?.data?.['site_id']).toBe('site-wood');
  });

  it('routes an INACTIVE Outbound record by Type__c to the outbound mirror', async () => {
    const { prisma, outbound } = makeFakePrisma();
    const targets = buildBackfillTargets({ prisma: prisma as unknown as P, client: stubClient });
    const outboundInactive = targets[6]; // outbound_inactive (HISTORY view)
    expect(outboundInactive?.listViewApiName).toBe('outbound_inactive');
    const record: SfRecord = {
      apiName: 'Materials__c',
      id: 'a2Loutinactive',
      fields: {
        Name: f('M-700001'),
        Type__c: f('Outbound'),
        Number_of_Program_Units__c: f(90),
        Account__r: f({ apiName: 'Account', id: 'x', fields: { Name: f('DR3 Eugene') } }, 'DR3 Eugene'),
      },
    };
    await outboundInactive?.writeDetail(record, AT);
    expect(outbound.updates).toHaveLength(1);
    expect(outbound.updates[0]?.where).toEqual({ id: 'a2Loutinactive' });
    expect(outbound.updates[0]?.data?.['type']).toBe('Outbound');
  });
});

describe('dock detail write — reads value (not displayValue), keeps time strings verbatim', () => {
  it('persists canonical value fields for the dock schedule', async () => {
    const { prisma, dock } = makeFakePrisma();
    const targets = buildBackfillTargets({ prisma: prisma as unknown as P, client: stubClient });
    const dockTarget = targets[7];
    const record: SfRecord = {
      apiName: 'Dock_Availability_Schedule__c',
      id: 'a1txx',
      fields: {
        Name: f('DA-900001'),
        Status__c: f('Active'),
        Day_of_Week__c: f('1;2;3;4;5', 'Monday;Tuesday;Wednesday;Thursday;Friday'),
        Dock_Door__c: f('Dock Door 1', 'Schedule 1'),
        Slot_Start_Time__c: f('07:00:00.000Z', '7:00 AM'),
        Slot_End_Time__c: f('15:00:00.000Z', '3:00 PM'),
        Number_of_Available_Appointments__c: f(3),
      },
    };
    await dockTarget?.writeDetail(record, AT);

    const data = dock.updates[0]?.data;
    expect(data?.['external_schedule_id']).toBe('DA-900001');
    expect(data?.['day_of_week']).toBe('1;2;3;4;5'); // numeric codes (value), not "Monday;…"
    expect(data?.['dock_door']).toBe('Dock Door 1'); // value, not "Schedule 1"
    expect(data?.['slot_start_time']).toBe('07:00:00.000Z'); // verbatim SF Time text
    expect(data?.['available_appointments']).toBe(3);
    expect(data?.['detail_fetched_at']).toBe(AT);
  });
});

describe('list-pass upsert — creates id-only rows, never clears detail_fetched_at', () => {
  it('upserts every id with lifecycle-only create/update', async () => {
    const { prisma, hauls } = makeFakePrisma();
    const [docking] = buildBackfillTargets({ prisma: prisma as unknown as P, client: stubClient });
    const n = await docking?.upsertListed(['a2K1', 'a2K2'], AT);
    expect(n).toBe(2);
    expect(hauls.upserts).toHaveLength(2);
    expect(hauls.upserts[0]?.create).toEqual({ id: 'a2K1', first_seen_at: AT, last_seen_at: AT });
    expect(hauls.upserts[0]?.update).toEqual({ last_seen_at: AT, disappeared_at: null });
    // update path must NOT touch detail_fetched_at (would strip an already-filled row).
    expect(hauls.upserts[0]?.update).not.toHaveProperty('detail_fetched_at');
  });
});
