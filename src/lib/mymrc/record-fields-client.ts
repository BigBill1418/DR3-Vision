// ADR-0057 Phase 1 (D3 addendum, 2026-07-22) — the BATCHED billing-field capture
// transport. Replaces the racy per-record `/s/detail/<id>` navigation-interception
// detail fetch (portal-client.fetchRecordDetail / backfill-portal-client) that
// captured ~0.4% of billing unit-counts because the billing-bearing
// getRecordWithFields response frequently landed outside the settle window.
//
// MECHANISM (PROVEN LIVE 2026-07-22 — see docs/mymrc-field-capture-architecture.md):
// replay `aura://RecordUiController/ACTION$getRecordWithFields` as a DIRECT
// `apiRequestContext.post` to `/s/sfsites/aura`, BATCHED ~100 record-ids per POST
// (N actions in one Aura `message.actions[]`), reusing the framework envelope
// captured once per run from an authenticated list page (`/s/hauls`) — the SAME
// fwuid-drift-immune direct-POST-replay transport that already solved list
// pagination (ladder #1). NO page navigation anywhere. Live sweep: 200 actions
// per POST → 200/200 SUCCESS, ~0.5 s, full billing fields present.
//
// KEY DESIGN POINTS:
//   • `optionalFields` (NOT `fields`) = the EXACT field set each mapper reads,
//     fully-qualified `Object__c.Field__c` incl. relationship fields. FLS-safe:
//     a hidden field is silently omitted instead of failing the whole action.
//   • `action.id` is the correlation key → `action.id → recordId`. Each
//     `action.returnValue` IS an `SfRecord` fed straight into the EXISTING
//     mappers/upsert — transport swap only, mirror schema UNCHANGED.
//   • Per-action SUCCESS/ERROR isolation: one FLS/deleted id ERRORs without
//     dropping the rest of the batch.
//   • Self-heal: a logged-out envelope rebuilds a clean context + re-logs-in
//     (hardened `openAdminSession`) and RE-CAPTURES the envelope, then retries.
//     A still-logged-out session after re-auth throws AuthFailedError (ADR-0038
//     D4 loud failure — never silent green).
//
// Bundle constraint: compiles standalone via tsconfig.mymrc.json — no `@/…`.

import type { AdminSession } from './portal-client';
import { AuthFailedError, PortalContractDriftError } from './portal-client';
import { AUTHED_HOME_URL, PORTAL_ORIGIN } from './selectors';
import { playwrightBackfillSession } from './backfill-portal-client';
import type { AuraFrameworkParams } from './list-page';
import type { FeedName, SfField, SfRecord } from './types';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

// ── The Aura action ──────────────────────────────────────────────────────────

/** The record-detail Aura descriptor (captured live; the detail page's rich record comes from this). */
export const GETRECORD_WITH_FIELDS_DESCRIPTOR =
  'aura://RecordUiController/ACTION$getRecordWithFields';

// ── optionalFields — the EXACT field set each mapper reads ────────────────────
//
// Fully-qualified `Object__c.Field__c`, incl. relationship fields. Kept in
// lock-step with mappers.ts: request exactly what the mapper reads, so the
// payload is bounded and FLS-safe (a hidden field is omitted, not an error).
// A field the record cannot expose (Materials Outbound_Vendor_Name__c /
// Shipment_Date__c are LIST-ONLY, absent from the detail set — see mappers.ts)
// is requested defensively and silently omitted; the mapper already falls back.

/** Fields `mapHaulRecord` reads from a `Haul_Request__c` record. */
export const HAUL_OPTIONAL_FIELDS: readonly string[] = [
  'Haul_Request__c.Name',
  'Haul_Request__c.Status__c',
  'Haul_Request__c.Type__c',
  'Haul_Request__c.Rate_ID__c',
  'Haul_Request__c.Recycling_Center_Lookup__c',
  'Haul_Request__c.Recycling_Center_Lookup__r.Name',
  'Haul_Request__c.Transporter__c',
  'Haul_Request__c.Collection_Site__c',
  'Haul_Request__c.Collection_Source__c',
  'Haul_Request__c.Commodity__c',
  'Haul_Request__c.Container_Type__c',
  'Haul_Request__c.Recycler_Program_Unit_Count__c',
  'Haul_Request__c.Recycler_Non_Program_Unit_Count__c',
  'Haul_Request__c.Unpaid_Consumer_Drop_Off_Units__c',
  'Haul_Request__c.Docking_Appointment_Date__c',
  'Haul_Request__c.Docking_Appointment_Time__c',
  'Haul_Request__c.Docking_Appointment_Dock_Door__c',
  'Haul_Request__c.Recycler_Weight__c',
] as const;

/** Fields `mapProcessedRecord` + `mapOutboundRecord` read from a `Materials__c` record (union). */
export const MATERIALS_OPTIONAL_FIELDS: readonly string[] = [
  'Materials__c.Name',
  'Materials__c.Type__c',
  'Materials__c.Account__c',
  'Materials__c.Account__r.Name',
  'Materials__c.Materials_Status__c',
  'Materials__c.BOL_ID__c',
  'Materials__c.Entry_Date__c',
  'Materials__c.Processed_Date__c',
  'Materials__c.Number_of_Program_Units__c',
  'Materials__c.Number_of_Non_Program_Units__c',
  // LIST-ONLY on the detail record (silently omitted, mapper falls back to null):
  'Materials__c.Outbound_Vendor_Name__c',
  'Materials__c.Shipment_Date__c',
] as const;

/** Fields `mapDockAvailabilityRecord` reads from a `Dock_Availability_Schedule__c` record. */
export const DOCK_OPTIONAL_FIELDS: readonly string[] = [
  'Dock_Availability_Schedule__c.Name',
  'Dock_Availability_Schedule__c.Status__c',
  'Dock_Availability_Schedule__c.Day_of_Week__c',
  'Dock_Availability_Schedule__c.Container_Type__c',
  'Dock_Availability_Schedule__c.Dock_Door__c',
  'Dock_Availability_Schedule__c.Slot_Start_Time__c',
  'Dock_Availability_Schedule__c.Slot_End_Time__c',
  'Dock_Availability_Schedule__c.Number_of_Available_Appointments__c',
  'Dock_Availability_Schedule__c.Availability_Start_Date__c',
] as const;

/** The mapper's field set for a steady-state feed (hauls → HAUL, processed/outbound → MATERIALS). */
export function optionalFieldsForFeed(feed: FeedName): readonly string[] {
  return feed === 'hauls' ? HAUL_OPTIONAL_FIELDS : MATERIALS_OPTIONAL_FIELDS;
}

// ── Pure codec (fixture-tested; no Playwright / no DB) ────────────────────────

/** Split ids into ≤`size` chunks (never a zero-size chunk). */
export function chunkIds<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.trunc(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/**
 * Build the batched `message` JSON: one getRecordWithFields action per record id,
 * all in ONE `actions[]`. `action.id` is the batch index (a string), and the
 * returned `correlation` maps that id back to the recordId so each response action
 * is attributed O(1) by its echoed id (never by cross-record walking).
 */
export function buildGetRecordWithFieldsMessage(
  recordIds: readonly string[],
  optionalFields: readonly string[],
): { message: string; correlation: Map<string, string> } {
  const correlation = new Map<string, string>();
  const actions = recordIds.map((recordId, i) => {
    const actionId = String(i);
    correlation.set(actionId, recordId);
    return {
      id: actionId,
      descriptor: GETRECORD_WITH_FIELDS_DESCRIPTOR,
      callingDescriptor: 'UNKNOWN',
      params: { recordId, optionalFields: [...optionalFields] },
    };
  });
  return { message: JSON.stringify({ actions }), correlation };
}

/**
 * The x-www-form-urlencoded form fields for a batched getRecordWithFields POST:
 * the captured framework envelope with the freshly-built batched `message`. Same
 * envelope contract as {@link import('./list-page').buildGetItemsFormFields}.
 */
export function buildGetRecordWithFieldsFormFields(
  framework: AuraFrameworkParams,
  recordIds: readonly string[],
  optionalFields: readonly string[],
): { formFields: Record<string, string>; correlation: Map<string, string> } {
  const { message, correlation } = buildGetRecordWithFieldsMessage(recordIds, optionalFields);
  return {
    formFields: {
      message,
      'aura.context': framework.auraContext,
      'aura.pageURI': framework.auraPageUri,
      'aura.token': framework.auraToken,
    },
    correlation,
  };
}

/** One record id that failed its action (FLS-hidden, deleted, or an Aura EXCEPTION). */
export interface BatchActionError {
  recordId: string;
  /** The Aura action `state` (e.g. 'ERROR', 'INCOMPLETE'). */
  state: string;
  message: string;
}

/** The parsed outcome of one batched getRecordWithFields POST. */
export interface BatchParseResult {
  /** recordId → SfRecord for every SUCCESS action (id normalized to the requested recordId). */
  records: Map<string, SfRecord>;
  /** Per-action non-SUCCESS results, named for retry/diagnosis (never silently dropped). */
  errors: BatchActionError[];
  /**
   * `true` when the body carried NO parseable `actions[]` envelope — a logged-out
   * redirect, an Aura anti-JSON-hijack guard prefix, or non-JSON. The caller
   * confirms the logged-out state via the live page before self-healing.
   */
  malformed: boolean;
}

/** A value shaped like a Salesforce RecordRepresentation (has apiName/id/fields). */
function looksLikeRecord(o: unknown): o is { apiName: string; id: string; fields: Record<string, SfField> } {
  if (!o || typeof o !== 'object') return false;
  const r = o as { apiName?: unknown; id?: unknown; fields?: unknown };
  return typeof r.apiName === 'string' && typeof r.id === 'string' && !!r.fields && typeof r.fields === 'object';
}

/** Extract a human message from an Aura action's error payload. */
function actionErrorMessage(action: { error?: unknown; state?: unknown }): string {
  const err = action.error;
  if (Array.isArray(err) && err.length > 0) {
    const first = err[0] as { message?: unknown } | undefined;
    if (first && typeof first.message === 'string') return first.message;
  }
  if (typeof err === 'string') return err;
  return `Aura action state=${String(action.state ?? 'unknown')}`;
}

// Salesforce Aura responses may carry a `while(1);` or a slash-star ERROR
// star-slash anti-JSON-hijack guard prefix; strip it before JSON.parse.
function stripAuraGuard(body: string): string {
  return body.replace(/^\s*(?:while\s*\(1\)\s*;|\/\*[^*]*\*\/)+/, '');
}

/**
 * Parse a batched getRecordWithFields Aura response into a recordId→SfRecord map
 * plus per-action errors, correlating each action by its ECHOED `id` (O(1), never
 * a recursive cross-record walk — avoids attributing one record's fields to
 * another). A SUCCESS action's `returnValue` IS the record; its `id` is normalized
 * to the requested recordId (the upsert key) so a mirror `where:{id}` always
 * matches. Actions whose echoed id is not in `correlation` are ignored (a stray
 * framework action). Never throws — a malformed/logged-out body sets `malformed`.
 */
export function parseGetRecordWithFieldsResponse(
  body: string,
  correlation: ReadonlyMap<string, string>,
): BatchParseResult {
  const records = new Map<string, SfRecord>();
  const errors: BatchActionError[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripAuraGuard(body));
  } catch {
    return { records, errors, malformed: true };
  }
  const actions =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { actions?: unknown }).actions)
      ? (parsed as { actions: Array<Record<string, unknown>> }).actions
      : null;
  if (actions === null) return { records, errors, malformed: true };

  for (const action of actions) {
    const actionId = typeof action['id'] === 'string' ? (action['id'] as string) : null;
    if (actionId === null) continue;
    const recordId = correlation.get(actionId);
    if (recordId === undefined) continue; // a stray non-record framework action

    const state = typeof action['state'] === 'string' ? (action['state'] as string) : 'UNKNOWN';
    if (state === 'SUCCESS' && looksLikeRecord(action['returnValue'])) {
      const rv = action['returnValue'] as { apiName: string; fields: Record<string, SfField> };
      // Normalize `id` to the CORRELATED recordId (the mirror upsert key) so the
      // downstream `where:{id}` never mismatches on an unexpected returnValue.id.
      records.set(recordId, { apiName: rv.apiName, id: recordId, fields: rv.fields });
      continue;
    }
    errors.push({
      recordId,
      state,
      message: actionErrorMessage(action as { error?: unknown; state?: unknown }),
    });
  }
  return { records, errors, malformed: false };
}

// ── Injectable session seam (the Playwright I/O boundary) ─────────────────────

/**
 * What the batch transport needs from the browser. Everything fragile lives
 * behind this so the retry/self-heal/parse logic is fake-testable with no
 * Playwright and no live portal.
 */
export interface RecordFieldsSession {
  /** Capture the Aura framework envelope from an authenticated list page (`/s/hauls`). Null if none seen. */
  captureEnvelope(): Promise<AuraFrameworkParams | null>;
  /** POST the batched form fields to the Aura endpoint → the raw HTTP status + body. */
  postAura(formFields: Record<string, string>): Promise<{ status: number; body: string }>;
  /** `true` when the live session currently looks logged-out. */
  isLoggedOut(): Promise<boolean>;
  /**
   * Rebuild a clean context + re-login (the hardened self-heal). Throws
   * AuthFailedError when the session stays logged-out — the loud-failure path.
   */
  recover(): Promise<void>;
  /** Persist the session snapshot ONLY when positively authenticated. */
  persistIfAuthenticated(): Promise<void>;
}

export interface RecordFieldsClientOptions {
  /** Total POST attempts per batch before a hard PortalContractDriftError. Default 5. */
  maxAttempts?: number;
  /** Exponential-backoff base (ms) for a non-200 / empty / EXCEPTION response. Default 1000. */
  backoffBaseMs?: number;
  /** Backoff ceiling (ms). Default 30000. */
  backoffMaxMs?: number;
  /** Injected sleep (test seam). Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

/** The batch transport the enrichment engine + steady-state sync depend on. */
export interface RecordFieldsClient {
  /**
   * Fetch billing fields for a batch of record ids in ONE POST. Returns per-id
   * SfRecords (SUCCESS) + per-id errors (FLS/deleted, retried next pass). Throws
   * AuthFailedError when the session is logged-out and cannot self-heal, or
   * PortalContractDriftError when the envelope can't be captured / the POST never
   * yields a parseable response.
   */
  fetchRecordFields(
    recordIds: readonly string[],
    optionalFields: readonly string[],
  ): Promise<BatchFetchResult>;
}

export interface BatchFetchResult {
  records: Map<string, SfRecord>;
  errors: BatchActionError[];
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a {@link RecordFieldsClient} over an injectable {@link RecordFieldsSession}.
 * Captures the framework envelope lazily (once per run, re-captured after a
 * self-heal), replays the batched getRecordWithFields POST with bounded
 * exponential backoff on a transient failure, and self-heals ONCE on a logged-out
 * envelope. A batch that stays unparseable after the attempt budget, or a session
 * that stays logged-out after re-auth, fails LOUD.
 */
export function createRecordFieldsClient(
  session: RecordFieldsSession,
  opts: RecordFieldsClientOptions = {},
): RecordFieldsClient {
  const log = opts.log ?? noopLog;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffBase = Math.max(0, opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
  const backoffMax = Math.max(backoffBase, opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS);
  const sleep = opts.sleep ?? realSleep;

  let envelope: AuraFrameworkParams | null = null;

  async function ensureEnvelope(): Promise<AuraFrameworkParams> {
    if (envelope) return envelope;
    const fw = await session.captureEnvelope();
    if (!fw) {
      throw new PortalContractDriftError(
        'record-fields: could not capture an Aura framework envelope from the list page — cannot replay getRecordWithFields',
      );
    }
    envelope = fw;
    return fw;
  }

  function backoffMs(attempt: number): number {
    return Math.min(backoffMax, backoffBase * 2 ** (attempt - 1));
  }

  async function fetchRecordFields(
    recordIds: readonly string[],
    optionalFields: readonly string[],
  ): Promise<BatchFetchResult> {
    if (recordIds.length === 0) return { records: new Map(), errors: [] };

    let selfHealed = false;
    for (let attempt = 1; ; attempt++) {
      const fw = await ensureEnvelope();
      const { formFields, correlation } = buildGetRecordWithFieldsFormFields(fw, recordIds, optionalFields);

      let resp: { status: number; body: string };
      try {
        resp = await session.postAura(formFields);
      } catch (err) {
        if (attempt >= maxAttempts) {
          throw new PortalContractDriftError(
            `record-fields: POST failed after ${attempt} attempt(s): ${describe(err)}`,
          );
        }
        log('warn', `record-fields: POST threw (attempt ${attempt}/${maxAttempts}), backing off: ${describe(err)}`);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (resp.status !== 200) {
        if (attempt >= maxAttempts) {
          throw new PortalContractDriftError(
            `record-fields: HTTP ${resp.status} after ${attempt} attempt(s) (batch of ${recordIds.length})`,
          );
        }
        log('warn', `record-fields: HTTP ${resp.status} (attempt ${attempt}/${maxAttempts}), backing off`);
        await sleep(backoffMs(attempt));
        continue;
      }

      const parsed = parseGetRecordWithFieldsResponse(resp.body, correlation);

      // A body with no parseable actions, OR a parseable body that attributed
      // NOTHING (no SUCCESS and no ERROR) to any requested id, is either a
      // logged-out envelope or a transient Aura EXCEPTION. Confirm against the
      // live page: logged-out → self-heal ONCE (rebuild + re-login + re-capture
      // envelope) then retry; otherwise back off and retry.
      if (parsed.malformed || (parsed.records.size === 0 && parsed.errors.length === 0)) {
        if (await session.isLoggedOut()) {
          if (selfHealed) {
            throw new AuthFailedError(
              'record-fields: still logged out after re-auth + envelope re-capture',
            );
          }
          selfHealed = true;
          log('warn', 'record-fields: logged-out envelope — self-healing (rebuild + re-login + re-capture)');
          await session.recover(); // throws AuthFailedError if unrecoverable
          envelope = null; // force a fresh envelope capture for the healed session
          continue;
        }
        if (attempt >= maxAttempts) {
          throw new PortalContractDriftError(
            `record-fields: response carried no SUCCESS/ERROR actions after ${attempt} attempt(s) ` +
              `(batch of ${recordIds.length}) — not logged out; likely an Aura EXCEPTION`,
          );
        }
        log('warn', `record-fields: empty/EXCEPTION response (attempt ${attempt}/${maxAttempts}), backing off`);
        await sleep(backoffMs(attempt));
        continue;
      }

      await session.persistIfAuthenticated();
      return { records: parsed.records, errors: parsed.errors };
    }
  }

  return { fetchRecordFields };
}

// ── Playwright adapter (the only untested-by-unit shell) ──────────────────────

const AURA_ENDPOINT = `${PORTAL_ORIGIN}/s/sfsites/aura`;

/**
 * Implement {@link RecordFieldsSession} over an {@link AdminSession}. Reuses the
 * hardened list-page envelope capture from {@link playwrightBackfillSession}
 * (`captureListPage('/s/hauls')`) — the SAME envelope that authenticates getItems
 * authenticates getRecordWithFields (proven live). The POST goes through the
 * context's own request API so the session cookie jar authenticates it with no
 * manual cookie handling. Self-heal reuses `openAdminSession`'s bounded, clean-
 * rebuild `ensureAuthenticated` (throws AuthFailedError when unrecoverable).
 */
export function playwrightRecordFieldsSession(admin: AdminSession, log: Logger = noopLog): RecordFieldsSession {
  const capture = playwrightBackfillSession(admin, log);
  return {
    async captureEnvelope() {
      const cap = await capture.captureListPage('/s/hauls');
      return cap.framework;
    },
    async postAura(formFields) {
      const resp = await admin.getContext().request.post(AURA_ENDPOINT, {
        form: formFields,
        headers: {
          'X-SFDC-Request-Id': 'dr3-record-fields',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
      });
      return { status: resp.status(), body: await resp.text() };
    },
    async isLoggedOut() {
      return admin.isLoginPage();
    },
    async recover() {
      // Navigate to the authed home so `ensureAuthenticated` sees the true logged-
      // out state, then let it rebuild a clean context + re-login (or throw).
      await admin.gotoWithRetry(AUTHED_HOME_URL, 'domcontentloaded');
      await admin.ensureAuthenticated(AUTHED_HOME_URL);
    },
    async persistIfAuthenticated() {
      await admin.persistIfAuthenticated();
    },
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
