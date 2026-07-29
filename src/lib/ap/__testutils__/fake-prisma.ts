// ADR-0046 — a minimal in-memory Prisma stand-in for deterministic AP unit tests.
//
// Implements ONLY the query shapes the AP modules use (see each model below),
// including the two behaviours the tests depend on: the internet_message_id
// UNIQUE constraint (create throws a P2002-shaped error) and the conditional
// updateMany count (first-action-wins). It is NOT a general Prisma emulator.

import { Prisma } from '@prisma/client';

let seq = 0;
const uid = (p: string): string => `${p}-${++seq}`;

function p2002(target: string): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });
}

export interface FakeApRequest {
  id: string;
  status:
    | 'pending'
    | 'pending_review'
    | 'pending_second_approval'
    | 'approved'
    | 'rejected'
    | 'quarantined';
  internet_message_id: string;
  conversation_id: string | null;
  received_at: Date;
  sender_address: string;
  sender_validated: boolean;
  subject: string | null;
  body_html_sanitized: string | null;
  body_text: string | null;
  vendor: string | null;
  amount_cents: number | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  decision_mail_sent_at: Date | null;
  quarantine_reason: string | null;
  // ADR-0046 §3 amendment (handoff §1.6c/e).
  site_id: string | null;
  // ADR-0046 amendment (2026-07-20) — NOT-DR3 disposition marker.
  filed_not_dr3: boolean;
  decision_pdf_sha256: string | null;
  // ADR-0046 Amendment 4 — stamped-decision artifacts.
  decision_pdf_r2_key: string | null;
  original_attachment_sha256: string | null;
  // ADR-0046 Amendment 3 — hold / "pending review".
  held_by: string | null;
  held_at: Date | null;
  hold_note: string | null;
  // ADR-0046 Amendment 5 — structured decide + variance. Optional so existing test
  // fixtures (pendingReq() etc.) need not enumerate them; create() defaults them and
  // the structured decide write (updateMany) sets them at decision time.
  vendor_freeform?: string | null;
  explanation?: string | null;
  confirmed_amount_cents?: number | null;
  variance_flag_state?: string;
  variance_acknowledged_by?: string | null;
  variance_acknowledged_at?: Date | null;
  variance_acknowledgment_note?: string | null;
  // ADR-0046 Amendment 5 (D-M5-3) — dual-approval stamps. Optional so existing
  // fixtures need not enumerate them; create() defaults them and the two decide legs
  // set them at their respective transitions.
  first_approver_id?: string | null;
  first_approved_at?: Date | null;
  second_approver_id?: string | null;
  second_approved_at?: Date | null;
  second_approver_note?: string | null;
  // ADR-0066 §1.5 — weekday-clock escalation stamps. Optional so every existing
  // fixture keeps working; `escalated_at IS NULL` is the scanner's idempotency key,
  // so an ABSENT field must read as null (see `escalatedAtOf`).
  escalated_at?: Date | null;
  escalated_to?: string | null;
}
export interface FakeEquipment {
  id: string;
  site_id: string;
  display_name: string;
  category: string;
  is_active: boolean;
}
export interface FakeEquipmentLink {
  id: string;
  request_id: string;
  equipment_id: string | null;
  is_not_equipment_related: boolean;
  /** ADR-0046 Amendment 9 (§2.3) — the escape-hatch disposition. */
  equipment_request_id?: string | null;
}

/** ADR-0046 Amendment 9 (§2.3) — a filed equipment ESCAPE-HATCH request. */
export interface FakeEquipmentRequest {
  id: string;
  ap_request_id: string;
  site_id: string;
  description: string;
  requested_by: string;
  status: 'open' | 'resolved' | 'rejected';
}
export interface FakeVendorBaseline {
  vendor_name_normalized: string;
  vendor_display_name: string;
  invoice_count: number;
  mean_amount_cents: number;
  median_amount_cents: number;
  min_amount_cents: number;
  max_amount_cents: number;
  stddev_amount_cents: number | null;
  variance_flat_override_cents: number | null;
  variance_percent_override: number | null;
}
export interface FakeBaselineHistory {
  id: string;
  vendor_name_normalized: string;
  invoice_date: Date;
  invoice_amount_cents: number;
  // Optional so pre-Amendment-5 seeds (variance.test) need not enumerate them;
  // create() defaults them and the D-M5-4 paths (rebuild/history) tolerate absence.
  vendor_name?: string;
  site_id?: string | null;
  source?: string;
  imported_by?: string | null;
}
export interface FakeApApprover {
  id: string;
  user_id: string;
  active_until: Date | null;
  created_by: string | null;
}
export interface FakeSecondApprover {
  id: string;
  user_id: string;
  site_id: string; // site CODE: 'woodland' | 'eugene'
  active: boolean;
  active_until: Date | null;
}
export interface FakeSite {
  id: string;
  code: string;
  name: string;
}
/**
 * ADR-0066 §1.5 — a per-site holiday. `holiday_date` is the UTC-midnight day key
 * (the @db.Date storage invariant). It pauses the weekday clock ONLY when every
 * active site observes it — see `fleetWideHolidays`.
 */
export interface FakeSiteHoliday {
  /** Optional: the scanner's fixtures set it, the digest's do not. */
  id?: string;
  site_id: string;
  holiday_date: Date;
}
export interface FakeAuditLog {
  actor_user_id: string | null;
  actor_label: string | null;
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
}
export interface FakeApFollowup {
  id: string;
  request_id: string;
  internet_message_id: string;
  received_at: Date;
  sender_address: string;
  body_text: string | null;
}
export interface FakeApAttachment {
  id: string;
  request_id: string;
  kind: 'file' | 'nested_message' | 'reference_link';
  filename: string | null;
  content_type: string | null;
  byte_size: number | null;
  storage_key: string | null;
  link_url: string | null;
  nested_subject: string | null;
}
export interface FakeUser {
  id: string;
  name: string;
  email: string | null;
  role: 'operator' | 'manager' | 'admin';
  all_sites: boolean;
  is_active: boolean;
  /** Soft-delete marker. Optional so existing fixtures need not enumerate it. */
  deleted_at?: Date | null;
  /**
   * ADR-0066 — the site-reach half of the second-approval authorization check
   * (CLAUDE.md hard rule #2: cross-site reach needs `admin` or `all_sites`).
   * Optional so pre-existing fixtures keep compiling; omitting it models a user
   * with no primary site, who therefore passes the reach check only via
   * `all_sites`.
   */
  primary_site_id?: string | null;
}
export interface FakePollRun {
  id: string;
  status: 'ok' | 'auth_failed' | 'error';
  transport_mode: 'mock' | 'graph';
  started_at: Date;
  messages_listed: number;
  requests_created: number;
  quarantined: number;
  error: string | null;
  run_id: string | null;
}

export interface FakeDb {
  requests: FakeApRequest[];
  followups: FakeApFollowup[];
  attachments: FakeApAttachment[];
  users: FakeUser[];
  approvers: FakeApApprover[];
  sites: FakeSite[];
  auditLogs: FakeAuditLog[];
  senderMode: 'tenant_wide' | 'explicit_list';
  senderEntries: Array<{ address: string; active: boolean }>;
  decisionRecipients: Array<{ email: string; active: boolean }>;
  deltaTokens: Array<{ mailbox: string; folder: string; delta_token: string }>;
  pollRuns: FakePollRun[];
  // ADR-0046 Amendment 5.
  equipment: FakeEquipment[];
  equipmentLinks: FakeEquipmentLink[];
  // ADR-0046 Amendment 9 (§2.3) — escape-hatch requests.
  equipmentRequests: FakeEquipmentRequest[];
  baselines: FakeVendorBaseline[];
  baselineHistory: FakeBaselineHistory[];
  secondApprovers: FakeSecondApprover[];
  // ADR-0066 §1.4 — person→person second-approval routing.
  approvalRouting: FakeApprovalRouting[];
  // ADR-0066 §1.6 — per-user, per-event notification prefs.
  notificationPrefs: FakeNotificationPref[];
  // ADR-0066 §1.5 — the weekday clock's holiday source (business-clock.ts).
  siteHolidays: FakeSiteHoliday[];
  // ADR-0067 Amendment A §A.6 — the singleton document-ingestion connection, read
  // by the digest's W3 warning. NULL (the default) means "never connected", which
  // is the correct state for every AP test that does not care about ingestion.
  docIngestConnection: FakeDocIngestConnection | null;
}

/** ADR-0067 — only the columns the digest warning selects. */
export interface FakeDocIngestConnection {
  state: 'connected' | 'reauth_required';
  reauth_since: Date | null;
  reauth_reason: string | null;
  account_upn: string;
}

/** ADR-0066 §1.6 — a MISSING row means column defaults, not "notify nobody". */
export interface FakeNotificationPref {
  id: string;
  user_id: string;
  notify_new_invoice: boolean;
  notify_second_approval_request: boolean;
  notify_daily_digest: boolean;
  notify_decision_outcome: boolean;
}

/** ADR-0066 §1.4 — one row per first approver; the table must be total. */
export interface FakeApprovalRouting {
  id: string;
  first_approver_id: string;
  second_approver_id: string;
  fallback_approver_id: string | null;
  fallback_after_hours: number;
  active: boolean;
}

export function newFakeDb(seed: Partial<FakeDb> = {}): FakeDb {
  return {
    requests: seed.requests ?? [],
    followups: seed.followups ?? [],
    attachments: seed.attachments ?? [],
    users: seed.users ?? [],
    approvers: seed.approvers ?? [],
    sites: seed.sites ?? [],
    auditLogs: seed.auditLogs ?? [],
    senderMode: seed.senderMode ?? 'tenant_wide',
    senderEntries: seed.senderEntries ?? [],
    decisionRecipients: seed.decisionRecipients ?? [],
    deltaTokens: seed.deltaTokens ?? [],
    pollRuns: seed.pollRuns ?? [],
    equipment: seed.equipment ?? [],
    equipmentLinks: seed.equipmentLinks ?? [],
    equipmentRequests: seed.equipmentRequests ?? [],
    baselines: seed.baselines ?? [],
    baselineHistory: seed.baselineHistory ?? [],
    secondApprovers: seed.secondApprovers ?? [],
    approvalRouting: seed.approvalRouting ?? [],
    notificationPrefs: seed.notificationPrefs ?? [],
    siteHolidays: seed.siteHolidays ?? [],
    docIngestConnection: seed.docIngestConnection ?? null,
  };
}

/** An ABSENT `escalated_at` reads as NULL — the scanner's idempotency predicate. */
function escalatedAtOf(r: FakeApRequest): Date | null {
  return r.escalated_at ?? null;
}

type AnyRecord = Record<string, unknown>;
function pick<T extends object>(row: T, select?: AnyRecord): T {
  if (!select) return { ...row };
  const src = row as AnyRecord;
  const out: AnyRecord = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = src[k];
  return out as T;
}

/** Build a fake PrismaClient over `db`. Cast to PrismaClient at the call site. */
export function makeFakePrisma(db: FakeDb) {
  const client = {
    // ADR-0067 — singleton; the digest's W3 warning reads it. Read-only here:
    // no AP path writes it, and a test that needs the reauth state seeds it.
    docIngestConnection: {
      async findUnique(args: { select?: AnyRecord }) {
        if (!db.docIngestConnection) return null;
        return pick(db.docIngestConnection, args.select);
      },
    },
    apRequest: {
      async findUnique(args: { where: AnyRecord; select?: AnyRecord }) {
        const w = args.where;
        const row = db.requests.find(
          (r) =>
            (w['id'] !== undefined && r.id === w['id']) ||
            (w['internet_message_id'] !== undefined &&
              r.internet_message_id === w['internet_message_id']),
        );
        return row ? pick(row, args.select) : null;
      },
      async findFirst(args: { where: AnyRecord; orderBy?: AnyRecord; select?: AnyRecord }) {
        const w = args.where;
        // status may be scalar (`status: 'pending'`) or a set (`status: { in: [...] }`),
        // e.g. the follow-up thread query matches both 'pending' and 'pending_review'.
        const statusMatches = (s: FakeApRequest['status']): boolean => {
          const cond = w['status'];
          if (cond === undefined) return true;
          if (cond && typeof cond === 'object' && Array.isArray((cond as { in?: unknown[] }).in)) {
            return (cond as { in: string[] }).in.includes(s);
          }
          return s === cond;
        };
        let rows = db.requests.filter((r) => {
          if (!statusMatches(r.status)) return false;
          if (w['conversation_id'] !== undefined && r.conversation_id !== w['conversation_id'])
            return false;
          return true;
        });
        rows = rows.sort((a, b) => a.received_at.getTime() - b.received_at.getTime());
        const row = rows[0];
        return row ? pick(row, args.select) : null;
      },
      // ADR-0066 §1.5 + §1.7 — UNION of both consumers' query shapes. The
      // escalation scanner reads `{ status: 'pending_second_approval',
      // escalated_at: null }` (the shape the partial index serves); the morning
      // digest reads a scalar status OR `{ in: [...] }`, plus an
      // `escalated_at: { gte }` instant bound, ordered by `received_at` or
      // `escalated_at`. Supporting only one would silently break the other's
      // fixtures, so both are implemented here.
      async findMany(args: { where?: AnyRecord; orderBy?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const statusCond = w['status'];
        const statusIn =
          statusCond && typeof statusCond === 'object'
            ? (statusCond as { in?: string[] }).in
            : undefined;
        const escCond = w['escalated_at'];
        const escGte = (escCond as { gte?: Date } | undefined)?.gte;
        let rows = db.requests.filter((r) => {
          if (statusIn) {
            if (!statusIn.includes(r.status)) return false;
          } else if (statusCond !== undefined && r.status !== statusCond) return false;
          // Scanner idempotency key: an ABSENT field must read as null.
          if (escCond === null && escalatedAtOf(r) !== null) return false;
          if (escGte) {
            const e = escalatedAtOf(r);
            if (e === null || e.getTime() < escGte.getTime()) return false;
          }
          if (w['id'] !== undefined && r.id !== w['id']) return false;
          return true;
        });
        const ob = args.orderBy as AnyRecord | undefined;
        if (ob?.['escalated_at'] !== undefined) {
          rows = [...rows].sort(
            (a, b) => (escalatedAtOf(a)?.getTime() ?? 0) - (escalatedAtOf(b)?.getTime() ?? 0),
          );
        } else {
          rows = [...rows].sort((a, b) => a.received_at.getTime() - b.received_at.getTime());
        }
        return rows.map((r) => (args.select ? pick(r, args.select) : { ...r }));
      },
      async create(args: { data: AnyRecord; select?: AnyRecord }) {
        const d = args.data;
        if (db.requests.some((r) => r.internet_message_id === d['internet_message_id'])) {
          throw p2002('internet_message_id');
        }
        const row: FakeApRequest = {
          id: uid('req'),
          status: (d['status'] as FakeApRequest['status']) ?? 'pending',
          internet_message_id: d['internet_message_id'] as string,
          conversation_id: (d['conversation_id'] as string | null) ?? null,
          received_at: (d['received_at'] as Date) ?? new Date(),
          sender_address: d['sender_address'] as string,
          sender_validated: d['sender_validated'] as boolean,
          subject: (d['subject'] as string | null) ?? null,
          body_html_sanitized: (d['body_html_sanitized'] as string | null) ?? null,
          body_text: (d['body_text'] as string | null) ?? null,
          vendor: (d['vendor'] as string | null) ?? null,
          amount_cents: (d['amount_cents'] as number | null) ?? null,
          decided_by: null,
          decided_at: null,
          decision_note: (d['decision_note'] as string | null) ?? null,
          decision_mail_sent_at: null,
          quarantine_reason: (d['quarantine_reason'] as string | null) ?? null,
          site_id: (d['site_id'] as string | null) ?? null,
          filed_not_dr3: (d['filed_not_dr3'] as boolean | undefined) ?? false,
          decision_pdf_sha256: (d['decision_pdf_sha256'] as string | null) ?? null,
          decision_pdf_r2_key: (d['decision_pdf_r2_key'] as string | null) ?? null,
          original_attachment_sha256: (d['original_attachment_sha256'] as string | null) ?? null,
          held_by: (d['held_by'] as string | null) ?? null,
          held_at: (d['held_at'] as Date | null) ?? null,
          hold_note: (d['hold_note'] as string | null) ?? null,
          vendor_freeform: (d['vendor_freeform'] as string | null) ?? null,
          explanation: (d['explanation'] as string | null) ?? null,
          confirmed_amount_cents: (d['confirmed_amount_cents'] as number | null) ?? null,
          variance_flag_state: (d['variance_flag_state'] as string | undefined) ?? 'not_applicable',
          variance_acknowledged_by: (d['variance_acknowledged_by'] as string | null) ?? null,
          variance_acknowledged_at: (d['variance_acknowledged_at'] as Date | null) ?? null,
          variance_acknowledgment_note:
            (d['variance_acknowledgment_note'] as string | null) ?? null,
          first_approver_id: (d['first_approver_id'] as string | null) ?? null,
          first_approved_at: (d['first_approved_at'] as Date | null) ?? null,
          second_approver_id: (d['second_approver_id'] as string | null) ?? null,
          second_approved_at: (d['second_approved_at'] as Date | null) ?? null,
          second_approver_note: (d['second_approver_note'] as string | null) ?? null,
          escalated_at: (d['escalated_at'] as Date | null) ?? null,
          escalated_to: (d['escalated_to'] as string | null) ?? null,
        };
        db.requests.push(row);
        return pick(row, args.select);
      },
      async updateMany(args: { where: AnyRecord; data: AnyRecord }) {
        const w = args.where;
        // status may be a scalar (`status: 'pending'`) or a set (`status: { in: [...] }`).
        const statusMatches = (s: FakeApRequest['status']): boolean => {
          const cond = w['status'];
          if (cond === undefined) return true;
          if (cond && typeof cond === 'object' && Array.isArray((cond as { in?: unknown[] }).in)) {
            return (cond as { in: string[] }).in.includes(s);
          }
          return s === cond;
        };
        const targets = db.requests.filter((r) => {
          if (r.id !== w['id']) return false;
          if (!statusMatches(r.status)) return false;
          // ADR-0066 §1.5 — the escalation claim is CONDITIONAL on
          // `escalated_at IS NULL`. Honoring it here is what makes the
          // "run the scan twice" idempotency test meaningful rather than decorative.
          if (w['escalated_at'] === null && escalatedAtOf(r) !== null) return false;
          return true;
        });
        for (const r of targets) Object.assign(r, args.data);
        return { count: targets.length };
      },
      async update(args: { where: AnyRecord; data: AnyRecord }) {
        const row = db.requests.find((r) => r.id === args.where['id']);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data);
        return { ...row };
      },
      async count(args: { where?: AnyRecord }) {
        const w = args.where ?? {};
        const siteIn = (w['site_id'] as { in?: string[] } | undefined)?.in;
        return db.requests.filter((r) => {
          if (w['status'] !== undefined && r.status !== w['status']) return false;
          if (siteIn && !siteIn.includes(r.site_id ?? '')) return false;
          if (
            w['site_id'] !== undefined &&
            typeof w['site_id'] === 'string' &&
            r.site_id !== w['site_id']
          )
            return false;
          return true;
        }).length;
      },
    },
    apFollowup: {
      async findUnique(args: { where: AnyRecord; select?: AnyRecord }) {
        const row = db.followups.find(
          (f) => f.internet_message_id === args.where['internet_message_id'],
        );
        return row ? pick(row, args.select) : null;
      },
      async create(args: { data: AnyRecord }) {
        const d = args.data;
        if (db.followups.some((f) => f.internet_message_id === d['internet_message_id'])) {
          throw p2002('internet_message_id');
        }
        const row: FakeApFollowup = {
          id: uid('fu'),
          request_id: d['request_id'] as string,
          internet_message_id: d['internet_message_id'] as string,
          received_at: (d['received_at'] as Date) ?? new Date(),
          sender_address: d['sender_address'] as string,
          body_text: (d['body_text'] as string | null) ?? null,
        };
        db.followups.push(row);
        return { ...row };
      },
    },
    apAttachment: {
      async create(args: { data: AnyRecord }) {
        const d = args.data;
        const row: FakeApAttachment = {
          id: uid('att'),
          request_id: d['request_id'] as string,
          kind: d['kind'] as FakeApAttachment['kind'],
          filename: (d['filename'] as string | null) ?? null,
          content_type: (d['content_type'] as string | null) ?? null,
          byte_size: (d['byte_size'] as number | null) ?? null,
          storage_key: (d['storage_key'] as string | null) ?? null,
          link_url: (d['link_url'] as string | null) ?? null,
          nested_subject: (d['nested_subject'] as string | null) ?? null,
        };
        db.attachments.push(row);
        return { ...row };
      },
      async findMany(args: { where?: AnyRecord; orderBy?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const rows = db.attachments.filter(
          (a) => w['request_id'] === undefined || a.request_id === w['request_id'],
        );
        return rows.map((a) => (args.select ? pick(a, args.select) : { ...a }));
      },
    },
    apSenderConfig: {
      async findUnique() {
        return { mode: db.senderMode };
      },
    },
    apSenderEntry: {
      async findMany() {
        return db.senderEntries.filter((e) => e.active).map((e) => ({ address: e.address }));
      },
    },
    apDecisionRecipient: {
      async findMany() {
        return db.decisionRecipients.filter((r) => r.active).map((r) => ({ email: r.email }));
      },
    },
    apDeltaToken: {
      async findUnique(args: {
        where: { mailbox_folder: { mailbox: string; folder: string } };
        select?: AnyRecord;
      }) {
        const { mailbox, folder } = args.where.mailbox_folder;
        const row = db.deltaTokens.find((t) => t.mailbox === mailbox && t.folder === folder);
        return row ? pick(row, args.select) : null;
      },
      async upsert(args: {
        where: { mailbox_folder: { mailbox: string; folder: string } };
        create: AnyRecord;
        update: AnyRecord;
      }) {
        const { mailbox, folder } = args.where.mailbox_folder;
        const row = db.deltaTokens.find((t) => t.mailbox === mailbox && t.folder === folder);
        if (row) row.delta_token = args.update['delta_token'] as string;
        else
          db.deltaTokens.push({
            mailbox,
            folder,
            delta_token: args.create['delta_token'] as string,
          });
        return {};
      },
    },
    apPollRun: {
      async create(args: { data: AnyRecord }) {
        const d = args.data;
        const row: FakePollRun = {
          id: uid('run'),
          status: d['status'] as FakePollRun['status'],
          transport_mode: d['transport_mode'] as FakePollRun['transport_mode'],
          started_at: (d['started_at'] as Date) ?? new Date(),
          messages_listed: (d['messages_listed'] as number) ?? 0,
          requests_created: (d['requests_created'] as number) ?? 0,
          quarantined: (d['quarantined'] as number) ?? 0,
          error: (d['error'] as string | null) ?? null,
          run_id: (d['run_id'] as string | null) ?? null,
        };
        db.pollRuns.push(row);
        return { ...row };
      },
      async findFirst(args: { where: AnyRecord; orderBy?: AnyRecord; select?: AnyRecord }) {
        let rows = db.pollRuns.filter(
          (r) => args.where['status'] === undefined || r.status === args.where['status'],
        );
        rows = rows.sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
        const row = rows[0];
        return row ? pick(row, args.select) : null;
      },
    },
    user: {
      async findUnique(args: { where: AnyRecord; select?: AnyRecord }) {
        const row = db.users.find((u) => u.id === args.where['id']);
        return row ? pick(row, args.select) : null;
      },
      // Honors the shapes the AP roster + rollout + digest paths use:
      // `id: { in: [...] }`, `is_active`, `email: { not: null }`, `deleted_at: null`,
      // `role` (scalar OR `{ in: [...] }`), `all_sites`, and `orderBy: { name }`.
      async findMany(args: { where?: AnyRecord; orderBy?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const idIn = (w['id'] as { in?: string[] } | undefined)?.in;
        const roleCond = w['role'];
        const roleIn =
          roleCond && typeof roleCond === 'object' ? (roleCond as { in?: string[] }).in : undefined;
        let rows = db.users.filter((u) => {
          if (idIn && !idIn.includes(u.id)) return false;
          if (w['is_active'] !== undefined && u.is_active !== w['is_active']) return false;
          if (w['email'] && (w['email'] as AnyRecord)['not'] === null && u.email === null)
            return false;
          // Soft-delete filter: `deleted_at: null` excludes soft-deleted rows.
          // A fixture that omits the field is treated as NOT deleted.
          if (w['deleted_at'] === null && (u.deleted_at ?? null) !== null) return false;
          if (roleIn) {
            if (!roleIn.includes(u.role)) return false;
          } else if (roleCond !== undefined && u.role !== roleCond) return false;
          if (w['all_sites'] !== undefined && u.all_sites !== w['all_sites']) return false;
          return true;
        });
        if ((args.orderBy as AnyRecord | undefined)?.['name'] !== undefined) {
          rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
        }
        return rows.map((u) => (args.select ? pick(u, args.select) : { ...u }));
      },
    },
    apApprover: {
      async findMany(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const now = new Date();
        const w = args.where ?? {};
        const rows = db.approvers.filter((a) => matchApprover(a, w, now));
        return rows.map((a) => (args.select ? pick(a, args.select) : { ...a }));
      },
      async findFirst(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const now = new Date();
        const w = args.where ?? {};
        const row = db.approvers.find((a) => matchApprover(a, w, now));
        return row ? (args.select ? pick(row, args.select) : { ...row }) : null;
      },
      async count(args: { where?: AnyRecord } = {}) {
        const now = new Date();
        const w = args.where ?? {};
        return db.approvers.filter((a) => matchApprover(a, w, now)).length;
      },
      async delete(args: { where: AnyRecord }) {
        const idx = db.approvers.findIndex(
          (a) => a.id === args.where['id'] || a.user_id === args.where['user_id'],
        );
        if (idx === -1) throw new Error('not found');
        const [removed] = db.approvers.splice(idx, 1);
        return removed;
      },
    },
    site: {
      async findUnique(args: { where: AnyRecord; select?: AnyRecord }) {
        const row = db.sites.find(
          (s) => s.id === args.where['id'] || s.code === args.where['code'],
        );
        return row ? pick(row, args.select) : null;
      },
      async findFirst(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const or = (w['OR'] as AnyRecord[] | undefined) ?? [w];
        const row = db.sites.find((s) =>
          or.some((clause) => {
            if (clause['id'] !== undefined && s.id !== clause['id']) return false;
            if (clause['code'] !== undefined && s.code !== clause['code']) return false;
            return clause['id'] !== undefined || clause['code'] !== undefined;
          }),
        );
        return row ? pick(row, args.select) : null;
      },
      async findMany(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const codeIn = (w['code'] as { in?: string[] } | undefined)?.in;
        const idIn = (w['id'] as { in?: string[] } | undefined)?.in;
        const rows = db.sites.filter((s) => {
          if (codeIn && !codeIn.includes(s.code)) return false;
          if (idIn && !idIn.includes(s.id)) return false;
          return true;
        });
        return rows.map((s) => (args.select ? pick(s, args.select) : { ...s }));
      },
      // ADR-0066 §1.5 — `fleetWideHolidays` divides by the site count to decide
      // whether a holiday is observed at EVERY active site.
      async count() {
        return db.sites.length;
      },
    },
    // ADR-0066 §1.5 — the weekday clock's holiday source. Only the range read
    // `{ holiday_date: { gte, lte } }` used by `fleetWideHolidays` is implemented;
    // `bonus-eod-check` uses the real client and is not modelled here.
    siteHoliday: {
      async findMany(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const range = (args.where ?? {})['holiday_date'] as { gte?: Date; lte?: Date } | undefined;
        const rows = db.siteHolidays.filter((h) => {
          if (range?.gte && h.holiday_date.getTime() < range.gte.getTime()) return false;
          if (range?.lte && h.holiday_date.getTime() > range.lte.getTime()) return false;
          return true;
        });
        return rows.map((h) => (args.select ? pick(h, args.select) : { ...h }));
      },
    },
    // ADR-0046 Amendment 5 (D-M5-6) — equipment master + link join.
    equipment: {
      async findMany(args: { where?: AnyRecord; orderBy?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const idIn = (w['id'] as { in?: string[] } | undefined)?.in;
        let rows = db.equipment.filter((e) => {
          if (idIn && !idIn.includes(e.id)) return false;
          if (w['site_id'] !== undefined && e.site_id !== w['site_id']) return false;
          if (w['is_active'] !== undefined && e.is_active !== w['is_active']) return false;
          return true;
        });
        rows = rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
        return rows.map((e) => (args.select ? pick(e, args.select) : { ...e }));
      },
    },
    apEquipmentLink: {
      async create(args: { data: AnyRecord }) {
        const d = args.data;
        const row: FakeEquipmentLink = {
          id: uid('eqlink'),
          request_id: d['request_id'] as string,
          equipment_id: (d['equipment_id'] as string | null) ?? null,
          is_not_equipment_related: (d['is_not_equipment_related'] as boolean | undefined) ?? false,
          equipment_request_id: (d['equipment_request_id'] as string | null | undefined) ?? null,
        };
        db.equipmentLinks.push(row);
        return { ...row };
      },
      async findMany(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const rows = db.equipmentLinks.filter(
          (l) => w['request_id'] === undefined || l.request_id === w['request_id'],
        );
        // ADR-0046 Amendment 9 — resolve the `equipment_request` relation when it
        // is selected. `pick()` alone would yield `undefined` (the field is not on
        // the link row), which is exactly the shape that let a hatch decision
        // render NO equipment line in the override-reject email.
        return rows.map((l) => {
          const req = l.equipment_request_id
            ? (db.equipmentRequests.find((r) => r.id === l.equipment_request_id) ?? null)
            : null;
          const hydrated = {
            ...l,
            equipment_request: req ? { description: req.description } : null,
          };
          return args.select ? pick(hydrated, args.select) : hydrated;
        });
      },
    },
    // ADR-0046 Amendment 9 (§2.3) — the escape-hatch request table. Only `create`
    // is modelled: `decideRequest` is the only AP path that writes here, and the
    // read/resolve surfaces are covered against their own stand-in in
    // `equipment-requests.test.ts`.
    apEquipmentRequest: {
      async create(args: { data: AnyRecord; select?: AnyRecord }) {
        const d = args.data;
        const row: FakeEquipmentRequest = {
          id: uid('eqreq'),
          ap_request_id: d['ap_request_id'] as string,
          site_id: d['site_id'] as string,
          description: d['description'] as string,
          requested_by: d['requested_by'] as string,
          status: (d['status'] as FakeEquipmentRequest['status'] | undefined) ?? 'open',
        };
        db.equipmentRequests.push(row);
        return args.select ? pick(row, args.select) : { ...row };
      },
    },
    // ADR-0046 Amendment 5 (D-M5-4) — vendor baseline + history.
    apVendorBaseline: {
      async findUnique(args: { where: AnyRecord }) {
        const row = db.baselines.find(
          (b) => b.vendor_name_normalized === args.where['vendor_name_normalized'],
        );
        return row ? { ...row } : null;
      },
      async findMany(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        void args;
        return db.baselines.map((b) => (args.select ? pick(b, args.select) : { ...b }));
      },
      // upsert writes ONLY the aggregate columns supplied in create/update — the
      // override columns (variance_flat_override_cents/variance_percent_override) are
      // never in that payload, so a rebuild preserves them (matches Prisma semantics
      // and the D-M5-4 override-preservation contract).
      async upsert(args: { where: AnyRecord; create: AnyRecord; update: AnyRecord }) {
        const key = args.where['vendor_name_normalized'];
        const existing = db.baselines.find((b) => b.vendor_name_normalized === key);
        if (existing) {
          Object.assign(existing, args.update);
          return { ...existing };
        }
        const row = {
          vendor_name_normalized: key as string,
          vendor_display_name: '',
          invoice_count: 0,
          mean_amount_cents: 0,
          median_amount_cents: 0,
          min_amount_cents: 0,
          max_amount_cents: 0,
          stddev_amount_cents: null,
          variance_flat_override_cents: null,
          variance_percent_override: null,
          ...args.create,
        } as FakeVendorBaseline;
        db.baselines.push(row);
        return { ...row };
      },
      async deleteMany(args: { where?: AnyRecord } = {}) {
        const inList = (args.where?.['vendor_name_normalized'] as { in?: string[] })?.in ?? null;
        const before = db.baselines.length;
        db.baselines = db.baselines.filter((b) =>
          inList ? !inList.includes(b.vendor_name_normalized) : false,
        );
        return { count: before - db.baselines.length };
      },
    },
    apVendorBaselineHistory: {
      async findMany(
        args: { where?: AnyRecord; orderBy?: AnyRecord; take?: number; select?: AnyRecord } = {},
      ) {
        const w = args.where ?? {};
        let rows = db.baselineHistory.filter((h) => {
          if (
            w['vendor_name_normalized'] !== undefined &&
            h.vendor_name_normalized !== w['vendor_name_normalized']
          )
            return false;
          if (w['source'] !== undefined && h.source !== w['source']) return false;
          return true;
        });
        rows = rows.sort((a, b) => b.invoice_date.getTime() - a.invoice_date.getTime());
        if (typeof args.take === 'number') rows = rows.slice(0, args.take);
        return rows.map((h) => (args.select ? pick(h, args.select) : { ...h }));
      },
      async create(args: { data: AnyRecord }) {
        const d = args.data;
        const row: FakeBaselineHistory = {
          id: uid('hist'),
          vendor_name: (d['vendor_name'] as string) ?? '',
          vendor_name_normalized: d['vendor_name_normalized'] as string,
          invoice_date: (d['invoice_date'] as Date) ?? new Date(),
          invoice_amount_cents: d['invoice_amount_cents'] as number,
          site_id: (d['site_id'] as string | null) ?? null,
          source: (d['source'] as string) ?? 'bill_upload',
          imported_by: (d['imported_by'] as string | null) ?? null,
        };
        db.baselineHistory.push(row);
        return { ...row };
      },
    },
    // ADR-0046 Amendment 5 (D-M5-3) — second-approver roster (site CODE keyed).
    apSecondApprover: {
      async findMany(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const rows = db.secondApprovers.filter((s) => matchSecondApprover(s, w));
        return rows.map((s) => (args.select ? pick(s, args.select) : { ...s }));
      },
      async findFirst(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const row = db.secondApprovers.find((s) => matchSecondApprover(s, w));
        return row ? (args.select ? pick(row, args.select) : { ...row }) : null;
      },
    },
    // ADR-0066 §1.6 — per-user notification prefs. A MISSING row yields null so
    // `wantsEvent` falls through to the column defaults (never "notify nobody").
    apNotificationPref: {
      async findFirst(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const row = db.notificationPrefs.find(
          (p) => w['user_id'] === undefined || p.user_id === w['user_id'],
        );
        return row ? (args.select ? pick(row, args.select) : { ...row }) : null;
      },
      async findMany(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const rows = db.notificationPrefs.filter((p) => {
          for (const k of [
            'notify_new_invoice',
            'notify_second_approval_request',
            'notify_daily_digest',
            'notify_decision_outcome',
          ] as const) {
            if (w[k] !== undefined && p[k] !== w[k]) return false;
          }
          return true;
        });
        return rows.map((p) => (args.select ? pick(p, args.select) : { ...p }));
      },
    },
    // ADR-0066 §1.4 — routing lookup keyed on the FIRST approver, not the site.
    apApprovalRouting: {
      async findFirst(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const row = db.approvalRouting.find((r) => {
          if (
            w['first_approver_id'] !== undefined &&
            r.first_approver_id !== w['first_approver_id']
          )
            return false;
          if (w['active'] !== undefined && r.active !== w['active']) return false;
          return true;
        });
        return row ? (args.select ? pick(row, args.select) : { ...row }) : null;
      },
      async findMany(args: { where?: AnyRecord; select?: AnyRecord } = {}) {
        const w = args.where ?? {};
        const rows = db.approvalRouting.filter(
          (r) => w['active'] === undefined || r.active === w['active'],
        );
        return rows.map((r) => (args.select ? pick(r, args.select) : { ...r }));
      },
    },
    auditLog: {
      async create(args: { data: AnyRecord }) {
        const d = args.data;
        const row: FakeAuditLog = {
          actor_user_id: (d['actor_user_id'] as string | null) ?? null,
          actor_label: (d['actor_label'] as string | null) ?? null,
          action: d['action'] as string,
          table_name: d['table_name'] as string,
          row_id: d['row_id'] as string,
          before: d['before'] ?? null,
          after: d['after'] ?? null,
        };
        db.auditLogs.push(row);
        return { id: uid('audit'), ...row };
      },
    },
    // Supports BOTH Prisma $transaction shapes: the interactive callback form
    // (`$transaction(async (tx) => …)`) and the batch/array form
    // (`$transaction([p1, p2, …])`, used by confirmBaselineImport).
    async $transaction<T>(
      arg: ((tx: unknown) => Promise<T>) | ReadonlyArray<Promise<unknown>>,
    ): Promise<T | unknown[]> {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => Promise<T>)(client);
    },
  };
  return client;
}

/** Match an ap_second_approver row against the D-M5-3 routing/eligibility where
 * shapes: `{ site_id, active, OR: [{active_until:null},{active_until:{gt}}] }` plus
 * an optional `user_id`. */
function matchSecondApprover(s: FakeSecondApprover, w: Record<string, unknown>): boolean {
  if (w['user_id'] !== undefined && s.user_id !== w['user_id']) return false;
  if (w['site_id'] !== undefined && s.site_id !== w['site_id']) return false;
  if (w['active'] !== undefined && s.active !== w['active']) return false;
  const or = w['OR'] as Array<Record<string, unknown>> | undefined;
  if (or) {
    const active = or.some((clause) => {
      if ('active_until' in clause && clause['active_until'] === null)
        return s.active_until === null;
      const au = clause['active_until'] as { gt?: Date } | undefined;
      if (au && au.gt) return s.active_until !== null && s.active_until.getTime() > au.gt.getTime();
      return false;
    });
    if (!active) return false;
  }
  return true;
}

/** Match an ap_approver row against the AP roster/expiry where shapes. */
function matchApprover(a: FakeApApprover, w: Record<string, unknown>, now: Date): boolean {
  if (w['user_id'] !== undefined && a.user_id !== w['user_id']) return false;
  const or = w['OR'] as Array<Record<string, unknown>> | undefined;
  if (or) {
    const anyActiveClause = or.some((clause) => {
      if ('active_until' in clause && clause['active_until'] === null)
        return a.active_until === null;
      const au = clause['active_until'] as { gt?: Date } | undefined;
      if (au && au.gt) return a.active_until !== null && a.active_until.getTime() > au.gt.getTime();
      return false;
    });
    if (!anyActiveClause) return false;
  }
  const au = w['active_until'] as { lte?: Date; gt?: Date } | null | undefined;
  if (au && typeof au === 'object') {
    if (au.lte) {
      if (a.active_until === null || a.active_until.getTime() > au.lte.getTime()) return false;
    }
    if (au.gt) {
      if (a.active_until === null || a.active_until.getTime() <= au.gt.getTime()) return false;
    }
  }
  void now;
  return true;
}
