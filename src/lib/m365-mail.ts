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
  /** Plain recipient address. */
  to: string;
  subject: string;
  htmlBody: string;
  /** Optional single PDF attachment. */
  attachment?: { filename: string; buffer: Buffer; contentType?: string };
  /** Graph `importance`. */
  importance?: 'low' | 'normal' | 'high';
}

interface SystemEmailResult {
  delivered: boolean;
  disabled: boolean;
  messageId: string;
  /** Total backoff-retries consumed (excludes the initial attempt and any 401 refresh). */
  retries: number;
  /** Last error status code observed on a failed send, if any. */
  lastStatus: number | undefined;
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

function buildMessage(args: SystemEmailArgs, requestId: string) {
  const message: Record<string, unknown> = {
    subject: args.subject,
    body: { contentType: 'HTML', content: args.htmlBody },
    toRecipients: [{ emailAddress: { address: args.to } }],
    importance: args.importance ?? 'normal',
  };
  if (args.attachment) {
    message['attachments'] = [
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: args.attachment.filename,
        contentType: args.attachment.contentType ?? 'application/pdf',
        contentBytes: args.attachment.buffer.toString('base64'),
      },
    ];
  }
  return {
    requestPayload: { message, saveToSentItems: true },
    // We stamp our own client-request-id so the 202 (which carries no body)
    // is still correlatable in Exchange message trace.
    requestId,
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

/**
 * Send one email via Graph with the full retry/refresh policy. Returns a
 * structured result; NEVER throws (fail-open / fail-soft at the boundary).
 * Callers own audit + ntfy + persistence semantics.
 */
async function sendSystemEmail(args: SystemEmailArgs): Promise<SystemEmailResult> {
  const config = readConfig();
  const requestId = newRequestId();

  if (!config) {
    log.warn('[m365-mail] M365 not configured, mail-send disabled (fail-open)');
    return {
      delivered: false,
      disabled: true,
      messageId: requestId,
      retries: 0,
      lastStatus: undefined,
    };
  }

  const { requestPayload } = buildMessage(args, requestId);

  let client = clientFactory();
  let retries = 0;
  let refreshedOn401 = false;
  let lastStatus: number | undefined;

  // attempt 0 = initial; up to MAX_RETRIES backoff retries on transient errors.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await postOnce(client, config.fromMailbox, requestPayload, requestId);
      return { delivered: true, disabled: false, messageId: requestId, retries, lastStatus };
    } catch (err) {
      const status = statusOf(err);
      lastStatus = status;

      // 401 — token expired/invalid: rebuild the client (forces a fresh
      // token acquisition) and retry exactly once. Does not consume a
      // backoff-retry budget.
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
        return { delivered: false, disabled: false, messageId: requestId, retries, lastStatus };
      }

      // Retryable transient (429/503/504) or network error.
      const transient =
        (status !== undefined && RETRYABLE_STATUS.has(status)) || isNetworkError(err);
      if (!transient) {
        log.error({ requestId, status }, '[m365-mail] unexpected non-retryable Graph error');
        return { delivered: false, disabled: false, messageId: requestId, retries, lastStatus };
      }

      if (attempt >= MAX_RETRIES) {
        log.error({ requestId, status, retries }, '[m365-mail] retries exhausted');
        break;
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

  return { delivered: false, disabled: false, messageId: requestId, retries, lastStatus };
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
    status: result.delivered ? 'sent' : 'failed',
  };

  if (result.delivered) {
    // Persist delivery metadata. State is intentionally NOT advanced to
    // `paid` — that transition is owned by the caller/operator flow.
    await prisma.bonusMonth.update({
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
      table_name: 'bonus_months',
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
    await prisma.bonusMonth.update({
      where: { id: args.monthId },
      data: { payroll_retry_count: { increment: result.retries } },
    });
    payrollDeliverySuccess.inc({ outcome: 'retry' });
  }

  await writeAudit({
    actor_label: 'system:m365-mail-send',
    action: 'update',
    table_name: 'bonus_months',
    row_id: args.monthId,
    after: auditAfter,
  });

  await publishNtfy({
    topic: 'dr3-vision-system',
    title: 'Bonus payroll mail delivery failed',
    body: `Graph sendMail to ${config.payrollTo} failed for month ${args.monthId} after ${result.retries} retries (last status ${result.lastStatus ?? 'network'}). PDF generated; month remains signed. Retry from the manager portal.`,
    priority: 'high',
    tags: ['error', 'bonus', 'payroll', 'dr3-vision'],
    fingerprint: `bonus-mail-failed:${args.monthId}`,
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
  backoffDelay,
  statusOf,
};
