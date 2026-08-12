// Type surface for the (JS) ADR citation resolver, so a vitest test can import it
// under `allowJs: false`. The module is side-effect-free on import — the CLI half
// is guarded behind an entrypoint check — so importing it only exposes the pure
// functions. See ADR-0098.

export interface AdrIndexEntry {
  /** Every file carrying this ADR number: the parent plus any separate amendment files. */
  files: string[];
  /** Numbered amendments declared by ANY of those files, merged. */
  amendments: Set<number>;
}

export interface Citation {
  adr: string;
  amendment: number | null;
  line: number;
  text: string;
}

export interface Violation {
  file: string;
  line: number;
  adr: string;
  amendment: number | null;
  kind: 'missing-adr' | 'missing-amendment';
  message: string;
}

export interface BaselineEntry {
  adr: string;
  amendment: number;
  since: string;
  note: string;
}

export interface CitationCheckResult {
  /** NEW, unbaselined failures. Non-empty means the gate fails. */
  violations: Violation[];
  /** Failures matching a `KNOWN_UNRESOLVED` entry — tolerated, tracked in PROMISES.md. */
  baselined: Violation[];
  /** Baseline entries nothing violates any more; these must be deleted. */
  staleBaseline: BaselineEntry[];
  stats: { filesScanned: number; citations: number; adrsIndexed: number };
}

export const DEFAULT_SCAN_DIRS: string[];
export const FLEET_ADRS: Record<string, string>;
export const KNOWN_UNRESOLVED: BaselineEntry[];

/** Index `docs/adr/`, merging both amendment conventions (in-file heading + separate file). */
export function collectAdrIndex(adrDir: string): Map<string, AdrIndexEntry>;

/** Every `ADR-NNNN` / `ADR-NNNN Amendment K` reference in `text`, with 1-based lines. */
export function extractCitations(text: string): Citation[];

/** Resolve every citation in the scanned trees against `docs/adr/`. */
export function checkAdrCitations(options?: {
  repoRoot?: string;
  scanDirs?: string[];
  adrDir?: string;
}): CitationCheckResult;

export interface AdrNumberCollision {
  number: string;
  /** Primary (non-amendment) files claiming the same number. */
  files: string[];
}

/**
 * Two or more PRIMARY ADR files claiming one number. Amendment files
 * (`NNNN-amendment-K-*.md`) legitimately share their parent's number and are
 * excluded.
 */
export function findDuplicateAdrNumbers(adrDir: string): AdrNumberCollision[];
