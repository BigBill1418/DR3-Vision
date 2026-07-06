// ADR-0046 D1/C7 — the fixture-driven mock transport (the DEFAULT until IT
// delivers Graph creds). Zero code between mock and live: it satisfies the same
// `MailTransport` contract, self-reports `mode='mock'`, and supports the failure
// modes the contract tests exercise (delta paging, token loss → resync,
// auth-fail, drift). `moveMessage` relocates the message between in-memory
// folders so a re-poll of the source folder cannot re-list it (move hygiene),
// while `internetMessageId` remains the true idempotency guard.

import { AuthFailedError, GraphContractDriftError, type MailTransport } from './transport';
import { DEFAULT_MOCK_FIXTURES } from './__fixtures__/messages';
import type { DeltaResult, MailMessage, NormAttachment } from './types';

/** A fixture message plus its folder + attachments (the mock's mailbox unit). */
export interface MockMessageSpec extends MailMessage {
  folder: string;
  attachments: NormAttachment[];
}

export interface MockTransportOptions {
  /** Mailbox contents; defaults to the C10 taxonomy fixtures. Cloned internally (not mutated in place). */
  messages?: MockMessageSpec[];
  /** Delta page size for paging simulation (default: all in one page). */
  pageSize?: number;
  /** listDelta throws AuthFailedError (auth-fail contract test). */
  failAuth?: boolean;
  /** The named op throws GraphContractDriftError (drift contract test). */
  driftOn?: 'listDelta' | 'getMessage' | 'listAttachments';
  /** listDelta ignores the supplied token and full-resyncs (token-loss contract test). */
  rejectDeltaToken?: boolean;
}

export interface MockTransport extends MailTransport {
  /** Pages consumed on the last listDelta — lets a test assert paging happened. */
  readonly lastPageCount: number;
  /** Current folder of a message by internetMessageId — lets a test assert a move. */
  folderOf(internetMessageId: string): string | undefined;
}

export function mockTransport(opts: MockTransportOptions = {}): MockTransport {
  // Own, mutable copy of the mailbox (moveMessage relocates entries).
  const store = new Map<string, MockMessageSpec>();
  for (const m of opts.messages ?? DEFAULT_MOCK_FIXTURES) store.set(m.id, { ...m, attachments: [...m.attachments] });
  const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : Number.POSITIVE_INFINITY;
  let lastPageCount = 0;

  function inFolder(folder: string): MockMessageSpec[] {
    return [...store.values()]
      .filter((m) => m.folder === folder)
      .sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
  }

  function toMailMessage(spec: MockMessageSpec): MailMessage {
    return {
      id: spec.id,
      internetMessageId: spec.internetMessageId,
      conversationId: spec.conversationId,
      receivedDateTime: spec.receivedDateTime,
      from: spec.from,
      fromName: spec.fromName,
      subject: spec.subject,
      bodyHtml: spec.bodyHtml,
      bodyText: spec.bodyText,
      hasAttachments: spec.hasAttachments,
    };
  }

  return {
    mode: 'mock',
    get lastPageCount() {
      return lastPageCount;
    },
    folderOf(internetMessageId: string): string | undefined {
      for (const m of store.values()) if (m.internetMessageId === internetMessageId) return m.folder;
      return undefined;
    },

    async listDelta(folder: string, deltaToken: string | null): Promise<DeltaResult> {
      if (opts.failAuth) throw new AuthFailedError('mock: simulated auth failure on listDelta');
      if (opts.driftOn === 'listDelta') throw new GraphContractDriftError('mock: simulated contract drift on listDelta');

      const resynced = deltaToken === null || opts.rejectDeltaToken === true;
      const all = inFolder(folder);
      // Simulate @odata.nextLink paging: consume the folder in `pageSize` chunks so
      // the aggregate matches, and count pages so a test can assert paging occurred.
      const messages: MailMessage[] = [];
      let pages = 0;
      for (let i = 0; i < all.length || (i === 0 && all.length === 0); i += pageSize) {
        pages += 1;
        for (const spec of all.slice(i, i === 0 && pageSize === Number.POSITIVE_INFINITY ? all.length : i + pageSize)) {
          messages.push(toMailMessage(spec));
        }
        if (pageSize === Number.POSITIVE_INFINITY) break;
      }
      lastPageCount = pages;
      // The mock token is opaque (an increasing marker); persistence is the DB's job.
      return { messages, deltaToken: `mock-delta-${folder}-${Date.now()}`, resynced };
    },

    async getMessage(id: string): Promise<MailMessage> {
      if (opts.driftOn === 'getMessage') throw new GraphContractDriftError('mock: simulated contract drift on getMessage');
      const spec = store.get(id);
      if (!spec) throw new GraphContractDriftError(`mock: message ${id} not found`);
      return toMailMessage(spec);
    },

    async listAttachments(id: string): Promise<NormAttachment[]> {
      if (opts.driftOn === 'listAttachments') throw new GraphContractDriftError('mock: simulated contract drift on listAttachments');
      const spec = store.get(id);
      if (!spec) throw new GraphContractDriftError(`mock: message ${id} not found`);
      return spec.attachments.map((a) => ({ ...a }));
    },

    async moveMessage(id: string, destFolder: string): Promise<string> {
      const spec = store.get(id);
      if (!spec) throw new GraphContractDriftError(`mock: message ${id} not found`);
      spec.folder = destFolder;
      return id; // the mock keeps the id stable across a move (harmless for the pipeline)
    },
  };
}
