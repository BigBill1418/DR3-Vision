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
  status: 'pending' | 'approved' | 'rejected' | 'quarantined';
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
  senderMode: 'tenant_wide' | 'explicit_list';
  senderEntries: Array<{ address: string; active: boolean }>;
  decisionRecipients: Array<{ email: string; active: boolean }>;
  deltaTokens: Array<{ mailbox: string; folder: string; delta_token: string }>;
  pollRuns: FakePollRun[];
}

export function newFakeDb(seed: Partial<FakeDb> = {}): FakeDb {
  return {
    requests: seed.requests ?? [],
    followups: seed.followups ?? [],
    attachments: seed.attachments ?? [],
    users: seed.users ?? [],
    senderMode: seed.senderMode ?? 'tenant_wide',
    senderEntries: seed.senderEntries ?? [],
    decisionRecipients: seed.decisionRecipients ?? [],
    deltaTokens: seed.deltaTokens ?? [],
    pollRuns: seed.pollRuns ?? [],
  };
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
  return {
    apRequest: {
      async findUnique(args: { where: AnyRecord; select?: AnyRecord }) {
        const w = args.where;
        const row = db.requests.find(
          (r) =>
            (w['id'] !== undefined && r.id === w['id']) ||
            (w['internet_message_id'] !== undefined && r.internet_message_id === w['internet_message_id']),
        );
        return row ? pick(row, args.select) : null;
      },
      async findFirst(args: { where: AnyRecord; orderBy?: AnyRecord; select?: AnyRecord }) {
        const w = args.where;
        let rows = db.requests.filter((r) => {
          if (w['status'] !== undefined && r.status !== w['status']) return false;
          if (w['conversation_id'] !== undefined && r.conversation_id !== w['conversation_id']) return false;
          return true;
        });
        rows = rows.sort((a, b) => a.received_at.getTime() - b.received_at.getTime());
        const row = rows[0];
        return row ? pick(row, args.select) : null;
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
        };
        db.requests.push(row);
        return pick(row, args.select);
      },
      async updateMany(args: { where: AnyRecord; data: AnyRecord }) {
        const w = args.where;
        const targets = db.requests.filter(
          (r) => r.id === w['id'] && (w['status'] === undefined || r.status === w['status']),
        );
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
        return db.requests.filter((r) => w['status'] === undefined || r.status === w['status']).length;
      },
    },
    apFollowup: {
      async findUnique(args: { where: AnyRecord; select?: AnyRecord }) {
        const row = db.followups.find((f) => f.internet_message_id === args.where['internet_message_id']);
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
      async findUnique(args: { where: { mailbox_folder: { mailbox: string; folder: string } }; select?: AnyRecord }) {
        const { mailbox, folder } = args.where.mailbox_folder;
        const row = db.deltaTokens.find((t) => t.mailbox === mailbox && t.folder === folder);
        return row ? pick(row, args.select) : null;
      },
      async upsert(args: { where: { mailbox_folder: { mailbox: string; folder: string } }; create: AnyRecord; update: AnyRecord }) {
        const { mailbox, folder } = args.where.mailbox_folder;
        const row = db.deltaTokens.find((t) => t.mailbox === mailbox && t.folder === folder);
        if (row) row.delta_token = args.update['delta_token'] as string;
        else db.deltaTokens.push({ mailbox, folder, delta_token: args.create['delta_token'] as string });
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
        let rows = db.pollRuns.filter((r) => args.where['status'] === undefined || r.status === args.where['status']);
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
      async findMany() {
        return db.users
          .filter((u) => u.is_active && u.email !== null && (u.role === 'admin' || u.all_sites))
          .map((u) => ({ email: u.email }));
      },
    },
  };
}
