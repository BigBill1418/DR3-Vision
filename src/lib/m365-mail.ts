// T-114 — M365 Graph mail-send (ADR-0021).
//
// Delivers the signed monthly bonus PDF to payroll@svdp.us via Microsoft
// Graph `POST /users/{from}/sendMail`, authenticating as the DR3-Vision
// Entra app (client_credentials, `.default` scope). Intra-tenant delivery
// (dr3-vision@svdp.us → payroll@svdp.us) bypasses external spam filtering.
//
// Node-only: pulls @azure/identity + @microsoft/microsoft-graph-client and
// @/lib/prisma. Never import from edge/client code.
//
// Hard rule #5 — FAIL-OPEN: if the Entra credentials or the from-address
// are unset, this LOGS and RETURNS { disabled: true } — it never throws.
// The app must boot and serve without M365 configured (e.g. before the
// operator drops m365.env on CHAD-HQ per the setup runbook).
//
// Retry policy (ADR-0021 §Retry policy):
//   - 5 retries, base 1s, max 32s between attempts (exponential)
//   - retry on 429 / 503 / 504 / network errors
//   - refresh credential + retry ONCE on 401
//   - surface immediately (no retry) on 400 / 403
//
// On exhausted failure: publish `dr3-vision-system` ntfy with fingerprint
// `bonus-mail-failed:<month-id>`, leave the month state as-is (this helper
// never advances to `paid`), write a failure audit row, and increment the
// `payrollDeliverySuccess{outcome="failed"}` metric.
//
// Generalised: the transport core (`sendSystemEmail`) is reusable by future
// system emails; `sendPayrollPdf` is the bonus-specific wrapper that adds
// month persistence + ntfy fingerprinting.

import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { publishNtfy } from '@/lib/ntfy';
import { payrollDeliverySuccess } from '@/lib/observability/metrics';
import { log, newRequestId } from '@/lib/observability/logger';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 32_000;

// ────────────────────────────────────────────────────────────────────────
// Inline-attachment size ceiling
// ────────────────────────────────────────────────────────────────────────
//
// `buildMessage` attaches every file as an inline `#microsoft.graph.fileAttachment`
// with the bytes base64-encoded into `contentBytes`. Graph accepts that shape only
// while the whole `sendMail` request stays under 3 MB; a larger message has to be
// built as a draft plus `createUploadSession` (implemented below, ADR-0114).
// Base64 costs 4 bytes per 3 raw bytes, so a 2.3 MB PDF already exceeds the
// ceiling on its own.
//
// Before this guard existed there was NO size check on this path, and
// `sendSystemEmail` does not throw — an oversized attachment produced a rejected
// request that the caller recorded as an ordinary failed send, or (worse) a
// delivery the caller never learned had not happened. Both the AP stamped-invoice
// mail and the reimbursement decision mail carry operator-supplied originals of
// unbounded size through here, so the exposure was real on both.
//
// The check therefore returns a STRUCTURED refusal (`SystemEmailResult.oversize`)
// naming the ceiling, the measured cost and the files responsible. It never
// throws: a decision that is already committed must not be rolled back by an
// attachment that would not fit.
//
// ── ADR-0114 (2026-08-19) — the refusal was only ever HALF the transport ─────
// The guard above was correct and did its job: AP request acb03895 was decided
// (rejected) and the refusal is why nobody believed accounting had been told.
// But a refusal is not a delivery. `sendMail` with inline `contentBytes` is the
// SMALL-message shape; Graph's large-attachment shape — draft + per-attachment
// upload session + send — was never built, so every message above 3 MB was
// unsendable rather than merely un-inline-able. That is the half this module was
// missing, and it is why re-sending acb03895 through the old transport could
// never have worked.
//
// The whole-message ceiling is now the EXCHANGE TRANSPORT limit, not the Graph
// request limit, and the inline/draft choice is an internal implementation
// detail of `sendSystemEmail`. Callers are unchanged.
export const GRAPH_INLINE_SEND_LIMIT_BYTES = 3 * 1024 * 1024;

// Graph REFUSES `createUploadSession` for a file under 3 MB with
// `ErrorAttachmentSizeShouldNotBeLessThanMinimumSize` — the upload session is
// documented for files "between 3 MB and 150 MB". This is the single most
// load-bearing fact in the draft path and the reason it is not simply "route
// everything oversize through an upload session":
//
//   acb03895's four stamped artifacts are 85 KB / ~1.3 MB / ~1.4 MB / ~1.4 MB.
//   Not one of them reaches 3 MB. The message is oversize by their SUM, so a
//   naive per-message switch would open an upload session per file and Graph
//   would reject EVERY one of them.
//
// So the draft path routes each attachment by ITS OWN size, exactly as the docs
// instruct ("choose the approach for each file based on its file size"): small
// files POST to the `attachments` navigation property, large files get a session.
// https://learn.microsoft.com/graph/outlook-large-attachments
export const GRAPH_UPLOAD_SESSION_MIN_BYTES = 3 * 1024 * 1024;

// Max bytes per ranged PUT. Graph caps a single `PUT` at 4 MB; we use 3.75 MiB
// (a multiple of 320 KiB, the conventional Graph chunk quantum) so a boundary
// rounding error can never push a range over the cap.
export const GRAPH_UPLOAD_CHUNK_BYTES = 3_932_160;

// The REAL ceiling: Exchange Online's per-message send limit, which applies to
// the assembled MIME (so base64 inflation still counts). Microsoft's default for
// a Microsoft 365 mailbox is 35 MB; an admin can raise it toward Graph's 150 MB
// attachment maximum. Deliberately env-overridable so raising the tenant limit
// does not require a deploy — and clamped, so a typo cannot set a ceiling that
// is either unsendable or a lie.
export const EXCHANGE_MESSAGE_LIMIT_DEFAULT_BYTES = 35 * 1024 * 1024;
export const EXCHANGE_MESSAGE_LIMIT_MAX_BYTES = 150 * 1024 * 1024;

/** The configured whole-message ceiling, clamped to [inline limit, 150 MB]. */
export function messageLimitBytes(): number {
  const raw = Number(process.env['M365_MAIL_MAX_MESSAGE_BYTES']?.trim());
  if (!Number.isFinite(raw) || raw <= 0) return EXCHANGE_MESSAGE_LIMIT_DEFAULT_BYTES;
  return Math.min(Math.max(Math.floor(raw), GRAPH_INLINE_SEND_LIMIT_BYTES), EXCHANGE_MESSAGE_LIMIT_MAX_BYTES);
}

// The ceiling covers the whole request, not just `contentBytes`. We charge the
// HTML body at its real byte length and reserve a fixed allowance for the JSON
// scaffolding (subject, recipients, per-attachment `name`/`contentType`/`@odata.type`
// keys). Deliberately generous — refusing a message that would have squeaked
// through is recoverable; posting one that Graph rejects is the failure mode.
const GRAPH_ENVELOPE_HEADROOM_BYTES = 64 * 1024;

// Status codes that warrant a backoff-retry (transient). 401 is handled
// separately (refresh + retry once). 400/403 surface immediately.
const RETRYABLE_STATUS = new Set([429, 503, 504]);

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

export interface SendPayrollPdfArgs {
  monthId: string;
  pdfBuffer: Buffer;
  filename: string;
  subject: string;
  htmlBody: string;
  isAmendment: boolean;
}

export interface SendPayrollPdfResult {
  /** True when Graph accepted the message (202). */
  delivered: boolean;
  /** True when M365 is not configured — fail-open no-op, not a failure. */
  disabled: boolean;
  /** Our generated client-request-id, persisted for Exchange-trace correlation. */
  messageId?: string;
}

export interface SystemEmailArgs {
  /** Plain recipient address, or an address + optional display name. */
  to: string | { address: string; name?: string };
  subject: string;
  htmlBody: string;
  /** Optional single PDF attachment. */
  attachment?: { filename: string; buffer: Buffer; contentType?: string };
  /**
   * Optional additional attachments (ADR-0046 §3 amendment — the AP decision
   * mail carries a stamped PDF, potentially alongside `attachment`). Appended
   * after `attachment` if both are present.
   */
  attachments?: Array<{ filename: string; buffer: Buffer; contentType?: string }>;
  /** Graph `importance`. */
  importance?: 'low' | 'normal' | 'high';
  // ADR-0034 additions — all optional; existing callers are unaffected.
  /**
   * Override the sender display name. The mailbox is still the configured
   * `M365_MAIL_FROM_ADDRESS`; the app must have SendAs permission for it.
   */
  fromDisplayName?: string;
  /** Reply-To address (Graph `replyTo`). */
  replyTo?: string;
  /** CC addresses (Graph `ccRecipients`). */
  cc?: string[];
}

/**
 * Why a message was refused before it was ever posted to Graph. Present ONLY on
 * the too-large outcome; `null` on every other result, including ordinary send
 * failures. Carries the numbers an operator needs to act (shrink the attachment
 * to at most `limitBytes - overheadBytes` of base64, i.e. roughly three quarters
 * of that in raw bytes) rather than a bare boolean.
 */
export interface OversizeAttachmentReport {
  /**
   * WHICH ceiling was exceeded — the thing an operator needs before they can act.
   * Since ADR-0114 the upload-session path handles everything between the Graph
   * inline limit and the Exchange transport limit, so `graph-inline` is no longer
   * reachable from `sendSystemEmail`: a refusal now means the message is too big
   * for the MAILBOX, not too big for one Graph request. The field exists so the
   * message says which, rather than making the reader infer it from a number.
   */
  ceiling: 'graph-inline' | 'exchange-message';
  /** The ceiling that was exceeded, in bytes. */
  limitBytes: number;
  /** What the attachments actually cost on the wire, base64-encoded. */
  encodedAttachmentBytes: number;
  /** The same attachments before base64 inflation — what the caller handed us. */
  rawAttachmentBytes: number;
  /** HTML body bytes + the reserved envelope allowance, charged against the same ceiling. */
  overheadBytes: number;
  /** The attachment filenames that make up `rawAttachmentBytes`, in order. */
  filenames: string[];
}

export interface SystemEmailResult {
  delivered: boolean;
  disabled: boolean;
  messageId: string;
  /** Total backoff-retries consumed (excludes the initial attempt and any 401 refresh). */
  retries: number;
  /** Last error status code observed on a failed send, if any. */
  lastStatus: number | undefined;
  /**
   * Set when the message exceeded the Graph inline-attachment ceiling and was
   * REFUSED without being posted. `delivered` is false and `lastStatus` is
   * undefined (no request was made, so there is no status to report). Callers
   * must surface this distinctly from a transport failure: nothing was sent, the
   * cause is the payload rather than the network, and a retry cannot help.
   */
  oversize: OversizeAttachmentReport | null;
  /**
   * Which Graph shape actually carried the message. `inline` is the single
   * `sendMail` POST; `upload-session` is draft + per-attachment upload + send.
   * Observability only — no caller branches on it, and both mean delivered when
   * `delivered` is true.
   */
  transport: 'inline' | 'upload-session';
}

// ────────────────────────────────────────────────────────────────────────
// Test seams — graph client factory + sleep. Production uses the real ones.
// ────────────────────────────────────────────────────────────────────────

type GraphClientFactory = () => Client;

function defaultClientFactory(): Client {
  // Read late so the fail-open env check has already guaranteed presence.
  const credential = new ClientSecretCredential(
    process.env['AUTH_MICROSOFT_ENTRA_ID_TENANT_ID'] as string,
    process.env['AUTH_MICROSOFT_ENTRA_ID_ID'] as string,
    process.env['AUTH_MICROSOFT_ENTRA_ID_SECRET'] as string,
  );
  return Client.initWithMiddleware({
    authProvider: new TokenCredentialAuthenticationProvider(credential, {
      scopes: [GRAPH_SCOPE],
    }),
  });
}

let clientFactory: GraphClientFactory = defaultClientFactory;
let sleepFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
// The upload-session PUTs bypass the Graph client (pre-authenticated URL), so
// they need their own seam to be testable.
let fetchFn: typeof fetch = (input, init) => fetch(input, init);

// ────────────────────────────────────────────────────────────────────────
// Env / config
// ────────────────────────────────────────────────────────────────────────

interface M365Config {
  fromMailbox: string;
  payrollTo: string;
}

/**
 * Returns the config when fully present, or null when ANY required value is
 * missing — the fail-open signal. We require the three Entra credentials and
 * the from-address; the payroll to-address is only needed by sendPayrollPdf.
 */
function readConfig(): M365Config | null {
  const tenant = process.env['AUTH_MICROSOFT_ENTRA_ID_TENANT_ID']?.trim();
  const clientId = process.env['AUTH_MICROSOFT_ENTRA_ID_ID']?.trim();
  const secret = process.env['AUTH_MICROSOFT_ENTRA_ID_SECRET']?.trim();
  const fromMailbox = process.env['M365_MAIL_FROM_ADDRESS']?.trim();
  const payrollTo = process.env['M365_PAYROLL_TO_ADDRESS']?.trim();

  if (!tenant || !clientId || !secret || !fromMailbox) {
    return null;
  }
  return { fromMailbox, payrollTo: payrollTo ?? '' };
}

// ────────────────────────────────────────────────────────────────────────
// Error classification
// ────────────────────────────────────────────────────────────────────────

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const sc = (err as { statusCode?: unknown }).statusCode;
    if (typeof sc === 'number' && sc > 0) return sc;
  }
  return undefined;
}

/** A network/transport error has no HTTP status — treat as transient. */
function isNetworkError(err: unknown): boolean {
  return statusOf(err) === undefined;
}

function backoffDelay(attemptIndex: number): number {
  // attemptIndex is 0-based for the first retry.
  return Math.min(BACKOFF_BASE_MS * 2 ** attemptIndex, BACKOFF_MAX_MS);
}

// ────────────────────────────────────────────────────────────────────────
// Graph send — generalised transport core
// ────────────────────────────────────────────────────────────────────────

/** `attachment` then `attachments` — the exact order `buildMessage` posts them in. */
function collectAttachments(
  args: SystemEmailArgs,
): Array<{ filename: string; buffer: Buffer; contentType?: string }> {
  return [...(args.attachment ? [args.attachment] : []), ...(args.attachments ?? [])];
}

/** Base64 cost of `n` raw bytes: 4 output bytes per 3 input bytes, padded. */
function base64Cost(n: number): number {
  return Math.ceil(n / 3) * 4;
}

/**
 * Measure a message against {@link GRAPH_INLINE_SEND_LIMIT_BYTES}. Returns null
 * when it fits, or the report naming why it does not. Pure — no I/O, no env
 * reads — so the same verdict holds in every environment.
 */
export function checkInlineSendBudget(args: SystemEmailArgs): OversizeAttachmentReport | null {
  const attachments = collectAttachments(args);
  if (attachments.length === 0) return null;

  const rawAttachmentBytes = attachments.reduce((n, a) => n + a.buffer.byteLength, 0);
  const encodedAttachmentBytes = attachments.reduce(
    (n, a) => n + base64Cost(a.buffer.byteLength),
    0,
  );
  const overheadBytes = Buffer.byteLength(args.htmlBody, 'utf8') + GRAPH_ENVELOPE_HEADROOM_BYTES;

  // Strictly under the ceiling — Graph's documented limit is "less than 3 MB".
  if (encodedAttachmentBytes + overheadBytes < GRAPH_INLINE_SEND_LIMIT_BYTES) return null;

  return {
    ceiling: 'graph-inline',
    limitBytes: GRAPH_INLINE_SEND_LIMIT_BYTES,
    encodedAttachmentBytes,
    rawAttachmentBytes,
    overheadBytes,
    filenames: attachments.map((a) => a.filename),
  };
}

/**
 * How this message must be sent. Pure — no I/O, no client — so the routing
 * decision is inspectable and testable without a Graph double.
 *
 * The order matters and is the whole point of ADR-0114: `inline` is preferred
 * (one request, no draft to leak), `upload-session` is the FLOOR under it, and
 * `refuse` is reachable only above the mailbox's own transport limit — the point
 * past which no Graph shape can help and the honest answer is to say so.
 */
export type SendPlan =
  | { mode: 'inline' }
  | { mode: 'upload-session'; messageLimitBytes: number }
  | { mode: 'refuse'; report: OversizeAttachmentReport };

export function planSend(args: SystemEmailArgs): SendPlan {
  const inlineOverflow = checkInlineSendBudget(args);
  if (!inlineOverflow) return { mode: 'inline' };

  // Over the inline ceiling. The draft path can carry it as long as the whole
  // message still fits what the mailbox will transmit. Charge the SAME measured
  // cost: Exchange's limit applies to assembled MIME, which is base64 too.
  const limit = messageLimitBytes();
  const cost = inlineOverflow.encodedAttachmentBytes + inlineOverflow.overheadBytes;
  if (cost < limit) return { mode: 'upload-session', messageLimitBytes: limit };

  return {
    mode: 'refuse',
    report: { ...inlineOverflow, ceiling: 'exchange-message', limitBytes: limit },
  };
}

function buildMessage(args: SystemEmailArgs, requestId: string, senderMailbox: string) {
  const recipient =
    typeof args.to === 'string'
      ? { emailAddress: { address: args.to } }
      : {
          emailAddress: {
            address: args.to.address,
            ...(args.to.name ? { name: args.to.name } : {}),
          },
        };

  const message: Record<string, unknown> = {
    subject: args.subject,
    body: { contentType: 'HTML', content: args.htmlBody },
    toRecipients: [recipient],
    importance: args.importance ?? 'normal',
  };

  if (args.fromDisplayName) {
    // The 'from' field overrides the default sender display name; mailbox must
    // still be one the app has SendAs permission for.
    message['from'] = {
      emailAddress: {
        address: senderMailbox,
        name: args.fromDisplayName,
      },
    };
  }

  if (args.replyTo) {
    message['replyTo'] = [{ emailAddress: { address: args.replyTo } }];
  }

  if (args.cc && args.cc.length > 0) {
    message['ccRecipients'] = args.cc.map((addr) => ({ emailAddress: { address: addr } }));
  }

  // Snapshot before attachments are folded in — see `messageWithoutAttachments`.
  const bareMessage: Record<string, unknown> = { ...message };

  const allAttachments = collectAttachments(args);
  if (allAttachments.length > 0) {
    message['attachments'] = allAttachments.map((a) => fileAttachmentBody(a));
  }
  return {
    // The message WITHOUT attachments — what the draft path POSTs to
    // `/messages` before attaching each file individually. Built by omission
    // rather than by a second builder so the draft and the inline send can
    // never drift on subject, recipients, from, replyTo, cc or importance.
    messageWithoutAttachments: bareMessage,
    requestPayload: { message, saveToSentItems: true },
    // We stamp our own client-request-id so the 202 (which carries no body)
    // is still correlatable in Exchange message trace.
    requestId,
  };
}

/** The Graph `fileAttachment` body for one file — shared by both transports. */
function fileAttachmentBody(a: { filename: string; buffer: Buffer; contentType?: string }) {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.filename,
    contentType: a.contentType ?? 'application/pdf',
    contentBytes: a.buffer.toString('base64'),
  };
}

async function postOnce(
  client: Client,
  fromMailbox: string,
  payload: unknown,
  requestId: string,
): Promise<void> {
  await client
    .api(`/users/${fromMailbox}/sendMail`)
    .header('client-request-id', requestId)
    .post(payload);
}

// ────────────────────────────────────────────────────────────────────────
// Retry session — ONE policy, shared by both transports
// ────────────────────────────────────────────────────────────────────────
//
// The ADR-0021 policy (5 backoff retries on 429/503/504/network; one credential
// refresh on 401; immediate surface on 400/403) was written for a single
// `sendMail` POST. The draft path makes 3..N+2 calls, and re-deriving the policy
// per call site is how the two transports would drift. So the policy lives here
// once and BOTH use it. The budget is per SEND, not per call: a draft flow that
// burns its retries creating the draft does not get a fresh five for the upload.

interface RetrySession {
  run<T>(op: (client: Client) => Promise<T>): Promise<T>;
  readonly retries: number;
  readonly lastStatus: number | undefined;
}

/** Thrown when the retry budget is exhausted or the error is non-retryable. */
class GraphCallFailed extends Error {
  constructor(
    readonly status: number | undefined,
    readonly cause_: unknown,
  ) {
    super(`graph call failed (status ${status ?? 'network'})`);
    this.name = 'GraphCallFailed';
  }
}

function newRetrySession(requestId: string): RetrySession {
  let client = clientFactory();
  let retries = 0;
  let refreshedOn401 = false;
  let lastStatus: number | undefined;

  return {
    get retries() {
      return retries;
    },
    get lastStatus() {
      return lastStatus;
    },
    async run<T>(op: (c: Client) => Promise<T>): Promise<T> {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          return await op(client);
        } catch (err) {
          const status = statusOf(err);
          lastStatus = status;

          // 401 — token expired/invalid: rebuild the client (forces a fresh
          // token acquisition) and retry exactly once per SEND. Does not consume
          // a backoff-retry budget.
          if (status === 401 && !refreshedOn401) {
            refreshedOn401 = true;
            log.warn(
              { requestId },
              '[m365-mail] 401 from Graph — refreshing credential and retrying once',
            );
            client = clientFactory();
            continue;
          }

          // 400/403 (and a repeat 401) — surface immediately, do not retry.
          if (status === 400 || status === 403 || status === 401) {
            log.error({ requestId, status }, '[m365-mail] non-retryable Graph error');
            throw new GraphCallFailed(status, err);
          }

          const transient =
            (status !== undefined && RETRYABLE_STATUS.has(status)) || isNetworkError(err);
          if (!transient) {
            log.error({ requestId, status }, '[m365-mail] unexpected non-retryable Graph error');
            throw new GraphCallFailed(status, err);
          }

          if (attempt >= MAX_RETRIES) {
            log.error({ requestId, status, retries }, '[m365-mail] retries exhausted');
            throw new GraphCallFailed(status, err);
          }

          retries += 1;
          const delay = backoffDelay(attempt);
          log.warn(
            { requestId, status, attempt: attempt + 1, delay },
            '[m365-mail] transient error, backing off',
          );
          await sleepFn(delay);
        }
      }
      // Unreachable: the loop either returns or throws.
      throw new GraphCallFailed(lastStatus, undefined);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Large-attachment transport — draft + upload sessions + send (ADR-0114)
// ────────────────────────────────────────────────────────────────────────

/** Byte ranges for one file, honouring Graph's ≤4 MB-per-PUT cap. */
export function chunkRanges(
  totalBytes: number,
  chunkBytes: number = GRAPH_UPLOAD_CHUNK_BYTES,
): Array<{ start: number; end: number }> {
  if (totalBytes <= 0) return [];
  const out: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < totalBytes; start += chunkBytes) {
    // `end` is INCLUSIVE — Graph's `Content-Range: bytes {start}-{end}/{total}`
    // is an inclusive closed range, so the last chunk ends at total-1, never at
    // total. An off-by-one here uploads a byte that does not exist (400) or
    // silently drops the last byte of every file.
    out.push({ start, end: Math.min(start + chunkBytes, totalBytes) - 1 });
  }
  return out;
}

/**
 * PUT one file's bytes to a pre-authenticated upload-session URL.
 *
 * Deliberately a raw `fetch`, NOT the Graph client: the `uploadUrl` already
 * carries its own auth token in the query string and lives on
 * `outlook.office.com`. Microsoft's docs are explicit that an `Authorization`
 * header must NOT be sent — the Graph client would attach one.
 */
async function uploadAttachmentBytes(
  uploadUrl: string,
  buffer: Buffer,
  session: RetrySession,
  requestId: string,
  filename: string,
): Promise<void> {
  const total = buffer.byteLength;
  for (const { start, end } of chunkRanges(total)) {
    const slice = buffer.subarray(start, end + 1);
    // Each chunk retries under the SHARED budget, so a flaky upload cannot
    // retry forever across many chunks.
    await session.run(async () => {
      const res = await fetchFn(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(slice.byteLength),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
        body: new Uint8Array(slice),
      });
      if (!res.ok) {
        // Normalise to the `{ statusCode }` shape `statusOf` classifies, so an
        // upload 429 backs off exactly like a Graph 429.
        throw Object.assign(new Error(`upload chunk failed (${res.status})`), {
          statusCode: res.status,
        });
      }
      return res;
    });
    log.debug(
      { requestId, filename, start, end, total },
      '[m365-mail] uploaded attachment chunk',
    );
  }
}

interface DraftSendOutcome {
  delivered: boolean;
  lastStatus: number | undefined;
  retries: number;
}

/**
 * Send a message too large for one inline `sendMail`, via Graph's documented
 * large-attachment shape: create a draft, attach each file by the approach its
 * OWN size demands, then send the draft.
 *
 * ── Failure honesty ─────────────────────────────────────────────────────────
 * A draft is real, persistent mailbox state. If anything after its creation
 * fails, the draft is DELETED before returning — otherwise a failed send leaves
 * a half-built message sitting in Drafts that a person could later send by hand,
 * or that a retry would duplicate. `delivered` is true ONLY after the `send`
 * action returns cleanly, because the AP caller stamps `decision_mail_sent_at`
 * from it and that column must mean "Mary was told", not "we tried".
 * If the cleanup itself fails we log loudly and still report failure — an
 * orphaned draft is a mess, but reporting a delivery that did not happen is a
 * lie, and only one of those two is recoverable by a person.
 */
async function sendViaDraft(
  args: SystemEmailArgs,
  fromMailbox: string,
  requestId: string,
): Promise<DraftSendOutcome> {
  const session = newRetrySession(requestId);
  const { messageWithoutAttachments } = buildMessage(args, requestId, fromMailbox);
  const attachments = collectAttachments(args);
  let draftId: string | undefined;

  try {
    const draft = (await session.run((c) =>
      c
        .api(`/users/${fromMailbox}/messages`)
        .header('client-request-id', requestId)
        .post(messageWithoutAttachments),
    )) as { id?: string } | undefined;

    draftId = draft?.id;
    if (!draftId) {
      // No id means we cannot attach, send, or clean up — refuse rather than
      // guess at an id.
      log.error({ requestId }, '[m365-mail] draft creation returned no message id');
      return { delivered: false, lastStatus: session.lastStatus, retries: session.retries };
    }

    for (const att of attachments) {
      const size = att.buffer.byteLength;
      if (size < GRAPH_UPLOAD_SESSION_MIN_BYTES) {
        // Under Graph's session floor — `createUploadSession` would fail with
        // ErrorAttachmentSizeShouldNotBeLessThanMinimumSize. POST it directly.
        await session.run((c) =>
          c
            .api(`/users/${fromMailbox}/messages/${draftId}/attachments`)
            .header('client-request-id', requestId)
            .post(fileAttachmentBody(att)),
        );
        log.info(
          { requestId, filename: att.filename, size },
          '[m365-mail] attached small file directly to draft',
        );
        continue;
      }

      const uploadSession = (await session.run((c) =>
        c
          .api(`/users/${fromMailbox}/messages/${draftId}/attachments/createUploadSession`)
          .header('client-request-id', requestId)
          .post({
            AttachmentItem: {
              attachmentType: 'file',
              name: att.filename,
              size,
              contentType: att.contentType ?? 'application/pdf',
            },
          }),
      )) as { uploadUrl?: string } | undefined;

      const uploadUrl = uploadSession?.uploadUrl;
      if (!uploadUrl) {
        log.error(
          { requestId, filename: att.filename },
          '[m365-mail] createUploadSession returned no uploadUrl',
        );
        throw new GraphCallFailed(undefined, new Error('no uploadUrl'));
      }
      await uploadAttachmentBytes(uploadUrl, att.buffer, session, requestId, att.filename);
      log.info(
        { requestId, filename: att.filename, size },
        '[m365-mail] uploaded large file to draft via upload session',
      );
    }

    await session.run((c) =>
      c
        .api(`/users/${fromMailbox}/messages/${draftId}/send`)
        .header('client-request-id', requestId)
        .post({}),
    );

    return { delivered: true, lastStatus: session.lastStatus, retries: session.retries };
  } catch (err) {
    log.error(
      {
        requestId,
        draftId,
        status: err instanceof GraphCallFailed ? err.status : undefined,
        err: err instanceof Error ? err.message : String(err),
      },
      '[m365-mail] large-attachment send failed',
    );
    if (draftId) await discardDraft(fromMailbox, draftId, requestId);
    return { delivered: false, lastStatus: session.lastStatus, retries: session.retries };
  }
}

/**
 * Best-effort removal of a draft whose send never completed. Uses a FRESH
 * session: the failing one may have exhausted its retry budget, and cleanup
 * must not be skipped because the send that preceded it was unlucky.
 */
async function discardDraft(
  fromMailbox: string,
  draftId: string,
  requestId: string,
): Promise<void> {
  try {
    await newRetrySession(requestId).run((c) =>
      c.api(`/users/${fromMailbox}/messages/${draftId}`).delete(),
    );
    log.info({ requestId, draftId }, '[m365-mail] discarded the draft of a failed send');
  } catch (err) {
    log.error(
      { requestId, draftId, err: err instanceof Error ? err.message : String(err) },
      '[m365-mail] ORPHANED DRAFT — send failed and the draft could not be deleted; it is sitting in the sender mailbox Drafts folder and must be removed by hand',
    );
  }
}

/**
 * Send one email via Graph with the full retry/refresh policy. Returns a
 * structured result; NEVER throws (fail-open / fail-soft at the boundary).
 * Callers own audit + ntfy + persistence semantics.
 */
export async function sendSystemEmail(args: SystemEmailArgs): Promise<SystemEmailResult> {
  const requestId = newRequestId();

  // Checked BEFORE the config gate on purpose: the budget is a property of the
  // payload, not of the environment, so an attachment that Graph would reject in
  // production is reported as too-large in dev and CI too — where M365 is
  // unconfigured and the send would otherwise return a clean `disabled` that hides
  // it. Nothing is posted, so ordering costs nothing.
  const plan = planSend(args);
  if (plan.mode === 'refuse') {
    const oversize = plan.report;
    log.error(
      {
        requestId,
        ceiling: oversize.ceiling,
        limitBytes: oversize.limitBytes,
        encodedAttachmentBytes: oversize.encodedAttachmentBytes,
        rawAttachmentBytes: oversize.rawAttachmentBytes,
        overheadBytes: oversize.overheadBytes,
        filenames: oversize.filenames,
      },
      '[m365-mail] message exceeds the mailbox send limit — REFUSED, nothing was sent',
    );
    return {
      delivered: false,
      disabled: false,
      messageId: requestId,
      retries: 0,
      lastStatus: undefined,
      oversize,
      transport: 'inline',
    };
  }

  const config = readConfig();

  if (!config) {
    log.warn('[m365-mail] M365 not configured, mail-send disabled (fail-open)');
    return {
      delivered: false,
      disabled: true,
      messageId: requestId,
      retries: 0,
      lastStatus: undefined,
      oversize: null,
      transport: 'inline',
    };
  }

  if (plan.mode === 'upload-session') {
    log.info(
      {
        requestId,
        messageLimitBytes: plan.messageLimitBytes,
        attachmentCount: collectAttachments(args).length,
      },
      '[m365-mail] message exceeds the inline ceiling — sending via draft + upload sessions',
    );
    const outcome = await sendViaDraft(args, config.fromMailbox, requestId);
    return {
      delivered: outcome.delivered,
      disabled: false,
      messageId: requestId,
      retries: outcome.retries,
      lastStatus: outcome.lastStatus,
      oversize: null,
      transport: 'upload-session',
    };
  }

  const { requestPayload } = buildMessage(args, requestId, config.fromMailbox);
  const session = newRetrySession(requestId);

  try {
    await session.run((c) => postOnce(c, config.fromMailbox, requestPayload, requestId));
    return {
      delivered: true,
      disabled: false,
      messageId: requestId,
      retries: session.retries,
      lastStatus: session.lastStatus,
      oversize: null,
      transport: 'inline',
    };
  } catch {
    // `newRetrySession` has already logged the reason and classified the status;
    // this boundary never throws (fail-soft) — it reports.
    return {
      delivered: false,
      disabled: false,
      messageId: requestId,
      retries: session.retries,
      lastStatus: session.lastStatus,
      oversize: null,
      transport: 'inline',
    };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Public API — bonus payroll wrapper
// ────────────────────────────────────────────────────────────────────────

/**
 * Deliver the signed monthly bonus PDF to payroll. Wraps the generalised
 * transport with bonus-specific persistence, audit, ntfy, and metrics.
 *
 * Fail-open: when M365 is not configured returns { disabled: true } without
 * touching the DB, ntfy, or metrics. The month state is never advanced to
 * `paid` here — on success it records delivery metadata; on exhausted
 * failure it leaves the month untouched and alerts the operator.
 */
export async function sendPayrollPdf(args: SendPayrollPdfArgs): Promise<SendPayrollPdfResult> {
  const config = readConfig();
  if (!config) {
    log.warn(
      { monthId: args.monthId },
      '[m365-mail] M365_MAIL_FROM_ADDRESS / Entra creds not configured — payroll mail-send disabled (fail-open)',
    );
    return { delivered: false, disabled: true };
  }

  const result = await sendSystemEmail({
    to: config.payrollTo,
    subject: args.subject,
    htmlBody: args.htmlBody,
    attachment: { filename: args.filename, buffer: args.pdfBuffer, contentType: 'application/pdf' },
    importance: args.isAmendment ? 'high' : 'normal',
  });

  const auditAfter = {
    subject: args.subject,
    recipient: config.payrollTo,
    filename: args.filename,
    is_amendment: args.isAmendment,
    graph_request_id: result.messageId,
    retry_count: result.retries,
    response_status: result.lastStatus ?? (result.delivered ? 202 : undefined),
    // `too_large` is deliberately its own status rather than `failed`: nothing was
    // posted, retrying cannot help, and the operator action is to shrink the PDF —
    // not to re-send. Recording it as `failed` would send them chasing Graph.
    status: result.delivered ? 'sent' : result.oversize ? 'too_large' : 'failed',
    ...(result.oversize
      ? {
          oversize_limit_bytes: result.oversize.limitBytes,
          oversize_encoded_bytes: result.oversize.encodedAttachmentBytes,
          oversize_raw_bytes: result.oversize.rawAttachmentBytes,
        }
      : {}),
  };

  if (result.delivered) {
    // Persist delivery metadata. State is intentionally NOT advanced to
    // `paid` — that transition is owned by the caller/operator flow.
    await prisma.bonusPayPeriod.update({
      where: { id: args.monthId },
      data: {
        payroll_sent_at: new Date(),
        payroll_message_id: result.messageId,
        ...(result.retries > 0 ? { payroll_retry_count: { increment: result.retries } } : {}),
      },
    });
    await writeAudit({
      actor_label: 'system:m365-mail-send',
      action: 'update',
      table_name: 'bonus_pay_periods',
      row_id: args.monthId,
      after: auditAfter,
    });
    if (result.retries > 0) payrollDeliverySuccess.inc({ outcome: 'retry' });
    payrollDeliverySuccess.inc({ outcome: 'success' });
    return { delivered: true, disabled: false, messageId: result.messageId };
  }

  // Exhausted / non-retryable failure. Record retry attempts (if any),
  // alert the operator, and leave the month state as-is (still `signed`).
  if (result.retries > 0) {
    await prisma.bonusPayPeriod.update({
      where: { id: args.monthId },
      data: { payroll_retry_count: { increment: result.retries } },
    });
    payrollDeliverySuccess.inc({ outcome: 'retry' });
  }

  await writeAudit({
    actor_label: 'system:m365-mail-send',
    action: 'update',
    table_name: 'bonus_pay_periods',
    row_id: args.monthId,
    after: auditAfter,
  });

  await publishNtfy({
    topic: 'dr3-vision-system',
    title: result.oversize
      ? 'Bonus payroll mail REFUSED — PDF too large to attach'
      : 'Bonus payroll mail delivery failed',
    body: result.oversize
      ? `The bonus PDF for month ${args.monthId} is ${Math.round(
          result.oversize.rawAttachmentBytes / 1024,
        )} KB, which exceeds the ${Math.round(
          result.oversize.limitBytes / 1024,
        )} KB per-message limit on the sending mailbox (base64 inflates the bytes by a third, and that inflated size is what counts). Nothing was sent to ${
          config.payrollTo
        } and retrying will not help. The month remains signed. Shrink the PDF, then re-send from the manager portal.`
      : `Graph sendMail to ${config.payrollTo} failed for month ${args.monthId} after ${result.retries} retries (last status ${result.lastStatus ?? 'network'}). PDF generated; month remains signed. Retry from the manager portal.`,
    priority: 'high',
    tags: ['error', 'bonus', 'payroll', 'dr3-vision'],
    fingerprint: result.oversize
      ? `bonus-mail-too-large:${args.monthId}`
      : `bonus-mail-failed:${args.monthId}`,
  });

  payrollDeliverySuccess.inc({ outcome: 'failed' });
  return { delivered: false, disabled: false, messageId: result.messageId };
}

// ────────────────────────────────────────────────────────────────────────
// Test seam
// ────────────────────────────────────────────────────────────────────────

export const __testing = {
  setClientFactory: (f: GraphClientFactory): void => {
    clientFactory = f;
  },
  resetClientFactory: (): void => {
    clientFactory = defaultClientFactory;
  },
  setSleep: (f: (ms: number) => Promise<void>): void => {
    sleepFn = f;
  },
  setFetch: (f: typeof fetch): void => {
    fetchFn = f;
  },
  resetFetch: (): void => {
    fetchFn = (input, init) => fetch(input, init);
  },
  backoffDelay,
  statusOf,
  chunkRanges,
};
