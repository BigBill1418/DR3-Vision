// ADR-0046 D3/D5/C6 — the AP poll orchestrator.
//
// One tick: select transport (mock/live, self-reported) → delta-list the source
// folder → per message ingest to a single terminal state → move to Processed
// (hygiene; the internet_message_id UNIQUE key is the true idempotency guard) →
// persist the delta token → ALWAYS write an ap_poll_runs ledger row (incl. throw
// paths) → deadman check. A green run that read nothing while mail exists is
// impossible by construction (delta contract + ledger counts).

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { publishNtfy } from '@/lib/ntfy';
import {
  AuthFailedError,
  PROCESSED_FOLDER,
  SOURCE_FOLDER,
  loadDeltaToken,
  readGraphMailConfig,
  saveDeltaToken,
  selectTransport,
  type MailMessage,
  type MailTransport,
} from '@/lib/msgraph-mail';
import { alreadySeen, ingestMessage, quarantineMessage, type IngestOutcome } from './ingest';
import { apApproverEmails } from './approvals';
import { resolveSenderPolicy } from './senders';
import { alertDeadman } from './notify';

const DEADMAN_MINUTES = 45;

export type ApPollStatus = 'ok' | 'auth_failed' | 'error';
export type PollLogger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: PollLogger = () => undefined;

export interface RunApPollContext {
  prisma?: PrismaClient;
  /** Injected transport (tests). Production selects mock/live by env. */
  transport?: MailTransport;
  now?: () => Date;
  log?: PollLogger;
  sourceFolder?: string;
  processedFolder?: string;
  deadmanMinutes?: number;
  runId?: string;
}

export interface ApPollResult {
  status: ApPollStatus;
  transportMode: 'mock' | 'graph';
  messagesListed: number;
  requestsCreated: number;
  followupsCreated: number;
  quarantined: number;
  moved: number;
  duplicates: number;
  resynced: boolean;
  error: string | null;
  runId: string;
}

export async function runApPoll(ctx: RunApPollContext = {}): Promise<ApPollResult> {
  const prisma = ctx.prisma ?? defaultPrisma;
  const log = ctx.log ?? noopLog;
  const nowFn = ctx.now ?? ((): Date => new Date());
  const runId = ctx.runId ?? randomUUID();
  const transport = ctx.transport ?? selectTransport(log);
  const mode = transport.mode;
  const mailbox = readGraphMailConfig()?.mailbox ?? '(mock)';
  const sourceFolder = ctx.sourceFolder ?? SOURCE_FOLDER;
  const processedFolder = ctx.processedFolder ?? PROCESSED_FOLDER;
  const deadmanMinutes = ctx.deadmanMinutes ?? DEADMAN_MINUTES;
  const started = nowFn();
  const tag = `run=${runId} mode=${mode} mailbox=${mailbox}`;

  let status: ApPollStatus = 'ok';
  let error: string | null = null;
  let messagesListed = 0;
  let requestsCreated = 0;
  let followupsCreated = 0;
  let quarantined = 0;
  let duplicates = 0;
  let moved = 0;
  let resynced = false;

  // Deadman runs regardless of this tick's outcome (catches a wedged daemon).
  await checkApDeadman(prisma, deadmanMinutes, nowFn()).catch(() => undefined);

  try {
    const [policy, approverEmails] = await Promise.all([
      resolveSenderPolicy(prisma),
      apApproverEmails(prisma),
    ]);
    const token = await loadDeltaToken(mailbox, sourceFolder, prisma);
    const delta = await transport.listDelta(sourceFolder, token);
    messagesListed = delta.messages.length;
    resynced = delta.resynced;
    if (resynced) log('info', `[ap-poll] ${tag} full resync (no/expired delta token)`);

    const ingestCtx = { prisma, transport, policy, approverEmails, log };
    for (const msg of delta.messages) {
      let outcome: IngestOutcome;
      try {
        // The delta $select carries bodyPreview only (no `body`); hydrate the FULL
        // HTML+text body via getMessage BEFORE ingest so body_html_sanitized is the
        // real message, not the ~255-char preview. Skip already-seen messages so a
        // re-listed duplicate costs a cheap DB check, not a Graph round-trip. A
        // getMessage failure is a per-message failure — it falls through to the
        // quarantine handler below (C3: visible, never a silent drop).
        const full = await hydrateForIngest(msg);
        outcome = await ingestMessage(ingestCtx, full);
      } catch (e) {
        // An auth failure is a RUN-fatal session error, not a per-message poison —
        // rethrow it so the run fails closed as `auth_failed` and pages, rather than
        // mass-quarantining every good invoice in the folder + masking the outage.
        if (e instanceof AuthFailedError) throw e;
        // Poison message: any OTHER unexpected throw (a malformed message from
        // getMessage, a DB/parse error) must NOT abort the loop before the token
        // save, or the next poll re-fails on the same message forever. Quarantine it
        // (reason 'ingest_error') so the token can advance. If quarantining ITSELF
        // fails, rethrow — the token stays unsaved and the message re-lists next
        // poll rather than being silently lost.
        log(
          'error',
          `[ap-poll] ${tag} ingest threw for ${msg.id} (${describe(e)}) — quarantining as ingest_error`,
        );
        outcome = await quarantineMessage(ingestCtx, msg, 'ingest_error');
      }
      if (outcome.kind === 'created') requestsCreated += 1;
      else if (outcome.kind === 'followup') followupsCreated += 1;
      else if (outcome.kind === 'quarantined') quarantined += 1;
      else duplicates += 1;

      // Move to Processed (C9-D6): hygiene so a re-poll can't re-list. A move
      // failure is non-fatal — the UNIQUE key already prevents double-ingest.
      try {
        await transport.moveMessage(msg.id, processedFolder);
        moved += 1;
      } catch (e) {
        log(
          'warn',
          `[ap-poll] ${tag} move ${msg.id} → ${processedFolder} failed (non-fatal): ${describe(e)}`,
        );
      }
    }

    // Persist the new delta token only after a fully successful pass.
    await saveDeltaToken(mailbox, sourceFolder, delta.deltaToken, prisma);
    log(
      'info',
      `[ap-poll] ${tag} ok — listed=${messagesListed} created=${requestsCreated} followups=${followupsCreated} quarantined=${quarantined} dup=${duplicates} moved=${moved}`,
    );
  } catch (err) {
    if (err instanceof AuthFailedError) {
      status = 'auth_failed';
      error = err.message;
    } else {
      status = 'error';
      error = describe(err);
    }
    log('error', `[ap-poll] ${tag} FAILED (${status}) — ${error}`);
    await pageRunFailure(status, error).catch(() => undefined);
  }

  await finalizeLedger();
  return {
    status,
    transportMode: mode,
    messagesListed,
    requestsCreated,
    followupsCreated,
    quarantined,
    duplicates,
    moved,
    resynced,
    error,
    runId,
  };

  // Hydrate one delta-listed message to its full body, but ONLY when it is new —
  // an already-ingested duplicate skips the Graph round-trip (it will short-circuit
  // to a `duplicate` outcome in ingest on the cheap UNIQUE-key check).
  async function hydrateForIngest(msg: MailMessage): Promise<MailMessage> {
    if (msg.internetMessageId && (await alreadySeen(prisma, msg.internetMessageId))) return msg;
    return transport.getMessage(msg.id);
  }

  // Ledger row ALWAYS (C6). A ledger-write failure is logged with its error class,
  // never swallowed, and never fails the caller.
  async function finalizeLedger(): Promise<void> {
    try {
      await prisma.apPollRun.create({
        data: {
          started_at: started,
          finished_at: nowFn(),
          status,
          transport_mode: mode,
          mailbox: mode === 'graph' ? mailbox : null,
          folder: sourceFolder,
          messages_listed: messagesListed,
          requests_created: requestsCreated,
          followups_created: followupsCreated,
          quarantined,
          moved,
          error,
          run_id: runId,
        },
      });
    } catch (e) {
      log(
        'error',
        `[ap-poll] ${tag} LEDGER WRITE FAILED (${errorClass(e)}) status=${status} — ${describe(e)}`,
      );
    }
  }
}

async function pageRunFailure(status: ApPollStatus, message: string): Promise<void> {
  await publishNtfy({
    topic: 'dr3-vision-system',
    title: status === 'auth_failed' ? 'AP poll auth failed' : 'AP poll error',
    body: `${message}\n\nThe AP mailbox poll failed. Check the ap-poll container + the poll ledger.`,
    priority: 'high',
    tags: ['error', 'ap', status, 'dr3-vision'],
    clickUrl: 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision',
    fingerprint: `ap-poll-${status}`,
    cooldownMs: 30 * 60 * 1000,
  });
}

/**
 * Deadman: page when the last SUCCESSFUL poll is older than the threshold. Only
 * pages once a baseline `ok` run exists (a mailbox that has never succeeded is a
 * config/first-run state, surfaced by the run-failure page instead).
 */
export async function checkApDeadman(
  prisma: PrismaClient,
  thresholdMinutes: number,
  now: Date,
): Promise<void> {
  const lastOk = await prisma.apPollRun.findFirst({
    where: { status: 'ok' },
    orderBy: { started_at: 'desc' },
    select: { started_at: true },
  });
  if (!lastOk) return;
  const ageMs = now.getTime() - lastOk.started_at.getTime();
  if (ageMs < thresholdMinutes * 60 * 1000) return;
  const hours = Math.round(ageMs / 3.6e6);
  await alertDeadman(hours, thresholdMinutes);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor.name;
  return typeof err;
}
