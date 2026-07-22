// Type surface for the (JS) MyMRC scrape worker's injectable orchestrator, so
// the ADR-0057 D9 vitest test can import it under `allowJs: false`. The worker
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of types here is the test).

/**
 * Injectable collaborators for one scrape tick. Kept loose (`unknown`) on
 * purpose — the test supplies fakes and the entrypoint supplies the real
 * `@/lib/mymrc` surface + a PrismaClient + a Chromium launcher.
 */
export interface MymrcScrapeDeps {
  /** The compiled `@/lib/mymrc` surface (loadAdminCredentials, createPortalClient, syncSite, checkDeadman, ntfyPager, SITE_CODES, CredentialsNotConfiguredError). */
  mymrc: unknown;
  /** A PrismaClient. */
  prisma: unknown;
  /** Launch the browser — called ONLY after the D9 credential gate passes. */
  launchBrowser: () => Promise<unknown>;
  /** Structured logger (defaults to the module's console logger). */
  log?: (level: string, message: string) => void;
  /**
   * The recycler context(s) to pull this run (overrides `MYMRC_ACTIVE_SITES`).
   * Omitted ⇒ resolved from env, defaulting to the pilot single context
   * (`woodland`). Only these sites sync AND are deadman-watched — a site the
   * session cannot see must not be synced (its `ok` run would false-green the
   * deadman, C-21).
   */
  activeSites?: string[];
}

/** Resolver args for {@link resolveActiveSites}. */
export interface ResolveActiveSitesArgs {
  explicit?: string[];
  envValue?: string;
  known?: string[];
  log?: (level: string, message: string) => void;
}

/**
 * Resolve the active recycler context(s) for a run: an explicit list, else the
 * `MYMRC_ACTIVE_SITES` comma list, else the pilot default (`['woodland']`).
 * Tokens are lower-cased, validated against `known`, and an empty/invalid result
 * falls back to the default (never returns an empty set).
 */
export function resolveActiveSites(args: ResolveActiveSitesArgs): string[];

/**
 * Run one scrape tick and RESOLVE the process exit code (never calls
 * `process.exit`): 0 success · 1 admin session failed to start · 3 D9
 * credentials not configured · 4 D9 credentials present but undecryptable.
 * Fail-loud (D9): a missing/undecryptable credential pages `dr3-vision-system`
 * and returns a non-zero code without launching a browser or attempting a sync.
 */
export function runMymrcScrape(deps: MymrcScrapeDeps): Promise<number>;
