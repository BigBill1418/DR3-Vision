// Type surface for the (JS) ADR-0059 hauls → inventory INBOUND bridge backfill
// runner's pure helpers + injectable orchestrator, so a vitest test can import them
// under `allowJs: false`. The runner auto-start is guarded behind an entrypoint check,
// so importing the module is side-effect-free (the only consumer of these types is the
// test).

/** A live-floor snapshot as Decimal STRINGS (byte-identical comparison). */
export interface FloorSnapshot {
  program: string;
  nonProgram: string;
  total: string;
}

/** Parsed backfill options. */
export interface BackfillOpts {
  dryRun: boolean;
  /** Restrict to these site codes, or null for all. */
  siteCodes: string[] | null;
  /** Lower-bound Pacific delivery day `YYYY-MM-DD`, or null for full history. */
  since: string | null;
}

/** Injectable collaborators for {@link runInboundBridgeBackfill}. */
export interface BackfillDeps {
  /** The compiled `@/lib/mymrc` surface (bridgeInboundHaulsToInventory, ntfyPager). */
  mymrc: unknown;
  /** A PrismaClient. */
  prisma: unknown;
  /** POST the internal floor-probe route for one site at a FIXED asOf. */
  probe: (siteCode: string, asOfIso: string) => Promise<FloorSnapshot>;
  /** Parsed args. */
  opts: BackfillOpts;
  /** Structured logger (defaults to the module's console logger). */
  log?: (level: string, message: string) => void;
}

/** Parse argv into the backfill options. Throws on a bad flag/value. */
export function parseArgs(argv: string[]): BackfillOpts;

/** True iff two floor snapshots are byte-identical on all three pools. */
export function floorsEqual(a: FloorSnapshot, b: FloorSnapshot): boolean;

/**
 * Run the one-shot INBOUND backfill with the MANDATORY floor-invariance gate and
 * RESOLVE the process exit code (never calls `process.exit`): 0 success (or --dry-run) ·
 * 1 the live floor drifted (paged) or a probe/site-resolve failed.
 */
export function runInboundBridgeBackfill(deps: BackfillDeps): Promise<number>;
