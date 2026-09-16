// ADR-0133 — the ONE secret redactor for caught-error text.
//
// ## Why this file exists
//
// On 2026-09-16 at 04:02 PT the ntfy page `[DR3-Vision] MyMRC sync error -
// woodland [outbound]` carried Playwright's full call log for an
// `apiRequestContext.post: Timeout 45000ms exceeded` against the Aura list
// endpoint — REQUEST HEADERS INCLUDED. The `cookie:` header of that request is
// the live Salesforce session for Bill's MyMRC admin identity: `sid`,
// `sid_Client`, `oid`, `BrowserId`, `renderCtx`. The same 1,331-character string
// was written to `mymrc_sync_runs.error` and to the container's stdout, so one
// caught error put a working credential on a phone, in a public-facing push
// server's 7-day cache, in the production database and in docker's log ring at
// the same instant.
//
// The boundary rule this module exists to enforce: **no caught error is stored,
// logged or published unredacted.** A Playwright error is not a message, it is a
// transcript — and a transcript of an authenticated request contains the
// authentication. Two schema comments (`mymrc_sync_runs.error`,
// `mymrc_backfill_cursors.error`) asserted "never contains credentials" for
// months; neither was ever true, because nothing enforced it.
//
// ## Why it lives under mymrc/
//
// Forced placement, identical to `header-safe.ts` (ADR-0019.5) and
// `cooldown-store.ts` (ADR-0130): `tsconfig.mymrc.json` pins
// `rootDir: ./src/lib/mymrc`, so the alias-less MyMRC bundle CANNOT import
// anything above that directory. The one implementation goes inside the narrower
// rootDir and is re-exported upward as `src/lib/redact-secrets.ts` for the app.
// Moving it out breaks `npm run build:mymrc` (TS6059), not the test suite.
//
// ## Zero imports, on purpose
//
// `src/lib/ntfy.ts` must stay bundleable for edge/browser targets (no
// `node:crypto`, no Prisma), and it is one of this module's consumers. Pure
// string in, pure string out, no I/O, no clock, no env.

/** The one replacement token. Chosen so it is obvious in a log and in a page. */
export const REDACTED = '[REDACTED]';

/**
 * One entry per pattern, each recording WHAT IT MATCHED IN THE 2026-09-16 LEAK.
 *
 * Order matters and is asserted by the tests:
 *   1. the session-id shape runs before the key=value masks, so a `sid=` value
 *      that spills past a delimiter is caught by its own shape either way;
 *   2. `sid_Client` precedes `sid` in the alternation — leftmost-first would
 *      otherwise mask `sid` and leave a bare `_Client=…` fragment behind.
 *
 * Every value class stops at `; , & whitespace " ' } )` — and deliberately NOT
 * at `]`, so that re-running the redactor over its own `[REDACTED]` output is a
 * no-op rather than producing `[REDACTED]]`. Idempotence is a tested property:
 * these strings are redacted at the producer AND again at each sink, because a
 * sink that trusts its caller is the defect this ADR is about.
 */
export const REDACTION_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
  /** What this matched in the 2026-09-16 leak. */
  readonly leaked: string;
}> = [
  {
    name: 'salesforce-session-id',
    // `00D` + 12-15 org-id chars + `!` + the session body.
    pattern: /\b00D[0-9A-Za-z]{12,15}![A-Za-z0-9._-]{20,}/g,
    replacement: REDACTED,
    leaked:
      'the VALUE of sid= inside the cookie: header of the timed-out Aura POST — a live, replayable Salesforce session for the MyMRC admin identity',
  },
  {
    name: 'authorization-header',
    pattern: /\b(authorization\s*:\s*)(?:bearer\s+)?[^\s;,"']+/gi,
    replacement: `$1${REDACTED}`,
    leaked:
      'not present in the 09-16 body (the Aura POST authenticates by cookie), but the SAME call log renders an Authorization header whenever one is set, and the ntfy publisher itself sends one',
  },
  {
    name: 'cookie-header-line',
    // A whole `cookie:` / `set-cookie:` line, bulleted or not. The line-level
    // rule below removes these inside a call log; this one catches the same
    // header when it is embedded in prose or in a single-line error.
    pattern: /^([^\S\n]*-?[^\S\n]*)(set-cookie|cookie)([^\S\n]*:[^\S\n]*).*$/gim,
    replacement: `$1$2$3${REDACTED}`,
    leaked:
      'the entire `cookie:` header line — BrowserId, sid, sid_Client, oid and renderCtx in one string',
  },
  {
    name: 'named-credential-pairs',
    pattern: /\b(sid_Client|sid|oid|BrowserId|renderCtx|password)=[^;,&\s"'})]*/gi,
    replacement: `$1=${REDACTED}`,
    leaked:
      'sid=, sid_Client=, oid=, BrowserId= and renderCtx= as cookie pairs; password= is here because the portal login POSTs it in a form body and `locator.fill: Timeout 45000ms exceeded` (run d87a0d8c…, 03:01 PT) is the same call-log family',
  },
];

/** Playwright opens its transcript with this line, alone on a line. */
const CALL_LOG_MARKER = /^[^\S\n]*Call log:[^\S\n]*$/;

/**
 * A call-log bullet carrying a header: `  -   cookie: …`, `  - user-agent: …`.
 *
 * Anchored on a header-NAME-shaped token immediately followed by `:` so the two
 * lines worth keeping survive: the request line starts with `→` (not a letter)
 * and prose entries (`  - navigating to "…"`, `  - retrying 1x`) have no
 * `token:` at their head.
 *
 * Deny-by-default INSIDE the call log: every header line goes, not an allowlist
 * of the six that leaked this time. An allowlist cannot see the header a future
 * Playwright or a future portal adds, which is the whole failure mode.
 */
const CALL_LOG_HEADER_LINE = /^[^\S\n]*-[^\S\n]*[A-Za-z][A-Za-z0-9_-]*[^\S\n]*:/;

/**
 * Remove the header block of a Playwright call log, replacing each contiguous
 * run with a count.
 *
 * Scoped to text that actually contains a `Call log:` line: an ordinary
 * multi-line message may legitimately use `- key: value` bullets, and eating
 * those would make the redactor something authors route around. Outside a call
 * log the pattern list above still masks every secret shape — the header lines
 * merely survive as noise, and the pager caps the body anyway.
 *
 * The count is emitted rather than deleting silently: "shipped disabled must not
 * look identical to shipped working" (ADR-0130), and an operator reading a
 * sync-run row needs to know the transcript was trimmed, not truncated.
 */
function dropCallLogHeaderLines(text: string): string {
  const lines = text.split('\n');
  if (!lines.some((l) => CALL_LOG_MARKER.test(l))) return text;

  const out: string[] = [];
  let inCallLog = false;
  let run = 0;
  const flush = (): void => {
    if (run > 0) out.push(`  - [${run} header line(s) redacted]`);
    run = 0;
  };
  for (const line of lines) {
    if (inCallLog && CALL_LOG_HEADER_LINE.test(line)) {
      run += 1;
      continue;
    }
    flush();
    if (CALL_LOG_MARKER.test(line)) inCallLog = true;
    out.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Strip credential material out of arbitrary error text.
 *
 * Pure, total and IDEMPOTENT: `redactSecrets(redactSecrets(x)) === redactSecrets(x)`
 * for every input, which is what lets it be applied at the producer AND at every
 * sink without any sink having to know whether an earlier one already ran.
 *
 * It is a redactor, not a validator — it never throws and never refuses. The
 * fail-closed decisions belong to the callers (see `scripts/mymrc-scrape.mjs`,
 * which withholds the text entirely when this helper is missing from a build).
 */
export function redactSecrets(text: string): string {
  if (text.length === 0) return text;
  let out = dropCallLogHeaderLines(text);
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
