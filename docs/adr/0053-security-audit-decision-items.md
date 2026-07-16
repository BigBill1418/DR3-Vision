# ADR-0053 — Security audit decision items (2026-07-16 full-stack audit)

**Status:** Proposed — a tracking record for the five findings the 2026-07-16
audit deliberately did NOT auto-fix. Each needs an operator decision and/or a
deploy window; this ADR holds them until each is resolved (then flip its
sub-item to Accepted/Done and mark the row in the audit register).
**Date:** 2026-07-16
**Source:** `docs/security/2026-07-16-full-stack-audit.md` (the `[decision]`/`[ops]`
rows). The `[fix]` rows were remediated the same day by two aegis batches
(PRs #116, #117); this ADR is the residual.
**Owner:** Bill (decisions) + Claude Code (execution once decided).

## Context

A five-pass adversarial audit of DR3-Vision (production, critical
infrastructure) found a strong overall posture. Every clear-cut code finding
was fixed and merged the same day. Five items were held back because they are
NOT mechanical repairs — they change the auth boundary, need a deploy window,
require a larger refactor, or depend on tenant-side / host-side configuration.
Shipping them silently would have been the wrong call. They are tracked here so
they don't slip.

## The five items

### D1 — Next.js security bump (HIGH · auth-layer)

- **Finding (NEXT):** the pinned `next@15.5.15` sits on an advisory cluster
  including an App-Router **middleware/proxy bypass** and a WebSocket SSRF.
  Middleware is this app's authentication boundary, so a bypass reaches
  authenticated routes without a session.
- **Why held:** bumping the framework that enforces auth is not a silent
  dependency change — it wants a deliberate deploy window and a re-run of the
  auth/middleware tests, ideally watched.
- **Proposed action:** `npm audit fix` (resolves within 15.5.x, no major bump)
  → `next build` → full test suite → deploy in a low-traffic window → smoke the
  auth middleware (unauthenticated request to a gated route must still 307 to
  `/login`; a valid session still reaches its routes). Bundle D5 (moderate CVE
  clear) into the same lockfile change.
- **Decision needed:** approve the bump + pick the window.

### D2 — Stale session trust / no revocation (HIGH)

- **Finding (JWT):** the Auth.js jwt callback copies `role` / `all_sites` /
  `is_super_admin` / `is_active` into the token **only at sign-in** and never
  re-validates. `is_active` / `deleted_at` are checked only at the Entra
  `signIn` gate. So a demoted, deactivated, or fired manager keeps their full
  prior powers (approve bonus amendments, void invoices, run exports, reach
  `/admin/*`) until their token idles out (12h) or hits the 30d absolute cap.
  The rate / billing-verify / AP-roster guards already re-read fresh from the DB
  (good) — the hole is everything else that trusts the token-derived claims.
- **Why held:** the fix is a design choice with real trade-offs, not a
  one-liner.
- **Options:**
  1. **Periodic re-fetch** in the jwt callback — stamp `token.checked_at`; when
     stale (e.g. > 5 min) re-`findUnique` the user and refresh `role` /
     `all_sites` / `is_super_admin`, invalidating on `!is_active || deleted_at`.
     Cheapest; keeps the JWT strategy; bounded staleness.
  2. **Kill-switch column** — `users.sessions_invalidated_at`, bumped on any
     role/status change; compared against `token.iat` in the jwt callback.
     Instant revocation, minimal per-request cost.
  3. **Database session strategy** — lets `/api/admin/users` deactivation delete
     sessions outright. Cleanest semantics, largest change.
- **Recommendation:** option 1 or 2 (both keep JWT); 2 gives instant revocation
  for the fired-employee case, which is the sharp edge here.
- **Decision needed:** pick the mechanism (and the acceptable staleness window
  if option 1).

### D3 — CSP `script-src 'unsafe-inline'` (MEDIUM · scheduled)

- **Finding (CSP):** `'unsafe-inline'` on `script-src` means CSP provides no
  mitigation against an injected inline script — it's the difference between "an
  XSS bug is contained" and "an XSS bug is account takeover in a finance app."
  The only legitimate inline script is a static login FOUC guard.
- **Why held:** the proper fix is a per-request **nonce** (Next 15 supports
  nonce injection via middleware) or a hashed inline script — a non-trivial
  change touching middleware + the login page, best scheduled rather than
  hotfixed. (Note the interaction with D1: middleware changes should land after
  the Next bump.)
- **Proposed action:** move the login FOUC guard to an external/hashed script,
  add a per-request nonce, drop `'unsafe-inline'` from `script-src` (keep it on
  `style-src` if Tailwind needs it — far lower risk). Add `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'` while there.
- **Decision needed:** schedule it (order it after D1).

### D4 — Sender-spoof / DMARC posture (MEDIUM · ops-verify)

- **Finding (SENDER):** the AP mailbox's `sender_validated` trusts the Graph
  `from` (the forgeable From header), not an authenticated envelope — the code
  comments overstate it as "authenticated." In `tenant_wide` mode any `@svdp.us`
  From becomes an approvable request. The only thing between this and a clean
  forgery (a fraudulent invoice injected into the approval queue, plus an SSRF
  body) is M365/EOP inbound anti-spoofing + DMARC enforcement for `svdp.us`.
- **Why held:** the real question is a **tenant-side configuration fact** we
  must verify, not a code change we can just make.
- **Proposed action:**
  1. **Verify** `svdp.us` DMARC is `p=quarantine` or `p=reject` and EOP
     anti-spoof is enforcing (send an external `From: x@svdp.us` to the AP
     mailbox and confirm it does NOT land `pending`).
  2. In code, correct the misleading "authenticated envelope" comments and,
     if feasible, gate on the `authentication-results` header (DMARC=pass) via
     Graph `internetMessageHeaders` rather than the From header alone.
- **Decision needed:** confirm the tenant DMARC posture; then greenlight the
  comment/header-gate code change.

### D5 — Moderate-CVE dependency clear (MEDIUM · low-risk)

- **Finding (CVE):** 32 moderate CVEs in the prod tree (`postcss`,
  `protobufjs`, `ws`) clear with a **non-breaking** `npm audit fix`. The
  `uuid`←`exceljs` chain only fixes via a breaking `exceljs` downgrade — do NOT
  run `--force`; track upstream instead.
- **Why held:** trivially safe on its own, but it's a lockfile change best
  bundled with D1's rebuild + test cycle so there's a single verification pass.
- **Proposed action:** fold the non-breaking `npm audit fix` into D1's branch;
  leave the `uuid`/`exceljs` chain as a documented `[watch]` (the export path
  does not pass attacker-controlled `buf`).
- **Decision needed:** none beyond approving D1; noted so it isn't forgotten.

## Decision

Deferred — awaiting Bill. Each item above carries its own recommendation; this
ADR is Accepted-in-part as each is resolved. Sequencing: **D1 (+D5) first**
(the auth-layer bump + CVE clear in one window), **then D3** (CSP nonce via
middleware, after the Next bump settles), **D2** independently (session
revocation), **D4** independently (verify DMARC, then the small code change).

## Consequences

- Until D2 lands, off-boarding a manager/admin MUST assume their session stays
  privileged for up to the token lifetime — treat account deactivation as
  necessary-but-not-instant, and rotate anything sensitive they held.
- Until D1 lands, the middleware-bypass advisory is unmitigated at the
  framework level (partially mitigated by the app's own per-route guards).
- Until D4 is verified, the AP approval queue's forgery resistance depends on an
  unconfirmed tenant DMARC posture.
- D3 is latent risk only (no known injection today), but it removes the last
  line of defense if one appears.

## References

- `docs/security/2026-07-16-full-stack-audit.md` (full register + verified-sound list)
- PRs #116 (money/audit-integrity fixes), #117 (input/infra hardening) — the `[fix]` rows already shipped
- ADR-0062 (noc-master) — the deploy saturation guard (relevant when scheduling D1's deploy window)
