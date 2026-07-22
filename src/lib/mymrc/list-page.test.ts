import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BACKFILL_LIST_VIEWS,
  BACKFILL_PAGE_SIZE,
  buildGetItemsFormFields,
  buildGetItemsMessage,
  correlateCapturedListViews,
  DEFAULT_PAGE_SIZE,
  GETITEMS_DESCRIPTOR,
  messageIsGetItems,
  offsetForPage,
  parseAuraPostData,
  parseGetItemsRequest,
  parseGetItemsResponse,
  resolveFilterName,
  SORT_FLIP_STEP_COUNT,
  sortFlipExceedsCoverage,
  sortFlipLastPageIndex,
  sortFlipStep,
  type AuraFrameworkParams,
  type CapturedListView,
  type ListViewBinding,
} from './list-page';
import { PortalContractDriftError } from './portal-client';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/backfill/${name}`, import.meta.url)), 'utf8');
}

// ── offsetForPage: the pageIndex → offset contract ───────────────────────────

describe('offsetForPage — the confirmed pageIndex→offset mapping', () => {
  it('maps 0→0, 1→50, 2→100 at the live page size', () => {
    expect(offsetForPage(0)).toBe(0);
    expect(offsetForPage(1)).toBe(50);
    expect(offsetForPage(2)).toBe(100);
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });
  it('honours a custom page size and guards junk input', () => {
    expect(offsetForPage(3, 25)).toBe(75);
    expect(offsetForPage(-1)).toBe(0); // negative page clamps to offset 0
    expect(offsetForPage(2, 0)).toBe(2); // pageSize floors to 1
  });
});

// ── sort-flip plan: the OFFSET-2000-ceiling breaker ──────────────────────────

describe('sortFlipStep — the 4-step asc/desc plan that pages past offset 2000', () => {
  it('tiles asc@0, asc@pageSize, desc@0, desc@pageSize at the live page size', () => {
    expect(sortFlipStep(0)).toEqual({ sortBy: 'Id', offset: 0 });
    expect(sortFlipStep(1)).toEqual({ sortBy: 'Id', offset: BACKFILL_PAGE_SIZE });
    expect(sortFlipStep(2)).toEqual({ sortBy: '-Id', offset: 0 });
    expect(sortFlipStep(3)).toEqual({ sortBy: '-Id', offset: BACKFILL_PAGE_SIZE });
    expect(BACKFILL_PAGE_SIZE).toBe(2000); // == the SOQL OFFSET cap; no step exceeds it
  });
  it('never requests an offset above the SOQL OFFSET 2000 ceiling', () => {
    for (let i = 0; i < SORT_FLIP_STEP_COUNT; i++) {
      const step = sortFlipStep(i)!;
      expect(step.offset).toBeLessThanOrEqual(2000);
    }
  });
  it('returns null past the plan (the loud-wedge / stale-cursor boundary)', () => {
    expect(sortFlipStep(SORT_FLIP_STEP_COUNT)).toBeNull();
    expect(sortFlipStep(41)).toBeNull(); // a stale pre-sort-flip offset-50 cursor
  });
  it('honours an injected (shrunk) page size for tests', () => {
    expect(sortFlipStep(1, 2)).toEqual({ sortBy: 'Id', offset: 2 });
    expect(sortFlipStep(3, 2)).toEqual({ sortBy: '-Id', offset: 2 });
  });
});

describe('sortFlipLastPageIndex / sortFlipExceedsCoverage — coverage math', () => {
  it('needs only ascending steps up to 2*pageSize, then descending', () => {
    // Live page size 2000 → thresholds 2000/4000/6000/8000.
    expect(sortFlipLastPageIndex(29)).toBe(0); // tiny view: one page
    expect(sortFlipLastPageIndex(2000)).toBe(0);
    expect(sortFlipLastPageIndex(2001)).toBe(1);
    expect(sortFlipLastPageIndex(4000)).toBe(1);
    expect(sortFlipLastPageIndex(4490)).toBe(2); // All Active Outbound Materials (live)
    expect(sortFlipLastPageIndex(6000)).toBe(2);
    expect(sortFlipLastPageIndex(6185)).toBe(3); // Completed Hauls (live)
    expect(sortFlipLastPageIndex(8000)).toBe(3);
  });
  it('flags a view that exceeds the 8000-row sort-flip ceiling', () => {
    expect(sortFlipExceedsCoverage(6185)).toBe(false); // both live views fit
    expect(sortFlipExceedsCoverage(4490)).toBe(false);
    expect(sortFlipExceedsCoverage(8000)).toBe(false);
    expect(sortFlipExceedsCoverage(8001)).toBe(true); // unreachable middle band
  });
  it('scales with an injected page size', () => {
    // pageSize 2 → coverage ceiling 8; 5 rows fit (last step idx 2), 9 rows exceed.
    expect(sortFlipLastPageIndex(5, 2)).toBe(2);
    expect(sortFlipExceedsCoverage(5, 2)).toBe(false);
    expect(sortFlipExceedsCoverage(9, 2)).toBe(true);
  });
});

// ── buildGetItemsMessage: EXACT confirmed params ─────────────────────────────

describe('buildGetItemsMessage — emits the confirmed getItems param set', () => {
  it('carries filterName/entityName/pageSize/layoutType/sortBy/getCount/enableRowActions/offset', () => {
    const msg = buildGetItemsMessage({ entityName: 'Materials__c', filterName: '00B4p000005DAqlEAG', offset: 100 });
    const parsed = JSON.parse(msg) as {
      actions: Array<{ descriptor: string; params: Record<string, unknown> }>;
    };
    expect(parsed.actions).toHaveLength(1);
    const a = parsed.actions[0]!;
    expect(a.descriptor).toBe(GETITEMS_DESCRIPTOR);
    expect(a.params).toEqual({
      filterName: '00B4p000005DAqlEAG',
      entityName: 'Materials__c',
      pageSize: 50,
      layoutType: 'LIST',
      sortBy: null,
      getCount: false,
      enableRowActions: false,
      offset: 100,
    });
  });
  it('is recognised by messageIsGetItems', () => {
    expect(messageIsGetItems(buildGetItemsMessage({ entityName: 'X__c', filterName: 'f', offset: 0 }))).toBe(true);
    expect(messageIsGetItems('{"actions":[{"descriptor":"something/getRecord"}]}')).toBe(false);
  });
  it('threads the sort-flip sortBy + getCount when supplied', () => {
    const msg = buildGetItemsMessage({ entityName: 'Haul_Request__c', filterName: '00Bx', offset: 2000, pageSize: 2000, sortBy: '-Id', getCount: true });
    const params = (JSON.parse(msg) as { actions: Array<{ params: Record<string, unknown> }> }).actions[0]!.params;
    expect(params).toMatchObject({ sortBy: '-Id', getCount: true, pageSize: 2000, offset: 2000 });
  });
});

// ── parseGetItemsResponse: the response codec ────────────────────────────────

describe('parseGetItemsResponse — scalars from the returnValue', () => {
  it('reads ids + offset + hasMoreData on a windowed page', () => {
    const page = parseGetItemsResponse(fixture('getitems-page-windowed.json'));
    expect(page.recordIds).toEqual(['a2Kf0000FAKE0001AAA', 'a2Kf0000FAKE0002AAB', 'a2Kf0000FAKE0003AAC']);
    expect(page.offset).toBe(50);
    expect(page.hasMoreData).toBe(true);
    expect(page.filterTitle).toBe('Docking Appointments (RC)');
    expect(page.entityLabelPlural).toBe('haul requests');
  });
  it('stops (hasMoreData:false) and drops blank record ids on the final page', () => {
    const page = parseGetItemsResponse(fixture('getitems-page-final.json'));
    expect(page.recordIds).toEqual(['a2Kf0000FAKE0101ZZA', 'a2Kf0000FAKE0102ZZB']); // blank dropped
    expect(page.hasMoreData).toBe(false);
  });
  it('throws PortalContractDriftError on an error list view (never a silent empty)', () => {
    expect(() => parseGetItemsResponse(fixture('getitems-error-listview.json'))).toThrow(PortalContractDriftError);
  });
  it('throws PortalContractDriftError when no getItems action is present', () => {
    expect(() => parseGetItemsResponse('{"actions":[{"state":"SUCCESS","returnValue":{"foo":1}}]}')).toThrow(
      PortalContractDriftError,
    );
    expect(() => parseGetItemsResponse('not json')).toThrow(PortalContractDriftError);
  });
  it('reads the absolute totalCount when getCount:true was sent', () => {
    const body = JSON.stringify({
      actions: [{ state: 'SUCCESS', returnValue: { recordIdActionsList: [{ recordId: 'a' }], hasMoreData: true, totalCount: 6185 } }],
    });
    expect(parseGetItemsResponse(body).totalCount).toBe(6185);
  });
  it('leaves totalCount null when getCount was not requested', () => {
    expect(parseGetItemsResponse(fixture('getitems-page-windowed.json')).totalCount).toBeNull();
  });
  it('raises a CLEAR offset-ceiling error on the degenerate past-2000 response (not a generic "no action")', () => {
    // The LIVE shape at offset 2050+: SUCCESS, no recordIdActionsList, a message + hasMoreData:false.
    const ceiling = JSON.stringify({
      actions: [{ state: 'SUCCESS', returnValue: { hasMoreData: false, isErrorListView: false, message: "This list view isn't available in Lightning Experience." } }],
    });
    expect(() => parseGetItemsResponse(ceiling)).toThrow(/offset-ceiling/i);
  });
});

// ── Aura framework-param codec + form building ───────────────────────────────

describe('parseAuraPostData / buildGetItemsFormFields — session-envelope reuse', () => {
  const framework: AuraFrameworkParams = {
    auraContext: '{"fwuid":"LIVE","app":"siteforce:communityApp"}',
    auraToken: 'tok-abc',
    auraPageUri: '/s/hauls',
  };

  it('parses an outgoing aura POST body into message + framework', () => {
    const body = new URLSearchParams({
      message: buildGetItemsMessage({ entityName: 'Haul_Request__c', filterName: '00Bxxx', offset: 0 }),
      'aura.context': framework.auraContext,
      'aura.token': framework.auraToken,
      'aura.pageURI': framework.auraPageUri,
    }).toString();
    const got = parseAuraPostData(body);
    expect(got.framework).toEqual(framework);
    expect(got.message).not.toBeNull();
    expect(messageIsGetItems(got.message!)).toBe(true);
  });

  it('returns framework:null when aura.context is absent (non-aura POST)', () => {
    expect(parseAuraPostData('foo=bar').framework).toBeNull();
  });

  it('builds replay form fields reusing the captured envelope, swapping only the offset', () => {
    const fields = buildGetItemsFormFields(
      framework,
      { entityName: 'Haul_Request__c', filterName: '00Bxxx', offset: 100 },
      'bf-2',
    );
    expect(fields['aura.context']).toBe(framework.auraContext);
    expect(fields['aura.token']).toBe(framework.auraToken);
    expect(fields['aura.pageURI']).toBe(framework.auraPageUri);
    const params = (JSON.parse(fields['message']!) as { actions: Array<{ id: string; params: { offset: number } }> })
      .actions[0]!;
    expect(params.id).toBe('bf-2');
    expect(params.params.offset).toBe(100);
  });
});

// ── parseGetItemsRequest + correlate: runtime id capture ─────────────────────

describe('correlateCapturedListViews — runtime title→id resolution', () => {
  it('joins request (entityName+filterName) to response (filterTitle) by action id', () => {
    const reqMsg = JSON.stringify({
      actions: [
        {
          id: '77;a',
          descriptor: GETITEMS_DESCRIPTOR,
          params: { entityName: 'Materials__c', filterName: '00B4p000005DAqlEAG', offset: 0 },
        },
      ],
    });
    const respBody = JSON.stringify({
      actions: [
        {
          id: '77;a',
          state: 'SUCCESS',
          returnValue: { recordIdActionsList: [], filterTitle: 'All Active Processed Materials' },
        },
      ],
    });
    const views = correlateCapturedListViews([reqMsg], [respBody]);
    expect(views).toEqual([
      { entityName: 'Materials__c', filterName: '00B4p000005DAqlEAG', filterTitle: 'All Active Processed Materials' },
    ]);
  });

  it('parseGetItemsRequest pulls entityName + filterName out of a message', () => {
    const req = parseGetItemsRequest(
      JSON.stringify({
        actions: [{ id: '5;a', descriptor: GETITEMS_DESCRIPTOR, params: { entityName: 'X__c', filterName: 'f1', offset: 0 } }],
      }),
    );
    expect(req).toEqual({ actionId: '5;a', entityName: 'X__c', filterName: 'f1' });
  });
});

// ── resolveFilterName: runtime > override > observed > null ───────────────────

describe('resolveFilterName — strict precedence, never guesses', () => {
  const processed = BACKFILL_LIST_VIEWS.find((b) => b.slug === 'processed_active')!;
  const consumer = BACKFILL_LIST_VIEWS.find((b) => b.slug === 'consumer_drop_off_rc')!;

  it('prefers an operator override above everything', () => {
    const runtime: CapturedListView[] = [
      { entityName: 'Materials__c', filterName: 'RUNTIME_ID', filterTitle: 'All Active Processed Materials' },
    ];
    expect(resolveFilterName(processed, runtime, { processed_active: 'OVERRIDE_ID' })).toBe('OVERRIDE_ID');
  });

  it('uses a runtime capture matched by object + title when no override', () => {
    const runtime: CapturedListView[] = [
      { entityName: 'Materials__c', filterName: 'RUNTIME_ID', filterTitle: 'All Active Processed Materials' },
    ];
    expect(resolveFilterName(processed, runtime, {})).toBe('RUNTIME_ID');
  });

  it('falls back to the observed live id when nothing else resolves', () => {
    expect(resolveFilterName(processed, [], {})).toBe('00B4p000005DAqlEAG');
  });

  it('returns null (fail-loud upstream) when a view has no observed id and no runtime/override', () => {
    expect(consumer.observedFilterName).toBeNull();
    expect(resolveFilterName(consumer, [], {})).toBeNull();
  });

  it('does NOT cross-match a title that belongs to a different object', () => {
    const wrongObject: CapturedListView[] = [
      { entityName: 'Haul_Request__c', filterName: 'HAUL_ID', filterTitle: 'All Active Processed Materials' },
    ];
    // processed binding is Materials__c → the Haul-object capture must not match.
    expect(resolveFilterName(processed, wrongObject, {})).toBe('00B4p000005DAqlEAG');
  });
});

// ── BACKFILL_LIST_VIEWS integrity ────────────────────────────────────────────

describe('BACKFILL_LIST_VIEWS — the 8 cursors (active + history) of the 4 real objects', () => {
  it('covers exactly the backfill-targets cursor keys, including the history views', () => {
    const keys = BACKFILL_LIST_VIEWS.map((b: ListViewBinding) => `${b.objectApiName}/${b.slug}`).sort();
    expect(keys).toEqual(
      [
        'Dock_Availability_Schedule__c/',
        'Haul_Request__c/consumer_drop_off_rc',
        'Haul_Request__c/docking_appointments_rc',
        'Haul_Request__c/completed_hauls',
        'Materials__c/outbound_active',
        'Materials__c/outbound_inactive',
        'Materials__c/processed_active',
        'Materials__c/processed_inactive',
      ].sort(),
    );
  });
  it('carries the 6 observed live ids and leaves the 2 uncaptured null', () => {
    const observed = BACKFILL_LIST_VIEWS.filter((b) => b.observedFilterName !== null);
    expect(observed.map((b) => b.slug).sort()).toEqual(
      ['completed_hauls', 'docking_appointments_rc', 'outbound_active', 'outbound_inactive', 'processed_active', 'processed_inactive'].sort(),
    );
    const uncaptured = BACKFILL_LIST_VIEWS.filter((b) => b.observedFilterName === null);
    expect(uncaptured.map((b) => b.slug).sort()).toEqual(['', 'consumer_drop_off_rc'].sort());
  });
  it('pins the confirmed live history-view ids (guards against silent drift)', () => {
    const bySlug = (slug: string): ListViewBinding =>
      BACKFILL_LIST_VIEWS.find((b) => b.slug === slug)!;
    expect(bySlug('completed_hauls').observedFilterName).toBe('00B4p000005DAqSEAW');
    expect(bySlug('processed_inactive').observedFilterName).toBe('00BUJ000001sJxx2AE');
    expect(bySlug('outbound_inactive').observedFilterName).toBe('00BUJ000001sJuj2AE');
    // Materials history views bind to the Materials object (routed by Type__c at detail).
    expect(bySlug('processed_inactive').objectApiName).toBe('Materials__c');
    expect(bySlug('outbound_inactive').objectApiName).toBe('Materials__c');
    // Completed Hauls binds to the haul object → same mymrc_hauls_mirror as the active views.
    expect(bySlug('completed_hauls').objectApiName).toBe('Haul_Request__c');
  });
});
