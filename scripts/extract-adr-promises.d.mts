// Type surface for the (JS) ADR promise extractor, so a vitest test can import it
// under `allowJs: false`. Side-effect-free on import; the CLI half is guarded
// behind an entrypoint check. See ADR-0097.

export interface PromiseCandidate {
  line: number;
  /** Which marker matched — useful when auditing precision. */
  marker: string;
  text: string;
  /** Present on candidates returned by `collectPromises`. */
  file?: string;
}

export interface AdrPromises {
  number: string;
  files: string[];
  promises: PromiseCandidate[];
}

export interface RegistryCoverage {
  /** ADRs newer than the epoch that state a promise but have no row in PROMISES.md. */
  uncovered: AdrPromises[];
  stats: { adrsWithPromises: number; totalCandidates: number; registeredAdrs: number };
}

export const REGISTRY_EPOCH_ADR: number;
export const PROMISE_MARKERS: { name: string; re: RegExp }[];

/** Promise candidates in a single ADR's markdown text. */
export function extractPromises(text: string): PromiseCandidate[];

/** ADR number → candidates, across a whole ADR directory. */
export function collectPromises(adrDir: string): Map<string, AdrPromises>;

/** ADR numbers with at least one row in the registry file. */
export function registeredAdrs(registryPath: string): Set<string>;

/** Advisory coverage report. Never throws; never signals failure. */
export function checkRegistryCoverage(options?: {
  repoRoot?: string;
  adrDir?: string;
  registryPath?: string;
}): RegistryCoverage;
