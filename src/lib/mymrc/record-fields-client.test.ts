// ADR-0057 D3 addendum — batched getRecordWithFields transport (record-fields-client).
//
// Pure codec + the createRecordFieldsClient retry/self-heal loop, exercised against
// a FAITHFUL fake RecordFieldsSession (no Playwright, no live portal). The fake
// serves a multi-action Aura envelope shaped exactly like the live response — one
// action per requested id, echoing `action.id`, `returnValue` = the record rep —
// so the by-action-id correlation, the SUCCESS/ERROR isolation, and the
// optionalFields bounding are all proven on the real wire shape.

import { describe, expect, it, vi } from 'vitest';
import {
  buildGetRecordWithFieldsFormFields,
  buildGetRecordWithFieldsMessage,
  chunkIds,
  createRecordFieldsClient,
  GETRECORD_WITH_FIELDS_DESCRIPTOR,
  HAUL_OPTIONAL_FIELDS,
  MATERIALS_OPTIONAL_FIELDS,
  optionalFieldsForFeed,
  parseGetRecordWithFieldsResponse,
  type RecordFieldsSession,
} from './record-fields-client';
import { AuthFailedError, PortalContractDriftError } from './portal-client';
import type { AuraFrameworkParams } from './list-page';

const FRAMEWORK: AuraFrameworkParams = {
  auraContext: '{"fwuid":"FAKE","app":"siteforce:communityApp"}',
  auraToken: 'csrf-tok',
  auraPageUri: '/s/hauls',
};

/** Build a live-shaped SUCCESS action returnValue (a record rep) for an id. */
function sfRecord(id: string, fields: Record<string, { value: unknown; displayValue?: string | null }> = {}) {
  return {
    apiName: 'Haul_Request__c',
    id,
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { displayValue: v.displayValue ?? null, value: v.value }]),
    ),
  };
}

/**
 * A multi-action Aura response body: one action per (actionId, record) with an
 * echoed id + SUCCESS returnValue, plus optional ERROR actions.
 */
function auraBody(
  successes: Array<{ id: string; record: ReturnType<typeof sfRecord> }>,
  errors: Array<{ id: string; message: string }> = [],
): string {
  const actions = [
    ...successes.map((s) => ({ id: s.id, state: 'SUCCESS', returnValue: s.record })),
    ...errors.map((e) => ({ id: e.id, state: 'ERROR', error: [{ message: e.message }] })),
  ];
  return JSON.stringify({ actions, context: {}, perfSummary: {} });
}

// ── Codec: message + form fields ─────────────────────────────────────────────

describe('buildGetRecordWithFieldsMessage', () => {
  it('emits one getRecordWithFields action per id, correlating action.id → recordId', () => {
    const { message, correlation } = buildGetRecordWithFieldsMessage(
      ['a2K1', 'a2K2', 'a2K3'],
      ['Haul_Request__c.Name', 'Haul_Request__c.Recycler_Program_Unit_Count__c'],
    );
    const parsed = JSON.parse(message) as {
      actions: Array<{ id: string; descriptor: string; callingDescriptor: string; params: { recordId: string; optionalFields: string[] } }>;
    };
    expect(parsed.actions).toHaveLength(3);
    expect(parsed.actions.every((a) => a.descriptor === GETRECORD_WITH_FIELDS_DESCRIPTOR)).toBe(true);
    // action.id is the batch index and maps back to the recordId.
    expect(parsed.actions.map((a) => [a.id, a.params.recordId])).toEqual([
      ['0', 'a2K1'],
      ['1', 'a2K2'],
      ['2', 'a2K3'],
    ]);
    expect(correlation.get('0')).toBe('a2K1');
    expect(correlation.get('2')).toBe('a2K3');
    // optionalFields (NOT fields) carries the exact requested set on every action.
    expect(parsed.actions[0]!.params.optionalFields).toEqual([
      'Haul_Request__c.Name',
      'Haul_Request__c.Recycler_Program_Unit_Count__c',
    ]);
  });
});

describe('buildGetRecordWithFieldsFormFields', () => {
  it('reuses the captured framework envelope verbatim (fwuid-drift-immune)', () => {
    const { formFields } = buildGetRecordWithFieldsFormFields(FRAMEWORK, ['a2K1'], ['Haul_Request__c.Name']);
    expect(formFields['aura.context']).toBe(FRAMEWORK.auraContext);
    expect(formFields['aura.token']).toBe(FRAMEWORK.auraToken);
    expect(formFields['aura.pageURI']).toBe(FRAMEWORK.auraPageUri);
    expect(typeof formFields['message']).toBe('string');
  });
});

describe('optionalFieldsForFeed — the mapper field set per feed', () => {
  it('hauls → HAUL set (incl. billing + relationship fields); materials → MATERIALS set', () => {
    expect(optionalFieldsForFeed('hauls')).toBe(HAUL_OPTIONAL_FIELDS);
    expect(optionalFieldsForFeed('processed')).toBe(MATERIALS_OPTIONAL_FIELDS);
    expect(optionalFieldsForFeed('outbound')).toBe(MATERIALS_OPTIONAL_FIELDS);
    // The billing-critical haul fields the mapper reads are all requested.
    expect(HAUL_OPTIONAL_FIELDS).toContain('Haul_Request__c.Recycler_Program_Unit_Count__c');
    expect(HAUL_OPTIONAL_FIELDS).toContain('Haul_Request__c.Recycler_Non_Program_Unit_Count__c');
    expect(HAUL_OPTIONAL_FIELDS).toContain('Haul_Request__c.Recycler_Weight__c');
    // Fully-qualified relationship field (FLS-safe, resolves the site discriminator).
    expect(HAUL_OPTIONAL_FIELDS).toContain('Haul_Request__c.Recycling_Center_Lookup__r.Name');
    // Materials billing counts.
    expect(MATERIALS_OPTIONAL_FIELDS).toContain('Materials__c.Number_of_Program_Units__c');
    expect(MATERIALS_OPTIONAL_FIELDS).toContain('Materials__c.Account__r.Name');
  });
});

describe('chunkIds', () => {
  it('splits into ≤size chunks, never a zero-size chunk', () => {
    expect(chunkIds(['1', '2', '3', '4', '5'], 2)).toEqual([['1', '2'], ['3', '4'], ['5']]);
    expect(chunkIds(['1', '2'], 0)).toEqual([['1'], ['2']]); // clamps to ≥1
    expect(chunkIds([], 100)).toEqual([]);
  });
});

// ── Codec: response parse ────────────────────────────────────────────────────

describe('parseGetRecordWithFieldsResponse', () => {
  it('correlates each action by its echoed id → recordId (multi-action)', () => {
    const correlation = new Map([
      ['0', 'a2K1'],
      ['1', 'a2K2'],
      ['2', 'a2K3'],
    ]);
    const body = auraBody([
      { id: '0', record: sfRecord('a2K1', { Recycler_Program_Unit_Count__c: { value: 110 } }) },
      { id: '1', record: sfRecord('a2K2', { Recycler_Program_Unit_Count__c: { value: 0 } }) },
      { id: '2', record: sfRecord('a2K3', { Recycler_Program_Unit_Count__c: { value: 7 } }) },
    ]);
    const res = parseGetRecordWithFieldsResponse(body, correlation);
    expect(res.malformed).toBe(false);
    expect(res.records.size).toBe(3);
    expect(res.records.get('a2K1')!.fields['Recycler_Program_Unit_Count__c']!.value).toBe(110);
    expect(res.records.get('a2K3')!.fields['Recycler_Program_Unit_Count__c']!.value).toBe(7);
    expect(res.errors).toEqual([]);
  });

  it('isolates per-action SUCCESS/ERROR — one FLS/deleted id does not drop the rest', () => {
    const correlation = new Map([
      ['0', 'good1'],
      ['1', 'bad2'],
      ['2', 'good3'],
    ]);
    const body = auraBody(
      [
        { id: '0', record: sfRecord('good1') },
        { id: '2', record: sfRecord('good3') },
      ],
      [{ id: '1', message: 'INSUFFICIENT_ACCESS: entity is not accessible' }],
    );
    const res = parseGetRecordWithFieldsResponse(body, correlation);
    expect([...res.records.keys()].sort()).toEqual(['good1', 'good3']);
    expect(res.errors).toEqual([
      { recordId: 'bad2', state: 'ERROR', message: 'INSUFFICIENT_ACCESS: entity is not accessible' },
    ]);
  });

  it('normalizes the record id to the CORRELATED recordId (upsert-key safe)', () => {
    const correlation = new Map([['0', 'wanted-id']]);
    // returnValue carries a different id — the parser must key by the correlation.
    const body = auraBody([{ id: '0', record: sfRecord('SOME-OTHER-ID') }]);
    const res = parseGetRecordWithFieldsResponse(body, correlation);
    expect(res.records.has('wanted-id')).toBe(true);
    expect(res.records.get('wanted-id')!.id).toBe('wanted-id');
  });

  it('ignores stray framework actions whose id is not in the correlation', () => {
    const correlation = new Map([['0', 'a2K1']]);
    const body = JSON.stringify({
      actions: [
        { id: '0', state: 'SUCCESS', returnValue: sfRecord('a2K1') },
        { id: 'aura://ComponentController', state: 'SUCCESS', returnValue: { some: 'framework thing' } },
      ],
    });
    const res = parseGetRecordWithFieldsResponse(body, correlation);
    expect(res.records.size).toBe(1);
    expect(res.errors).toEqual([]);
  });

  it('flags a logged-out / non-JSON body as malformed (never throws)', () => {
    expect(parseGetRecordWithFieldsResponse('<html>login</html>', new Map()).malformed).toBe(true);
    expect(parseGetRecordWithFieldsResponse('', new Map()).malformed).toBe(true);
    // Aura anti-JSON-hijack guard prefix is stripped before parse.
    const guarded = 'while(1);' + auraBody([{ id: '0', record: sfRecord('a2K1') }]);
    const res = parseGetRecordWithFieldsResponse(guarded, new Map([['0', 'a2K1']]));
    expect(res.malformed).toBe(false);
    expect(res.records.has('a2K1')).toBe(true);
  });
});

// ── Transport: createRecordFieldsClient (retry / self-heal / envelope reuse) ──

interface FakeSessionOpts {
  framework?: AuraFrameworkParams | null;
  /** Response for the Nth POST (0-based). A string is a 200 body; {status,body} sets the code. */
  responses: Array<string | { status: number; body: string }>;
  loggedOut?: boolean[]; // isLoggedOut() answer per call
  recoverThrows?: boolean;
}

function makeSession(opts: FakeSessionOpts): {
  session: RecordFieldsSession;
  postBodies: string[];
  captureCount: () => number;
  recoverCount: () => number;
} {
  let postIndex = 0;
  let loggedOutIndex = 0;
  let captures = 0;
  let recovers = 0;
  const postBodies: string[] = [];
  const session: RecordFieldsSession = {
    captureEnvelope: vi.fn(async () => {
      captures += 1;
      return opts.framework === undefined ? FRAMEWORK : opts.framework;
    }),
    postAura: vi.fn(async (formFields: Record<string, string>) => {
      postBodies.push(formFields['message']!);
      const r = opts.responses[postIndex] ?? opts.responses[opts.responses.length - 1]!;
      postIndex += 1;
      return typeof r === 'string' ? { status: 200, body: r } : r;
    }),
    isLoggedOut: vi.fn(async () => {
      const v = opts.loggedOut?.[loggedOutIndex] ?? false;
      loggedOutIndex += 1;
      return v;
    }),
    recover: vi.fn(async () => {
      recovers += 1;
      if (opts.recoverThrows) throw new AuthFailedError('mymrc: still logged out after re-auth');
    }),
    persistIfAuthenticated: vi.fn(async () => undefined),
  };
  return { session, postBodies, captureCount: () => captures, recoverCount: () => recovers };
}

describe('createRecordFieldsClient — happy path', () => {
  it('captures the envelope once, POSTs the batch, returns the record map', async () => {
    const { session, captureCount } = makeSession({
      responses: [auraBody([
        { id: '0', record: sfRecord('a2K1', { Recycler_Program_Unit_Count__c: { value: 42 } }) },
        { id: '1', record: sfRecord('a2K2', { Recycler_Program_Unit_Count__c: { value: 9 } }) },
      ])],
    });
    const client = createRecordFieldsClient(session, { sleep: async () => undefined });

    const res = await client.fetchRecordFields(['a2K1', 'a2K2'], HAUL_OPTIONAL_FIELDS);

    expect(res.records.size).toBe(2);
    expect(res.records.get('a2K1')!.fields['Recycler_Program_Unit_Count__c']!.value).toBe(42);
    expect(res.errors).toEqual([]);
    expect(captureCount()).toBe(1);
  });

  it('reuses ONE captured envelope across multiple batches', async () => {
    const { session, captureCount } = makeSession({
      responses: [
        auraBody([{ id: '0', record: sfRecord('a') }]),
        auraBody([{ id: '0', record: sfRecord('b') }]),
      ],
    });
    const client = createRecordFieldsClient(session, { sleep: async () => undefined });
    await client.fetchRecordFields(['a'], ['Haul_Request__c.Name']);
    await client.fetchRecordFields(['b'], ['Haul_Request__c.Name']);
    expect(captureCount()).toBe(1); // envelope captured once, reused
  });

  it('an empty id list short-circuits (no POST, no capture)', async () => {
    const { session, captureCount } = makeSession({ responses: [] });
    const client = createRecordFieldsClient(session);
    const res = await client.fetchRecordFields([], HAUL_OPTIONAL_FIELDS);
    expect(res.records.size).toBe(0);
    expect(captureCount()).toBe(0);
    expect(session.postAura).not.toHaveBeenCalled();
  });
});

describe('createRecordFieldsClient — retry / backoff', () => {
  it('retries a non-200 then succeeds', async () => {
    const { session } = makeSession({
      responses: [{ status: 503, body: 'busy' }, auraBody([{ id: '0', record: sfRecord('a') }])],
    });
    const client = createRecordFieldsClient(session, { sleep: async () => undefined });
    const res = await client.fetchRecordFields(['a'], ['Haul_Request__c.Name']);
    expect(res.records.has('a')).toBe(true);
    expect(session.postAura).toHaveBeenCalledTimes(2);
  });

  it('throws PortalContractDriftError after exhausting attempts on persistent non-200', async () => {
    const { session } = makeSession({ responses: [{ status: 500, body: 'boom' }] });
    const client = createRecordFieldsClient(session, { sleep: async () => undefined, maxAttempts: 3 });
    await expect(client.fetchRecordFields(['a'], ['Haul_Request__c.Name'])).rejects.toBeInstanceOf(
      PortalContractDriftError,
    );
    expect(session.postAura).toHaveBeenCalledTimes(3);
  });
});

describe('createRecordFieldsClient — logged-out self-heal', () => {
  it('recovers once (rebuild + re-login + re-capture envelope) then succeeds', async () => {
    const { session, captureCount, recoverCount } = makeSession({
      // 1st POST: logged-out redirect (malformed); after recover, 2nd POST succeeds.
      responses: ['<html>login</html>', auraBody([{ id: '0', record: sfRecord('a') }])],
      loggedOut: [true], // the check after the malformed body
    });
    const client = createRecordFieldsClient(session, { sleep: async () => undefined });
    const res = await client.fetchRecordFields(['a'], ['Haul_Request__c.Name']);
    expect(res.records.has('a')).toBe(true);
    expect(recoverCount()).toBe(1);
    expect(captureCount()).toBe(2); // re-captured after the heal
  });

  it('throws AuthFailedError when the session stays logged-out after re-auth', async () => {
    const { session } = makeSession({
      responses: ['<html>login</html>', '<html>login</html>'],
      loggedOut: [true, true],
    });
    const client = createRecordFieldsClient(session, { sleep: async () => undefined });
    await expect(client.fetchRecordFields(['a'], ['Haul_Request__c.Name'])).rejects.toBeInstanceOf(
      AuthFailedError,
    );
  });

  it('propagates AuthFailedError when recover() itself fails', async () => {
    const { session } = makeSession({
      responses: ['<html>login</html>'],
      loggedOut: [true],
      recoverThrows: true,
    });
    const client = createRecordFieldsClient(session, { sleep: async () => undefined });
    await expect(client.fetchRecordFields(['a'], ['Haul_Request__c.Name'])).rejects.toBeInstanceOf(
      AuthFailedError,
    );
  });
});

describe('createRecordFieldsClient — no envelope', () => {
  it('throws PortalContractDriftError when the envelope cannot be captured', async () => {
    const { session } = makeSession({ framework: null, responses: [] });
    const client = createRecordFieldsClient(session, { sleep: async () => undefined });
    await expect(client.fetchRecordFields(['a'], ['Haul_Request__c.Name'])).rejects.toBeInstanceOf(
      PortalContractDriftError,
    );
  });
});
