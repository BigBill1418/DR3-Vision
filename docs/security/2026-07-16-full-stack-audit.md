# DR3-Vision — Full-Stack Security & Code Audit (2026-07-16)

Top-to-bottom audit of production/critical infrastructure, run as five parallel
adversarial passes (auth/authz, injection/XSS, secrets/deps/build, business-logic/
money/concurrency, host/runtime) against `origin/main` @ `a7dca9b` and the live
CHAD-HQ deployment. This is the consolidated register; `[status]` tracks
remediation.

**Overall posture: strong.** The hard controls hold — email-body sanitizer +
sandboxed AP iframe, integer-cents money engine, first-action-wins CAS on AP/
credit-memos, disciplined admin-POWERS vs site-REACH split, non-root container,
exemplary public edge headers, isolated Postgres, 600-mode host secrets. The
findings are peripheral hardening + a few real integrity gaps, not a broken
foundation.

## Severity legend
`[fix]` shipping this cycle (aegis) · `[decision]` needs Bill's call/deploy window ·
`[ops]` host action · `[watch]` accepted-risk, documented.

---

## HIGH

| ID | Finding | File | Disposition |
|----|---------|------|-------------|
| H1 | **Amendment approve/reject has no CAS** — check-then-act instead of the `updateMany({where:{state:'pending'}})` used everywhere else. Two reviewers (approve+reject) in the sub-transaction window → the approve mutates the bonus daily entry, the reject overwrites state to `rejected` — a **rejected amendment that silently applied**, with a falsified audit (`before: pending`). Payroll payout reflects a rejected change. | `src/lib/bonus/amendment-requests.ts:539,601,643,685,710,753` | `[fix]` |
| SSRF | **Blind SSRF via Playwright** — a body-only invoice (no attachment) is re-rendered to PDF with `setContent(html,{waitUntil:'networkidle'})`; the sanitizer allows remote `<img>`, so Chromium fetches attacker URLs **server-side** at Approve/Reject time (cloud metadata, internal hosts). Also a 30s-timeout DoS amplifier. | `src/lib/ap/stamp.ts:181` (renderer), `sanitize.ts:30,38` | `[fix]` |
| NEXT | **Next.js on an advisory range** incl. App-Router **middleware/proxy bypass** + WebSocket SSRF. Middleware is this app's auth boundary — a bypass reaches authed routes without a session. `npm audit fix` resolves within 15.5.x. | `package.json` next@15.5.15 | `[decision]` (auth-layer bump — deploy window + re-run auth tests) |
| JWT | **Stale session trust / no revocation.** jwt callback copies `role/all_sites/is_super_admin/is_active` **only at sign-in**; never re-validated. A demoted/deactivated/fired manager keeps full powers (approve amendments, void invoices, exports, `/admin/*`) until 12h idle / 30d absolute expiry. `is_active`/`deleted_at` checked only at the Entra signIn gate. Rate/billing-verify/AP-roster guards DO re-read fresh (good) — the hole is everything token-derived. | `src/lib/auth.config.ts:62`, consumers | `[decision]` (pick: periodic re-fetch / `sessions_invalidated_at` kill-switch / DB sessions) |

---

## MEDIUM

| ID | Finding | File | Disposition |
|----|---------|------|-------------|
| M2 | **AP decide: state flip + audit not in one transaction**, and `writeAudit` is hardcoded to the global prisma singleton so it structurally can't join a tx. Crash/throw between flip and audit → a live, **unaudited** decision (contradicts the module's "both attempts audited"). | `src/lib/ap/approvals.ts:214,254`; `src/lib/audit.ts:24` | `[fix]` |
| M1 | **Late daily-report immediate-send is not atomic** — read-check → slow Graph send → write-log, no tx/lock. Double-click or race with the scheduled fire → team gets **duplicate** production reports. | `src/lib/bonus/daily-report-late.ts:97`, `daily-report-runner.ts:125` | `[fix]` |
| M3 | **Credit memos: no cumulative cap.** Per-memo bound is `≤ total_cents`, but after a memo goes terminal a NEW memo up to `total_cents` can be raised — `Σ applied` can exceed the invoice total. | `src/lib/invoices/credit-memos.ts:164` | `[fix]` |
| M4 | **Client truncates comma currency** — `parseFloat("1,234.56")` → `1` → **$1.00** sent + trusted by the server; lands on the decision record, decision email, and the stamped PDF filed to Great Plains. | `src/app/dashboard/ops/ap/ApQueueClient.tsx:263` | `[fix]` |
| CRON | **Fail-open on 12 internal cron routes** — when `INTERNAL_CRON_TOKEN` is unset the token check is skipped; the full app is WG-published on `10.99.0.2:9469`, so any WG peer could POST AP-poll / month-close / report blasts. Token IS set in prod (defense-in-depth gap). | `src/app/api/internal/**/route.ts` | `[fix]` (mandatory-in-prod) |
| CSV | **CSV formula injection** in finance exports — `escapeCsvField` does RFC-4180 quoting but no `= + - @` prefix guard; operator/vendor/MyMRC text (BOL#, source/transporter names) reaches the CFO's Excel. | `src/lib/exports.ts:69` | `[fix]` |
| UPLOAD | **Photo upload trusts client `content_type`** (any string); presigned PUT stores it verbatim → HTML/SVG parked & served on public `photos.dr3-vision.svdp.us`. | `src/app/api/photos/upload-url/route.ts:11` → `src/lib/r2.ts:67` | `[fix]` (image allowlist) |
| HEALTH | **`/api/health/subsystems` has no authz** — middleware-authenticated only; any operator PIN session reads the subsystem config-presence map. Contradicts its own header comment. | `src/app/api/health/subsystems/route.ts:78` | `[fix]` |
| LEGACY | **Committed secrets in `legacy/`** — a real crackable bcrypt `admin` hash + `root`/empty-password MySQL creds (dead predecessor PHP, not shipped in the image). | `legacy/mattressloaddb.sql:61`, `legacy/connection.php:2` | `[fix]` (delete `legacy/`) |
| DOCKERIGN | **No `.dockerignore`** — builder `COPY . .` pulls full `.git` history (incl. the legacy hash for the life of the repo) + any stray local `.env` into the builder layer. | `Dockerfile:33` | `[fix]` |
| SENDER | **`sender_validated` trusts the From header**, not an authenticated envelope; comments overstate it as "authenticated." In `tenant_wide` mode any `@svdp.us` From becomes approvable — an external forgery injects a fraudulent invoice (+ SSRF body) unless EOP/DMARC strictly quarantines. | `src/lib/msgraph-mail/normalize.ts:134`, `src/lib/ap/senders.ts:48` | `[fix]` comments + `[decision]`/`[ops]` verify tenant DMARC=quarantine/reject |
| CSP | **CSP `script-src 'unsafe-inline'`** neuters CSP as an XSS control (one static login FOUC guard is the only inline script). | `next.config.js` | `[decision]` (nonce migration — schedule) |
| RES | **No mem/CPU/PID limits** on app + 12 cron containers on a ~15-tenant host; Chromium PDF renders have OOM/fork-bomb blast radius across co-tenants (`init:true` reaps but doesn't cap). | `docker-compose.yml` | `[fix]` (compose limits) + `[ops]` |
| CVE | 32 moderate prod CVEs (`postcss`, `protobufjs`, `ws`) clear with non-breaking `npm audit fix`; `uuid`←`exceljs` needs upstream (don't `--force`). | `package-lock.json` | `[fix]` (non-breaking only) |

---

## LOW

| ID | Finding | File | Disposition |
|----|---------|------|-------------|
| IFRAME | Unsandboxed preview iframes (digest + survey invite) render server-built HTML in-origin; safe today (escaped) but one edit from stored XSS. AP path already sandboxes. | `DigestsClient.tsx:168`, `InvitePreview.tsx:201` | `[fix]` (`sandbox=""`) |
| CAPS | No length caps on stored free-text (survey `answer_text`/`answer_json`, AP `note`/`vendor`) — storage-DoS boundary. | survey `draft/route.ts:7`, AP `decide/route.ts` | `[fix]` (zod `.max`) |
| TIME | Non-constant-time bearer compare on internal routes (contact-intake already uses `timingSafeEqual`). | `src/app/api/internal/**` | `[fix]` |
| L2 | `transitionCreditMemo` tail write of `superseding_invoice_id` is unguarded + unaudited. | `src/lib/invoices/credit-memos.ts:345` | `[fix]` |
| SIG | Dual-signature stale read can drop one concurrent signature (fails safe — opaque 409, resubmit); relevant vs the auto-override cron. | `src/lib/bonus/signatures.ts:332` | `[fix]` (`FOR UPDATE`) |
| PIXEL | Remote `<img>` in AP body preview leaks approver IP (tracking pixel) even under `sandbox=""`. | `sanitize.ts:30` | `[watch]` |
| PAYROLL | Re-trigger on an already-`paid` period re-mails payroll (by-design recovery path; no dedup). | `src/lib/bonus/payroll-delivery.ts:188` | `[watch]`/optional `force` |
| DUMPS | Prod DB dumps world-readable (644) in 775 dirs; not reachable today (single account, no container mount). | CHAD `~/dr3-backups`, `~/backups/postgres` | `[ops]` (chmod 600 + `umask 077`) |
| CI | CI actions pinned to mutable major tags, not SHAs (first-party, low risk). | `.github/workflows/ci.yml` | `[watch]` |
| SUB | Graph `User.Read` token stored in the encrypted JWT cookie (not client-readable; scope-narrow). | `auth.config.ts:74` | `[watch]` |

---

## Verified sound (no action — recorded so the audit is honest)
- Operator PIN → manager/admin escalation **impossible** (role-hardcoded, every guard 403s operator); PIN brute-force limited (5/60s → 15m lockout, Argon2id, no enumeration).
- IDOR systematically defended — site id pushed into the service `WHERE`; AP attachment bound to parent request; bonus amendment approve keyed to the request's own signature chain.
- Raw SQL fully parameterized (`Prisma.sql`); no `queryRawUnsafe`.
- Email sanitizer conservative + regression-tested; AP body iframe `sandbox=""`.
- Money engine integer-cents throughout; recent migrations (20260710–20260720) additive, no data-loss.
- Log redaction + Sentry `beforeSend` scrub auth/cookies/PII; DSN split correct; `poweredByHeader:false`; no source maps.
- Public edge: HSTS preload, full CSP, `X-Frame-Options: DENY`, nosniff, `__Host-`/`__Secure-` cookies; `/metrics` 404s public + CF-origin; no tunnel-reachable unauth surface beyond `/healthz`.
- Container non-root + `init:true` + no mounts (no docker socket, no host home); Postgres not host-published, isolated bridge, scram; secrets 600 in 700 dir.

## Runtime-verification queue (can't confirm statically)
1. SSRF: email a no-attachment HTML-body invoice with `<img src=http://collab/probe>`, Approve, confirm the **server** fetches it.
2. Sender spoof: external `From: x@svdp.us` → does it land `pending`? Confirm `svdp.us` DMARC `p=quarantine|reject`.
3. CSV: BOL `=HYPERLINK("http://evil","x")` → export → open in Excel.
4. Upload MIME: `content_type:"text/html"` → PUT → fetch object, check served `Content-Type`.
5. JWT: demote a manager in a 2nd admin session, replay the old cookie against a write → confirm it (wrongly) succeeds today.
