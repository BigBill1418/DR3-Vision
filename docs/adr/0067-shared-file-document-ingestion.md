# ADR-0067 — Shared-file document ingestion (Amendment A: delegated auth-code, not ROPC)

**Status:** Accepted (2026-07-29)
**Date:** 2026-07-29
**Series:** PR #179 Phase 3. Follows ADR-0066 (AP peer routing, Phase 1).
**Relates to:** ADR-0046 (Graph mailbox ingestion — same app registration), ADR-0049 (Graph Files, application permissions), ADR-0057 (encrypted credential store + D9 fail-loud posture), ADR-0037 (notification noise policy), ADR-0047 (staff-facing rollout gate)
**Amendment A supersedes §3.5 of the Phase 3 directive ENTIRELY.** Where §3.5 assumed unattended sign-in implies ROPC and worried about Conditional Access, Amendment A retires that framing. The auth decision below is settled and is not to be re-litigated.

---

## Context

Bill hand-uploads every document Vision needs. Invoices, workbooks, MRC paperwork, spreadsheets someone else maintains — all of it arrives because a human noticed, downloaded, and re-uploaded it. That is the process this ADR exists to end.

The obvious fix — forward the email — does not actually fix it. **An emailed attachment is a SNAPSHOT.** The instant it left the sender it stopped tracking its source. If the workbook is corrected the next morning, Vision is holding yesterday's numbers and has no way to know. Every downstream figure inherits that staleness silently.

**A shared FILE is current state.** The document stays where it lives in Microsoft, is shared to a service account, and Vision reads the _live_ document. When it changes, Vision sees the change. That distinction — snapshot versus current state — is the whole point of this ADR, and it is why the data model below is version-aware rather than drop-shaped.

Vision already talks to Graph twice: AP mailbox polling (ADR-0046) and workbook file reads (ADR-0049). Both use **application** permissions via client-credentials against a service principal. That model does not fit here. Shared-with-me is a _user-relative_ concept: there is no application-level "things people shared with this app". The set of documents Bill's colleagues share exists only in the context of an account they can share _to_. So this integration needs a **delegated** identity — an actual mailbox-and-OneDrive-having user account — which is what `docs-dr3@svdp.us` is for.

---

## Decisions

### D1 — Documents stay where they live; Vision reads the live file

Vision does not ask anyone to upload, forward, or copy a document. The owner shares the file (or folder) with `docs-dr3@svdp.us` from wherever it already lives — their OneDrive, a SharePoint library, a Teams-backed site — and Vision reads it in place.

This is a product decision before it is a technical one. It means the document has exactly one home, the owner keeps control of it, and there is no second copy to drift.

### D2 — A dedicated service account, not a person's account

`docs-dr3@svdp.us` (object id `7ad08443-3d96-400e-9e4d-0c34208305e2`) is the sharing target. Sharing to a person would bind the entire integration to that person's employment, their mailbox lifecycle, and their personal file set — and would make every document they _personally_ have access to visible to Vision, which is a far wider blast radius than anyone intends.

The account's OneDrive is the ingestion surface. Its shared-with-me set is the work queue.

### D3 — Delegated authorization-code + refresh token (Amendment A). NOT ROPC.

**This is the decision Amendment A settles, and it supersedes §3.5 entirely.**

The earlier framing reasoned: ingestion must run unattended → therefore sign-in must be non-interactive → therefore ROPC (resource-owner password credentials) → therefore Conditional Access and MFA are obstacles to be negotiated with IT.

Every step after the first is wrong. Unattended _operation_ does not require unattended _sign-in_. The standard authorization-code flow issues a **refresh token** that is redeemed indefinitely without a human present. The human is needed exactly once, at the beginning.

The flow:

1. Bill opens `/admin/doc-ingest/connect` and clicks **Connect document service account**.
2. Standard auth-code redirect to Entra.
3. **He signs in interactively as `docs-dr3@svdp.us`**, completing MFA in the browser like any person would.
4. Vision exchanges the code for an access token + refresh token.
5. The refresh token is stored encrypted and rolled forward on every redemption.

**No Conditional Access change is needed.** The MFA claim was satisfied at sign-in and rides the token chain. This is the single biggest simplification Amendment A delivers: an IT policy negotiation is replaced by one browser sign-in.

ROPC is additionally deprecated by Microsoft, disabled by default in most tenants, incompatible with MFA by construction, and would have required the service-account password as a permanent runtime credential. It is rejected on all four counts, any one of which would be sufficient.

### D4 — The service-account password is NOT a runtime credential

It is typed once, by a human, into Microsoft's own sign-in page. It never reaches the Vision secret store, `.env`, `docker-compose.yml`, Postgres, or a log line. There is deliberately **no column, field, or env var for it anywhere in this design**.

This is stated as a decision rather than left implicit because it is the load-bearing consequence of D3, and it is the check that catches a regression: **if a future change needs the password at runtime, that change has reverted to ROPC and is wrong.**

### D5 — Reuse the existing app registration and its existing secret

Registration `2da92424-7397-435d-96a1-d2a382293a53` in tenant `72843ea8-e50d-4500-a0d5-d924e9acb4d5` — the same one AP mail (ADR-0046) and Graph Files (ADR-0049) authenticate with. Verified live against prod: `~/.dr3-vision-secrets/msgraph-mail.env` carries exactly this tenant and client id.

Delegated scopes, admin-consented tenant-wide and verified live:

```
email  Files.Read.All  offline_access  openid  profile  Sites.Read.All  User.Read
```

Redirect URI: `https://dr3-vision.svdp.us/api/admin/doc-ingest/oauth/callback`

Tenant id, client id, service UPN, object id and redirect URI are **not secrets**. They are directory coordinates that appear in every redirect URL the operator's browser sees. They are therefore **constants in source** (`src/lib/doc-ingest/config.ts`), not env vars — nobody can mis-provision them, and drift between the running config and this ADR is impossible.

**⚠ The client secret ALREADY EXISTS: `DR3-Vision Production`, valid to 2028-05-05. Do NOT create a second one.** `readClientSecret()` falls back to `MSGRAPH_MAIL_SECRET` precisely so nobody is tempted to.

**Rotation note, and the reason it is called out here:** that secret is shared across AP mail polling _and_ document ingestion. A silent expiry stops both at the same moment, and they will present as **two unrelated outages** — which is exactly the coincidence that costs a day of misdirected debugging. The 2028-05-05 date is surfaced on the connect page and belongs in the rotation runbook.

### D6 — Tokens encrypted at rest in Postgres, never in a `.env`

Refresh and access tokens live AES-256-GCM-encrypted in `doc_ingest_connections`, following the ADR-0057 MyMRC pattern exactly: dedicated key, scrypt KDF with a fixed app salt, random 12-byte nonce, and a persisted `key_version` gating decrypt.

The key is **dedicated** — deliberately not `MYMRC_CRED_KEY` and not `NEXTAUTH_SECRET`. `MYMRC_CRED_KEY` protects Salesforce portal credentials; this protects a Graph refresh token that can read every document shared with the service account. One key for both would make a MyMRC-scrape compromise a document-store compromise.

It is mounted from `~/.dr3-vision-secrets/doc-ingest.env` with `required: false`, so an unprovisioned host still boots. **That mount is the only softness in the design.** Once code needs the key, a missing key throws `DocIngestKeyUnavailableError` and the connect endpoint returns a loud 503. It never silently no-ops — the ADR-0057 D9 posture, adopted here for the same reason it was adopted there: a fail-soft credential path produced _zero pulls in months_ and nobody noticed.

The status read path (`getDocIngestConnectionStatus`) does not SELECT a single ciphertext column. The response shape cannot leak a token because the token is not in the query.

### D7 — The signed-in account is ASSERTED, and a mismatch is REFUSED

After the code exchange, Vision calls Graph `/me` and asserts the UPN equals `docs-dr3@svdp.us` (case-insensitively). **If a different account authenticated, the connection is refused and no token is persisted.**

This is the single most important control in the ADR. Bill signing in as himself by reflex is the likely mistake — he is already signed into Entra, the browser will happily reuse that session, and the flow would _succeed_. Vision would then be reading **his personal OneDrive and everything shared with him**, rather than the service account's curated shares. It would look like it worked.

Three layers guard it:

- `prompt=login` on the authorize request, forcing a fresh sign-in rather than silent SSO reuse
- `login_hint=docs-dr3@svdp.us`, so the right account is also the easy one
- the server-side `/me` assertion, which is the actual control — the first two are ergonomics

The connect page names `docs-dr3@svdp.us` explicitly, in both the disconnected and connected states, and on refusal says plainly which account was used.

`/me` is used rather than parsing the `id_token` deliberately. The id_token arrives over a direct TLS back channel and is trustworthy, but `/me` is an authoritative live check against the very credential about to be stored, and it costs one request on a once-per-connect path. The control that prevents the worst outcome gets the stronger check.

### D8 — `reauth_required` halts ingestion LOUDLY; it never degrades quietly

Any refresh failure attributable to an invalidated or expired token latches `state = reauth_required` and:

- **pages `dr3-vision-system` immediately** on the transition (ADR-0057 D9 — silence is never acceptable),
- raises a banner with a Reconnect action on the connect page,
- adds a line to Bill's 06:00 digest **until resolved**,
- and **halts ingestion**. Nothing degrades, nothing retries into the void, nothing pretends to work.

Two design points make this correct rather than merely noisy:

**Only a dead refresh token latches.** `invalid_grant`, `interaction_required`, `consent_required`, `login_required` — these mean a human must act. A network failure, a 429, a 5xx does **not** latch; it is recorded in `last_refresh_error` and retried. Paging for a blip teaches the operator to ignore the page that matters.

**The dedup ledger is a Postgres column, not the ntfy helper's in-process cache.** `publishNtfy`'s cooldown ledger is per-process and per-container. Ingestion will run across the app _and_ a worker, and containers restart — a per-process cooldown would either re-page on every restart or, worse, suppress the _first_ page after one. `reauth_paged_at` is the ledger every process shares, so `cooldownMs: 0` is passed deliberately. The transition always pages; the unresolved state re-pages at most every 24 h, with the 06:00 digest line carrying the rest.

Severity is `high`, not `urgent`, per the ADR-0037 rubric: it is actionable within five minutes and it routes to a tier-1 page (`/admin/doc-ingest/connect`), but it is internal-operations impact, not customer-visible.

The digest line goes into the **existing** AP 06:00 digest's `warnings` array rather than a new email. ADR-0066 §1.7 reserves a future _document-ingestion digest_ for itself, and this is not that — it is a one-line system-health warning. It belongs in `warnings` specifically because a warning sends even when the AP queue is empty: a halted ingester produces no items, so an items-gated line would be invisible exactly when it matters most.

### D9 — Schema: version-aware sources, an idempotent anomaly ledger, and additive `file_drops` provenance

Five tables (`doc_ingest_connections` is the Amendment A addition to the §3.3 four):

| table                      | what it is                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `doc_ingest_connections`   | singleton; the encrypted delegated connection + reauth latch + OneDrive provisioning state |
| `doc_sources`              | one row per shared file/folder Vision watches                                              |
| `doc_source_versions`      | append-only observed revisions — this is what makes "live document" real                   |
| `doc_ingest_subscriptions` | Graph change-notification + delta state (written by the next phase)                        |
| `doc_ingest_anomalies`     | the guardrail ledger (raised by the next phase)                                            |

Load-bearing details:

- **`id` columns are TEXT, not `uuid`.** A `uuid`-typed id passes CI (which does not run migrations) and fails only on deploy, taking the app down. House rule; it has caught two real defects. The migration was validated against **live prod inside a `BEGIN; … ROLLBACK;`**, including a column-type assertion over all five tables.
- **`(drive_id, item_id)` is the natural key on `doc_sources`.** A driveItem id is only unique within its drive, and the shared-with-me set spans several people's OneDrives. The pair is what makes the sweep's upsert idempotent.
- **`(doc_source_id, ctag)` is unique on `doc_source_versions`.** `ctag` changes on content change. This is what makes a re-delivered Graph notification a no-op instead of a duplicate ingest.
- **`doc_ingest_anomalies` dedups via `fingerprint` + a PARTIAL unique index `WHERE status = 'open'`.** A recurring condition bumps `occurrences`/`last_seen_at` instead of growing a row-per-poll queue, while resolved rows with the same fingerprint are still allowed — they are the evidence that a thing was wrong and got fixed. Prisma cannot express a partial unique index, so `@@unique([fingerprint])` is deliberately absent from the model and writers must go through the raiser helper rather than a bare `upsert`.
- **`access_denied` is not folded into `disappeared`.** A revoked share and a deleted file look identical from a 404 but need different operator action. Collapsing them is how "the document is gone" silently becomes "nobody noticed the share lapsed".
- **`doc_sources.site_id` is nullable and means UNCLASSIFIED, never "both".** Hard rule #2 (Eugene/Woodland separation) is not weakened: a NULL-site source must not leak into a site-scoped list. The classifier sets it.
- **`doc_sources.enabled` is separate from `doc_sources.state`.** `state` is what Microsoft says; `enabled` is what Bill says. Never conflate them.
- **R2 for bytes.** `doc_source_versions.r2_key` holds a key, never a blob and never a local path (hard rule #7).
- **`file_drops` additions are purely additive.** `ingest_source` (`manual` | `email` | `shared_file`) defaults to `manual` and `doc_source_id` is NULL — which is _true_ of every pre-existing row, so there is no backfill and no behaviour change on `/admin/file-drop`. Verified on prod: all 5 existing rows read `manual` with no `doc_source_id`.

### D10 — OneDrive provisions asynchronously; an initial 404 is NOT an error

`Get-MgUserDefaultDrive` / `GET /me/drive` can 404 for a while after the account is licensed. The drive is created by the account's **first interactive sign-in** — which is the very sign-in this flow performs.

So `probeDefaultDrive` never throws and never fails the connect. A 404 records as `pending` and renders as "Still provisioning… this is normal immediately after licensing, not an error." Treating it as fatal would break first-connect for anyone who does it promptly, and would send the operator hunting a non-problem.

---

## Alternatives considered

**ROPC (the original §3.5 assumption).** Rejected — deprecated, disabled in most tenants, incompatible with MFA, and requires the password as a permanent runtime credential. Amendment A retires it. See D3.

**Application permissions + client credentials, like ADR-0046/0049.** Rejected — "shared with me" has no application-level analogue. `Files.Read.All` as an _application_ permission grants read over **every** drive in the tenant, which is a vastly wider grant than "the documents people chose to share with this account", and it still would not produce the shared-with-me list.

**Keep forwarding email, just automate the parsing.** Rejected — this is the snapshot problem restated. It would work and would be wrong, which is the most expensive kind of solution.

**Store a snapshot of each document and treat it as the source of truth.** Rejected as the _primary_ model for the same reason; snapshots are retained (`doc_source_versions` + R2) as **evidence**, not as the read path.

**A `doc_ingest_oauth_states` table for CSRF state + PKCE verifier.** Rejected — it needs a TTL sweeper and a cleanup cron to avoid growing forever, to hold data needed for one round trip of one browser. A sealed (AES-256-GCM) httpOnly `SameSite=Lax` cookie carries both, self-expires, and cannot be read or forged. Lax specifically, not Strict: the callback is a top-level GET navigation from `login.microsoftonline.com`, and Strict would withhold the cookie and fail every connection attempt.

**Deriving the redirect URI from the request host.** Rejected — it mismatches behind the Cloudflare tunnel and is an open-redirect shape. It is a constant, overridable only for a non-prod tenant.

**A second client secret for this integration.** Rejected — see D5. The existing one is valid to 2028-05-05 and a second would double the rotation surface for zero isolation benefit (same app, same permissions).

**Requiring `openid`/`profile`/`offline_access` in the granted-vs-required scope diff.** Rejected — Entra does not echo OIDC scopes in the token response's `scope` field, so requiring them there reports a permanent **false negative** on a perfectly healthy connection. They are proven more strongly instead: `offline_access` by the presence of a refresh token (the exchange throws without one), the identity scopes by the presence of an `id_token`.

---

## Consequences

**We commit to:**

- One interactive sign-in as `docs-dr3@svdp.us` before anything ingests. This is an operator action and cannot be automated — by design.
- Keeping the service-account password out of every runtime path, forever. A change that needs it has reverted to ROPC.
- **No new secret is required.** An earlier revision of this ADR asked the operator to provision `~/.dr3-vision-secrets/doc-ingest.env` with a `DOC_INGEST_TOKEN_KEY`. **That is retired.** It contradicted the operator rule against `.env` files for credential material, and it gated the whole feature on a manual step for no cryptographic benefit. The AES key protecting the delegated refresh/access tokens is now DERIVED via scrypt, with a doc-ingest-specific salt, from `MYMRC_CRED_KEY` — the credential-encryption secret ADR-0057 already established and which is already mounted on the app container. The salt supplies domain separation, so the two subsystems never share an AES key.
- **Rotation consequence, stated plainly:** rotating `MYMRC_CRED_KEY` renders stored doc-ingest tokens undecryptable. That costs exactly one click of **Connect** — a refresh token is re-obtainable, whereas the MyMRC login would have to be re-entered. `open()` fails closed on a wrong key and the access-token path latches `reauth_required` and pages, so the failure is loud and the remedy is a single re-auth, never data loss.
- Tracking the 2028-05-05 client-secret expiry in the rotation runbook, with the AP-mail coupling stated — a silent expiry is a simultaneous double outage that will look like two separate bugs.
- Persisting the NEW refresh token on every redemption. Entra rotates it; a caller that ignores the returned token kills the chain silently when the old one ages out. `acquireAccessToken` is the single seam that does this correctly, and every consumer must go through it.
- Never re-implementing the refresh-and-latch policy. One place, one opinion about what counts as broken.

**We accept:**

- The connection is a **single point of failure** for all shared-file ingestion. That is the trade for a single point of _control_, and D8 makes the failure loud rather than silent.
- A `reauth_required` state can only be cleared by a human at a browser. There is no self-healing path, and inventing one would mean storing the password.
- `doc_sources.site_id` starts NULL for every discovered source. Site scoping is a classifier output, not an ingestion input, so between discovery and classification a source is genuinely unscoped and must be treated as such.

**Not built here — the next phase's scope, with seams left for it:**

Graph change subscriptions, the delta sweep, the document classifier, and the anomaly guardrail. Their tables, enums, indexes and relations exist; `acquireAccessToken(prisma)` is the auth seam; `latchReauthRequired` / `recordTransientRefreshFailure` are the failure seams; the `fingerprint` + partial-unique-over-open pattern is the idempotent anomaly-raise target.

**Unverified at time of writing:** nothing in this ADR has executed against the live tenant. The migration is validated against live prod (rolled back); the flow is validated against stubbed Entra/Graph responses. First contact — the real authorize redirect, the real token response body, the real `/me`, the real `/me/drive` — happens when Bill clicks Connect, and remains unproven until then.


---

## Amendment 1 — 2026-07-29 — the app requires USER ASSIGNMENT (missing from Amendment A)

**Symptom:** Bill clicked **Connect**, signed in as `docs-dr3@svdp.us`, and got
*"Your Microsoft account isn't authorized for DR3-Vision. Ask an admin to add you."*

That string appears **nowhere in this codebase** (grepped). It is **Microsoft's**
rejection page, which names the application — so it reads as though Vision
refused, when in fact Entra blocked the sign-in before OAuth consent was ever
reached.

**Cause, verified live via Graph:** the DR3-Vision service principal
(`76787659-f9a8-4f48-96c3-d0d77d2719fe`) has **`appRoleAssignmentRequired: true`**,
and only two principals are assigned — the user *Bill Barnard* and the group
*DR3-Vision Admin Access*. `docs-dr3@svdp.us` is not among them, so Entra
refuses it.

**Amendment A did not mention this.** It documented the granted scopes, the
redirect URI, the existing client secret and the auth model — all correct — but
not that the enterprise application blocks unassigned users. Provisioning the
account, licensing it and consenting the scopes is **necessary but not
sufficient**.

**Resolution (operator, admin rights required):** assign `docs-dr3@svdp.us`
directly to the DR3-Vision enterprise application — *not* via the
`DR3-Vision Admin Access` group. The group's name implies privileges a service
account should not have, and the reason for its membership would not survive
six months of institutional memory. The `AppRoleId` is the all-zero GUID
(`00000000-…-0`), Entra's "default access" role for an app that declares no
custom roles.

**Why Claude Code could not do it:** the app-only Graph token available on the
box carries 3 application grants and returns `Authorization_RequestDenied` even
for `GET /users/{upn}` — it cannot write app role assignments.

**Generalisable lesson:** an Entra app registration has two independent gates —
*can this identity authenticate to the app at all* (assignment) and *what may it
then do* (scopes/consent). Amendment A exhaustively documented the second and
silently assumed the first.
