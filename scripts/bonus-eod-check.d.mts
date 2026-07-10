// Type surface for the (JS) bi-site EOD bonus-entry check daemon's pure schedule
// helper, so a vitest test can import it under `allowJs: false`. The daemon
// auto-start is guarded behind an entrypoint check, so importing the module is
// side-effect-free (the only consumer of these types is the test).

/**
 * The next UTC instant at which the Pacific (America/Los_Angeles) wall clock
 * reads 17:00:00 (the fixed EOD fire time), strictly after `from`. DST-correct
 * across the PDT/PST boundary via the offset-reprobe technique (anchors to the
 * target Pacific calendar day + that day's UTC offset).
 */
export function nextFireInstant(from: Date): Date;
