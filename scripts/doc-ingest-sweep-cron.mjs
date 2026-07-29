#!/usr/bin/env node
// ADR-0067 §3.2 D4 — the document-ingestion delta-sweep daemon.
//
// Architecture (mirrors scripts/audit-sweep-cron.mjs → the internal route): this
// .mjs imports NOTHING — no @prisma/client, no tsx, no TS. It sleeps an interval,
// POSTs the internal, loopback-guarded route (`/api/internal/doc-ingest/sweep`)
// with the `INTERNAL_CRON_TOKEN` bearer when set, logs the outcome, and loops.
// The route does all the real work inside the Next app via `runDocIngestSweep`.
//
// ── Why an INTERVAL and not a nightly fire ──────────────────────────────────
// Every other cron here is anchored to a Pacific wall-clock time because it
// produces something a human reads at a particular hour. This one is different:
// it is the CORRECTNESS PATH for shared-file ingestion (§3.2 D4). It is not a
// report, it is the thing that guarantees a change is never missed when a
// webhook lapses or a notification is dropped — the failure that had MyMRC
// ingesting nothing for months (ADR-0057 D9). A nightly sweep would bound that
// blind window at 24 hours; a 15-minute interval bounds it at 15 minutes.
//
// It runs regardless of webhook health, by design. It never checks whether
// subscriptions exist and never skips because a notification arrived recently.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

/** Sweep cadence. Bounds the window in which a dropped notification is invisible. */
const DEFAULT_INTERVAL_MINUTES = 15;
const INTERVAL_MS =
  (Number.parseInt(process.env.DOC_INGEST_SWEEP_INTERVAL_MINUTES ?? '', 10) ||
    DEFAULT_INTERVAL_MINUTES) * 60_000;

/** Backoff after a failed POST, so a wedged app is not hammered every 15 minutes. */
const RETRY_MS = 60_000;

let stopping = false;

function logTs(message) {
  console.log(`[doc-ingest-sweep-cron ${new Date().toISOString()}] ${message}`);
}

/** Keep logged bodies short — an unexpected HTML page must not dump kilobytes. */
function truncateBody(text, max = 400) {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length} chars]`;
}

/**
 * Drive one sweep.
 *
 * `redirect: 'manual'` is load-bearing. If the auth middleware were ever missing
 * the `/api/internal/doc-ingest/` exemption it would 307 this POST to /login;
 * fetch's default redirect-following would turn that into the login page's 200
 * and the sweep would report SUCCESS while doing nothing at all. That is the
 * standing ADR-0036 regression, and it is worse here than anywhere else in this
 * repo — a silently no-op'ing correctness sweep reproduces exactly the failure
 * mode the sweep exists to prevent. A redirect is ALWAYS a failure here.
 */
async function runFireOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/doc-ingest/sweep`, {
    method: 'POST',
    headers,
    redirect: 'manual',
  });
  const text = await res.text();
  if (res.status !== 200) {
    const loc = res.headers.get('location');
    throw new Error(
      `HTTP ${res.status}${loc ? ` (redirect → ${loc})` : ''}: ${truncateBody(text)}`,
    );
  }
  return truncateBody(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  setupShutdown();
  logTs(`daemon starting — sweeping every ${INTERVAL_MS / 60_000} minutes`);

  while (!stopping) {
    try {
      const text = await runFireOnce();
      logTs(`sweep complete: ${text}`);
      await sleep(INTERVAL_MS);
    } catch (err) {
      // Non-fatal: the app may be restarting or mid-deploy. The route itself
      // records and pages a genuine sweep failure, so this only backs off.
      logTs(`sweep POST failed (non-fatal, retrying): ${err?.message ?? err}`);
      await sleep(RETRY_MS);
    }
  }
}

function setupShutdown() {
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logTs(`received ${signal}, exiting`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('doc-ingest-sweep-cron: fatal', err);
    process.exit(1);
  });
}

export { runFireOnce, truncateBody, INTERVAL_MS };
