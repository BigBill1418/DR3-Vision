// ADR-0114 — Graph large-attachment transport (draft + upload session + send).
//
// These tests exist because AP request acb03895 was DECIDED and never delivered:
// its four stamped artifacts summed to 4,146 KB against a 3,072 KB inline
// ceiling, and the transport had no shape that could carry them. The refusal was
// correct; the missing half was the send.
//
// The doubles here are deliberately STRICT rather than permissive. A mock more
// permissive than Graph would hide exactly the bugs this path is prone to —
// off-by-one byte ranges, an Authorization header on a pre-authenticated URL, or
// opening an upload session for a file Graph will refuse as too small. So the
// fake Graph client rejects unknown routes, and the fake fetch validates every
// Content-Range against the contract before accepting a chunk.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/observability/metrics', () => ({
  payrollDeliverySuccess: { inc: vi.fn() },
}));

import {
  sendSystemEmail,
  planSend,
  chunkRanges,
  GRAPH_UPLOAD_CHUNK_BYTES,
  GRAPH_UPLOAD_SESSION_MIN_BYTES,
  EXCHANGE_MESSAGE_LIMIT_DEFAULT_BYTES,
  __testing,
} from '@/lib/m365-mail';

const MAILBOX = 'dr3-vision@svdp.us';

function mb(n: number): Buffer {
  return Buffer.alloc(Math.round(n * 1024 * 1024), 7);
}

// ── A recording Graph double that knows the real route shapes ────────────────

interface Call {
  path: string;
  method: 'post' | 'delete';
  body?: unknown;
}

interface Recorder {
  client: unknown;
  calls: Call[];
  paths: () => string[];
  /** Force the Nth matching call to throw the given status. */
  failOn: (match: RegExp, status: number) => void;
}

function graphDouble(opts: { draftId?: string; uploadUrl?: string } = {}): Recorder {
  const draftId = opts.draftId ?? 'AAMkDRAFT001=';
  const uploadUrl = opts.uploadUrl ?? 'https://outlook.office.com/api/v2.0/AttachmentSessions?authtoken=tok';
  const calls: Call[] = [];
  const failures: Array<{ match: RegExp; status: number }> = [];

  const makeRequest = (path: string) => {
    const req = {
      header: () => req,
      post: async (body: unknown) => {
        calls.push({ path, method: 'post', body });
        const failure = failures.find((f) => f.match.test(path));
        if (failure) {
          throw Object.assign(new Error(`forced ${failure.status}`), {
            statusCode: failure.status,
          });
        }
        if (/\/messages$/.test(path)) return { id: draftId };
        if (/createUploadSession$/.test(path)) return { uploadUrl, nextExpectedRanges: ['0-'] };
        if (/\/attachments$/.test(path)) return { id: 'att-1' };
        if (/\/send$/.test(path)) return undefined; // 202
        if (/sendMail$/.test(path)) return undefined; // 202
        throw new Error(`unexpected Graph route POSTed: ${path}`);
      },
      delete: async () => {
        calls.push({ path, method: 'delete' });
        return undefined;
      },
    };
    return req;
  };

  return {
    client: { api: (path: string) => makeRequest(path) },
    calls,
    paths: () => calls.map((c) => `${c.method.toUpperCase()} ${c.path}`),
    failOn: (match, status) => failures.push({ match, status }),
  };
}

// ── A STRICT fetch double: it validates the chunk contract, not just records ──

interface FetchRecorder {
  fetch: typeof fetch;
  ranges: string[];
  sawAuthHeader: boolean;
  bytesReceived: number;
}

function strictUploadFetch(opts: { failAtChunk?: number } = {}): FetchRecorder {
  const ranges: string[] = [];
  let bytesReceived = 0;
  let sawAuthHeader = false;
  let expectedNextStart = 0;
  let chunkIndex = 0;

  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
      sawAuthHeader = true;
    }
    if (headers['Content-Type'] !== 'application/octet-stream') {
      throw new Error(`chunk must be application/octet-stream, got ${headers['Content-Type']}`);
    }

    const range = headers['Content-Range'] ?? '';
    ranges.push(range);
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) throw new Error(`malformed Content-Range: ${JSON.stringify(range)}`);
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = Number(m[3]);

    // The contract Graph enforces, asserted here so a range bug fails LOUDLY in
    // the double rather than silently producing a corrupt attachment.
    if (start !== expectedNextStart) {
      throw new Error(
        `non-contiguous range: expected to start at ${expectedNextStart}, got ${start} (range ${range})`,
      );
    }
    if (end < start) throw new Error(`inverted range: ${range}`);
    if (end >= total) throw new Error(`range end ${end} is past the last byte ${total - 1}`);
    const length = end - start + 1;
    if (length > 4 * 1024 * 1024) {
      throw new Error(`chunk of ${length} bytes exceeds Graph's 4 MB per-PUT cap`);
    }
    const declared = Number(headers['Content-Length']);
    if (declared !== length) {
      throw new Error(`Content-Length ${declared} disagrees with Content-Range length ${length}`);
    }
    const actual = (init?.body as Uint8Array).byteLength;
    if (actual !== length) {
      throw new Error(`body of ${actual} bytes disagrees with declared range length ${length}`);
    }

    chunkIndex += 1;
    if (opts.failAtChunk !== undefined && chunkIndex === opts.failAtChunk) {
      return { ok: false, status: 500 } as unknown as Response;
    }

    bytesReceived += length;
    expectedNextStart = end + 1;
    const done = expectedNextStart >= total;
    return {
      ok: true,
      status: done ? 201 : 200,
      json: async () => ({ nextExpectedRanges: done ? [] : [String(expectedNextStart)] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return {
    fetch: fetchFn,
    ranges,
    get sawAuthHeader() {
      return sawAuthHeader;
    },
    get bytesReceived() {
      return bytesReceived;
    },
  };
}

beforeEach(() => {
  process.env['AUTH_MICROSOFT_ENTRA_ID_TENANT_ID'] = 't';
  process.env['AUTH_MICROSOFT_ENTRA_ID_ID'] = 'c';
  process.env['AUTH_MICROSOFT_ENTRA_ID_SECRET'] = 's';
  process.env['M365_MAIL_FROM_ADDRESS'] = MAILBOX;
  delete process.env['M365_MAIL_MAX_MESSAGE_BYTES'];
  __testing.setSleep(async () => undefined);
});

afterEach(() => {
  __testing.resetClientFactory();
  __testing.resetFetch();
  delete process.env['M365_MAIL_MAX_MESSAGE_BYTES'];
});

// ────────────────────────────────────────────────────────────────────────────

describe('chunkRanges — the byte-range contract', () => {
  it('produces contiguous, inclusive ranges whose last byte is total-1', () => {
    const total = 10 * 1024 * 1024;
    const ranges = chunkRanges(total);

    expect(ranges[0]?.start).toBe(0);
    expect(ranges[ranges.length - 1]?.end).toBe(total - 1);
    for (let i = 1; i < ranges.length; i++) {
      // Contiguity: each range starts exactly one byte after the previous ended.
      expect(ranges[i]!.start).toBe(ranges[i - 1]!.end + 1);
    }
    // Every chunk is within Graph's 4 MB per-PUT cap.
    for (const r of ranges) {
      expect(r.end - r.start + 1).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    // Total coverage is exact — no gap, no overlap, no phantom byte.
    const covered = ranges.reduce((n, r) => n + (r.end - r.start + 1), 0);
    expect(covered).toBe(total);
  });

  it('emits a single range for a file smaller than one chunk', () => {
    expect(chunkRanges(100)).toEqual([{ start: 0, end: 99 }]);
  });

  it('emits nothing for an empty file rather than a 0--1 range', () => {
    expect(chunkRanges(0)).toEqual([]);
  });
});

describe('planSend — which transport carries the message', () => {
  it('keeps a small message inline', () => {
    expect(
      planSend({ to: 'a@svdp.us', subject: 's', htmlBody: '<p>x</p>', attachment: { filename: 'a.pdf', buffer: mb(1) } }),
    ).toEqual({ mode: 'inline' });
  });

  it('routes acb03895-shaped mail (oversize by SUM, every file small) to the session path', () => {
    // The real request: 85 KB + ~1.3 MB + ~1.4 MB + ~1.4 MB stamped artifacts.
    const plan = planSend({
      to: 'accounting@svdp.us',
      subject: 'AP decision',
      htmlBody: '<p>x</p>',
      attachments: [
        { filename: 'rejected-DR3_Invoices.pdf', buffer: mb(0.083) },
        { filename: 'rejected-35.pdf', buffer: mb(1.3) },
        { filename: 'rejected-5340.pdf', buffer: mb(1.4) },
        { filename: 'rejected-285859.pdf', buffer: mb(1.4) },
      ],
    });
    expect(plan.mode).toBe('upload-session');
  });

  it('refuses only above the MAILBOX limit, and says which ceiling that was', () => {
    const plan = planSend({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'huge.pdf', buffer: mb(30) }, // base64 ≈ 40 MB > 35 MB
    });
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    // The refusal must name the real ceiling, not the inline one it long outgrew.
    expect(plan.report.ceiling).toBe('exchange-message');
    expect(plan.report.limitBytes).toBe(EXCHANGE_MESSAGE_LIMIT_DEFAULT_BYTES);
  });

  it('honours a raised tenant limit from config', () => {
    process.env['M365_MAIL_MAX_MESSAGE_BYTES'] = String(100 * 1024 * 1024);
    const plan = planSend({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'huge.pdf', buffer: mb(30) },
    });
    expect(plan.mode).toBe('upload-session');
  });
});

describe('sendSystemEmail — the inline path is untouched below the ceiling', () => {
  it('sends a 1.6 MB attachment (the reimbursement ladder budget) via one sendMail, no draft', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);

    const res = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'decision.pdf', buffer: mb(1.6) },
    });

    expect(res.delivered).toBe(true);
    expect(res.transport).toBe('inline');
    // The shrink ladder still buys the SIMPLE transport — the session path is a
    // floor under it, not a replacement that makes shrinking pointless.
    expect(g.paths()).toEqual([`POST /users/${MAILBOX}/sendMail`]);
  });
});

describe('sendSystemEmail — the acb03895 case: oversize by SUM, no single large file', () => {
  it('creates a draft, POSTs every under-3MB file directly, and sends — no upload session', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);
    const f = strictUploadFetch();
    __testing.setFetch(f.fetch);

    const res = await sendSystemEmail({
      to: 'accounting@svdp.us',
      subject: 'DR3-Vision AP decision (rejected)',
      htmlBody: '<p>decision</p>',
      attachments: [
        { filename: 'rejected-DR3_Invoices.pdf', buffer: mb(0.083) },
        { filename: 'rejected-35.pdf', buffer: mb(1.3) },
        { filename: 'rejected-5340.pdf', buffer: mb(1.4) },
        { filename: 'rejected-285859.pdf', buffer: mb(1.4) },
      ],
    });

    expect(res.delivered).toBe(true);
    expect(res.transport).toBe('upload-session');
    expect(g.paths()).toEqual([
      `POST /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/attachments`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/attachments`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/attachments`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/attachments`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/send`,
    ]);
    // Graph answers createUploadSession for a sub-3MB file with
    // ErrorAttachmentSizeShouldNotBeLessThanMinimumSize. Opening one here would
    // have failed all four attachments — this is the assertion that pins it.
    expect(g.paths().some((p) => p.includes('createUploadSession'))).toBe(false);
    expect(f.ranges).toEqual([]);
  });

  it('carries the draft body and recipients, not just the attachments', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);

    await sendSystemEmail({
      to: { address: 'mary@svdp.us', name: 'Mary' },
      subject: 'AP decision',
      htmlBody: '<p>the decision</p>',
      cc: ['bill@svdp.us'],
      fromDisplayName: 'DR3-Vision AP',
      attachments: [
        { filename: 'a.pdf', buffer: mb(1.5) },
        { filename: 'b.pdf', buffer: mb(1.5) },
      ],
    });

    const draft = g.calls[0]!.body as Record<string, unknown>;
    expect(draft['subject']).toBe('AP decision');
    expect(draft['toRecipients']).toEqual([
      { emailAddress: { address: 'mary@svdp.us', name: 'Mary' } },
    ]);
    expect(draft['ccRecipients']).toEqual([{ emailAddress: { address: 'bill@svdp.us' } }]);
    expect((draft['from'] as Record<string, unknown>)['emailAddress']).toMatchObject({
      name: 'DR3-Vision AP',
    });
    // The draft must NOT carry attachments — they are added individually.
    expect(draft['attachments']).toBeUndefined();
  });
});

describe('sendSystemEmail — a genuinely large single file uses an upload session', () => {
  it('opens a session and PUTs contiguous ranged chunks that reassemble exactly', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);
    const f = strictUploadFetch();
    __testing.setFetch(f.fetch);

    const size = 10 * 1024 * 1024;
    const res = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'scan.pdf', buffer: Buffer.alloc(size, 3) },
    });

    expect(res.delivered).toBe(true);
    expect(g.paths()).toEqual([
      `POST /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/attachments/createUploadSession`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/send`,
    ]);

    // createUploadSession must declare the true size — Graph allocates on it.
    const sessionBody = g.calls[1]!.body as { AttachmentItem: Record<string, unknown> };
    expect(sessionBody.AttachmentItem['size']).toBe(size);
    expect(sessionBody.AttachmentItem['attachmentType']).toBe('file');
    expect(sessionBody.AttachmentItem['name']).toBe('scan.pdf');

    // Every byte arrived exactly once (the strict double already rejected any
    // gap, overlap or over-cap chunk).
    expect(f.bytesReceived).toBe(size);
    expect(f.ranges[0]).toBe(`bytes 0-${GRAPH_UPLOAD_CHUNK_BYTES - 1}/${size}`);
    expect(f.ranges[f.ranges.length - 1]).toMatch(new RegExp(`-${size - 1}/${size}$`));
  });

  it('never sends an Authorization header on the pre-authenticated upload URL', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);
    const f = strictUploadFetch();
    __testing.setFetch(f.fetch);

    await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'scan.pdf', buffer: mb(5) },
    });

    // Microsoft's docs are explicit: the uploadUrl carries its own token and an
    // Authorization header must not be added.
    expect(f.sawAuthHeader).toBe(false);
  });

  it('routes a mixed payload per FILE, not per message', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);
    __testing.setFetch(strictUploadFetch().fetch);

    await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachments: [
        { filename: 'small.pdf', buffer: mb(0.5) },
        { filename: 'big.pdf', buffer: mb(5) },
      ],
    });

    expect(g.paths()).toEqual([
      `POST /users/${MAILBOX}/messages`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/attachments`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/attachments/createUploadSession`,
      `POST /users/${MAILBOX}/messages/AAMkDRAFT001=/send`,
    ]);
    expect(mb(0.5).byteLength).toBeLessThan(GRAPH_UPLOAD_SESSION_MIN_BYTES);
    expect(mb(5).byteLength).toBeGreaterThanOrEqual(GRAPH_UPLOAD_SESSION_MIN_BYTES);
  });
});

describe('sendSystemEmail — failure honesty on the draft path', () => {
  it('a failed mid-upload reports NOT delivered and deletes the half-built draft', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);
    // Fail the second chunk, after the first has landed — the worst case, where
    // a draft exists and holds a partial attachment.
    __testing.setFetch(strictUploadFetch({ failAtChunk: 2 }).fetch);

    const res = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'scan.pdf', buffer: mb(10) },
    });

    // sent_to_accounting_at must record that Mary WAS told, not that we tried.
    expect(res.delivered).toBe(false);
    expect(res.oversize).toBeNull(); // a transport failure, not a size refusal
    expect(res.lastStatus).toBe(500);
    // No orphaned draft left sitting in the sender's Drafts folder.
    expect(g.paths()).toContain(`DELETE /users/${MAILBOX}/messages/AAMkDRAFT001=`);
    expect(g.paths().some((p) => p.endsWith('/send'))).toBe(false);
  });

  it('a failed send action reports NOT delivered and discards the draft', async () => {
    const g = graphDouble();
    g.failOn(/\/send$/, 403);
    __testing.setClientFactory(() => g.client as never);
    __testing.setFetch(strictUploadFetch().fetch);

    const res = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachments: [
        { filename: 'a.pdf', buffer: mb(1.5) },
        { filename: 'b.pdf', buffer: mb(1.5) },
      ],
    });

    expect(res.delivered).toBe(false);
    expect(res.lastStatus).toBe(403);
    expect(g.paths()).toContain(`DELETE /users/${MAILBOX}/messages/AAMkDRAFT001=`);
  });

  it('a draft that could not be created never attaches or sends anything', async () => {
    const g = graphDouble();
    g.failOn(/\/messages$/, 403);
    __testing.setClientFactory(() => g.client as never);

    const res = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachments: [
        { filename: 'a.pdf', buffer: mb(1.5) },
        { filename: 'b.pdf', buffer: mb(1.5) },
      ],
    });

    expect(res.delivered).toBe(false);
    // Nothing to clean up, and nothing was attempted past the failure.
    expect(g.paths()).toEqual([`POST /users/${MAILBOX}/messages`]);
  });

  it('never throws — a committed decision must not unwind because of a transport failure', async () => {
    const g = graphDouble();
    g.failOn(/\/messages$/, 500);
    __testing.setClientFactory(() => g.client as never);

    await expect(
      sendSystemEmail({
        to: 'a@svdp.us',
        subject: 's',
        htmlBody: '<p>x</p>',
        attachments: [
          { filename: 'a.pdf', buffer: mb(1.5) },
          { filename: 'b.pdf', buffer: mb(1.5) },
        ],
      }),
    ).resolves.toMatchObject({ delivered: false, transport: 'upload-session' });
  });

  it('retries a transient upload failure under the shared budget', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);
    let attempts = 0;
    __testing.setFetch((async (_u: unknown, init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) return { ok: false, status: 503 } as unknown as Response;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['Content-Range'] ?? '');
      if (!m) throw new Error('malformed range');
      return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch);

    const res = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'scan.pdf', buffer: mb(3.5) },
    });

    expect(res.delivered).toBe(true);
    expect(res.retries).toBe(1);
  });
});

describe('sendSystemEmail — refusal above the real ceiling', () => {
  it('refuses, names the mailbox ceiling, and posts nothing', async () => {
    const g = graphDouble();
    __testing.setClientFactory(() => g.client as never);

    const res = await sendSystemEmail({
      to: 'a@svdp.us',
      subject: 's',
      htmlBody: '<p>x</p>',
      attachment: { filename: 'enormous.pdf', buffer: mb(30) },
    });

    expect(res.delivered).toBe(false);
    expect(res.oversize).not.toBeNull();
    expect(res.oversize?.ceiling).toBe('exchange-message');
    expect(res.oversize?.limitBytes).toBe(EXCHANGE_MESSAGE_LIMIT_DEFAULT_BYTES);
    expect(res.oversize?.filenames).toEqual(['enormous.pdf']);
    // Nothing was posted — no draft to leak.
    expect(g.calls).toEqual([]);
  });
});
