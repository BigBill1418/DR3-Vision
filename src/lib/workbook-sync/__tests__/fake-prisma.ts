// ADR-0049 — a minimal in-memory fake Prisma for the sync-engine tests (the repo
// has no test Postgres; the fake-prisma idiom is the house pattern). Implements only
// the calls the engine/upsert/cutover touch. `$transaction(fn)` passes the same fake
// as the tx client so overwrite + audit land together.

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

export interface FakeSource {
  id: string;
  site_id: string;
  drive_upn: string;
  folder_path: string;
  naming_pattern: string;
  is_syncing: boolean;
  last_polled_at: Date | null;
  last_file_id: string | null;
  last_file_name: string | null;
  last_file_ctag: string | null;
  /** ADR-0049 Am.4 B1 — the prior month's separate watermark. */
  grace_file_id: string | null;
  grace_file_name: string | null;
  grace_file_ctag: string | null;
  /** ADR-0049 Am.3 A4 — health watermark + escalation ladder state. */
  last_success_at: Date | null;
  consecutive_failures: number;
  last_alert_at: Date | null;
  created_at: Date;
}

interface PudRow {
  id: string;
  site_id: string;
  production_date: Date;
  source: string;
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  material_ticket_number: string | null;
  employees_count: number | null;
  processors_count: number | null;
  saved_units: Prisma.Decimal | null;
  import_id: string | null;
  closed_at: Date | null;
}

export class FakePrisma {
  sources: FakeSource[] = [];
  surfaces: {
    surface_code: string;
    site_id: string | null;
    kind: string;
    rollout_state: string;
  }[] = [];
  pud: PudRow[] = [];
  audits: {
    action: string;
    table_name: string;
    row_id: string;
    before: unknown;
    after: unknown;
    actor_label?: string | null;
    actor_user_id?: string | null;
  }[] = [];
  syncRuns: Record<string, unknown>[] = [];
  private seq = 0;

  private key(siteId: string, date: Date): string {
    return `${siteId}|${date.toISOString().slice(0, 10)}`;
  }

  workbookSource = {
    findMany: async (args: { where?: { is_syncing?: boolean; site_id?: string } }) => {
      const w = args?.where ?? {};
      return this.sources.filter(
        (s) =>
          (w.is_syncing === undefined || s.is_syncing === w.is_syncing) &&
          (w.site_id === undefined || s.site_id === w.site_id),
      );
    },
    findUnique: async (args: { where: { site_id: string } }) =>
      this.sources.find((s) => s.site_id === args.where.site_id) ?? null,
    update: async (args: { where: { id: string }; data: Partial<FakeSource> }) => {
      const s = this.sources.find((x) => x.id === args.where.id);
      if (s) Object.assign(s, args.data);
      return s;
    },
  };

  rolloutSurface = {
    findUnique: async (args: {
      where: { surface_code_site_id: { surface_code: string; site_id: string } };
    }) => {
      const { surface_code, site_id } = args.where.surface_code_site_id;
      return (
        this.surfaces.find((s) => s.surface_code === surface_code && s.site_id === site_id) ?? null
      );
    },
    findMany: async (args: { where: { kind: string; surface_code: string } }) =>
      this.surfaces.filter(
        (s) => s.kind === args.where.kind && s.surface_code === args.where.surface_code,
      ),
  };

  processedUnitsDaily = {
    findUnique: async (args: {
      where: { site_id_production_date: { site_id: string; production_date: Date } };
    }) => {
      const { site_id, production_date } = args.where.site_id_production_date;
      return (
        this.pud.find(
          (r) => this.key(r.site_id, r.production_date) === this.key(site_id, production_date),
        ) ?? null
      );
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const d = args.data as Record<string, unknown>;
      const row: PudRow = {
        id: `pud-${++this.seq}`,
        site_id: d['site_id'] as string,
        production_date: d['production_date'] as Date,
        source: (d['source'] as string) ?? 'manual',
        stripped_program: d['stripped_program'] as Prisma.Decimal,
        stripped_non_program: d['stripped_non_program'] as Prisma.Decimal,
        material_ticket_number: (d['material_ticket_number'] as string | null) ?? null,
        employees_count: (d['employees_count'] as number | null) ?? null,
        processors_count: (d['processors_count'] as number | null) ?? null,
        saved_units: (d['saved_units'] as Prisma.Decimal | null) ?? null,
        import_id: (d['import_id'] as string | null) ?? null,
        closed_at: null,
      };
      this.pud.push(row);
      return { id: row.id };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = this.pud.find((x) => x.id === args.where.id);
      if (r) Object.assign(r, args.data);
      return r;
    },
    /**
     * ADR-0123 — the ownership guard rides on the WRITING statement, so the fake
     * has to evaluate the predicate rather than just the id.
     *
     * Only the two filter shapes the production code actually uses are modelled,
     * and an unrecognised one THROWS rather than silently matching everything. A
     * permissive fake here would make the guard's own test vacuous: the write
     * would land, the assertion would read the clobbered row, and the suite
     * would be measuring the double instead of the code.
     */
    updateMany: async (args: {
      where: { id: string; source?: { not?: string } };
      data: Record<string, unknown>;
    }) => {
      const keys = Object.keys(args.where).sort().join(',');
      if (keys !== 'id' && keys !== 'id,source') {
        throw new Error(`fake-prisma: unmodelled updateMany filter {${keys}}`);
      }
      const not = args.where.source?.not;
      if (args.where.source !== undefined && not === undefined) {
        throw new Error('fake-prisma: unmodelled updateMany source filter');
      }
      const r = this.pud.find((x) => x.id === args.where.id);
      if (!r) return { count: 0 };
      if (not !== undefined && r.source === not) return { count: 0 };
      Object.assign(r, args.data);
      return { count: 1 };
    },
  };

  auditLog = {
    create: async (args: { data: Record<string, unknown> }) => {
      this.audits.push(args.data as never);
      return { id: `audit-${++this.seq}` };
    },
    findFirst: async () => null,
  };

  /**
   * ADR-0037 `sources` rows, for the adapter's wrong-workbook cross-check
   * (`sourceAliasResolver`). Empty by default: no resolvable name ⇒ no evidence
   * either way ⇒ the check passes and the rest of the engine behaves as before.
   */
  sourceRows: {
    id: string;
    site_id: string;
    name: string;
    is_non_program: boolean;
    state: string | null;
    site: { jurisdiction: string } | null;
    aliases: { alias: string }[];
  }[] = [];

  source = {
    findMany: async () => this.sourceRows,
  };

  workbookSyncRun = {
    create: async (args: { data: Record<string, unknown> }) => {
      this.syncRuns.push(args.data);
      return { id: `run-${++this.seq}` };
    },
  };

  /**
   * ADR-0049 Am.4 B1 — approved invoices, for the grace window's billed-day guard.
   * Empty by default: nothing is billed, so the guard is inert and every existing
   * test behaves exactly as it did before the amendment.
   */
  invoices: {
    site_id: string;
    status: string;
    voided_at: Date | null;
    window_start: Date;
    window_end: Date;
  }[] = [];

  invoice = {
    findMany: async (args: {
      where: {
        site_id: string;
        status: string;
        voided_at: null;
        window_start: { lte: Date };
        window_end: { gte: Date };
      };
    }) => {
      const w = args.where;
      return this.invoices.filter(
        (i) =>
          i.site_id === w.site_id &&
          i.status === w.status &&
          i.voided_at === null &&
          i.window_start.getTime() <= w.window_start.lte.getTime() &&
          i.window_end.getTime() >= w.window_end.gte.getTime(),
      );
    },
  };

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }

  seedSource(overrides: Partial<FakeSource> = {}): FakeSource {
    const s: FakeSource = {
      id: `src-${++this.seq}`,
      site_id: 'site-woodland',
      drive_upn: 'kelsey_ruhland@svdp.us',
      folder_path: '',
      naming_pattern: '{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm',
      is_syncing: true,
      last_polled_at: null,
      last_file_id: null,
      last_file_name: null,
      last_file_ctag: null,
      grace_file_id: null,
      grace_file_name: null,
      grace_file_ctag: null,
      last_success_at: null,
      consecutive_failures: 0,
      last_alert_at: null,
      created_at: new Date('2026-06-01T00:00:00Z'),
      ...overrides,
    };
    this.sources.push(s);
    return s;
  }

  asClient(): PrismaClient {
    return this as unknown as PrismaClient;
  }
}

export function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}
