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
_"Your Microsoft account isn't authorized for DR3-Vision. Ask an admin to add you."_

That string appears **nowhere in this codebase** (grepped). It is **Microsoft's**
rejection page, which names the application — so it reads as though Vision
refused, when in fact Entra blocked the sign-in before OAuth consent was ever
reached.

**Cause, verified live via Graph:** the DR3-Vision service principal
(`76787659-f9a8-4f48-96c3-d0d77d2719fe`) has **`appRoleAssignmentRequired: true`**,
and only two principals are assigned — the user _Bill Barnard_ and the group
_DR3-Vision Admin Access_. `docs-dr3@svdp.us` is not among them, so Entra
refuses it.

**Amendment A did not mention this.** It documented the granted scopes, the
redirect URI, the existing client secret and the auth model — all correct — but
not that the enterprise application blocks unassigned users. Provisioning the
account, licensing it and consenting the scopes is **necessary but not
sufficient**.

**Resolution (operator, admin rights required):** assign `docs-dr3@svdp.us`
directly to the DR3-Vision enterprise application — _not_ via the
`DR3-Vision Admin Access` group. The group's name implies privileges a service
account should not have, and the reason for its membership would not survive
six months of institutional memory. The `AppRoleId` is the all-zero GUID
(`00000000-…-0`), Entra's "default access" role for an app that declares no
custom roles.

**Why Claude Code could not do it:** the app-only Graph token available on the
box carries 3 application grants and returns `Authorization_RequestDenied` even
for `GET /users/{upn}` — it cannot write app role assignments.

**Generalisable lesson:** an Entra app registration has two independent gates —
_can this identity authenticate to the app at all_ (assignment) and _what may it
then do_ (scopes/consent). Amendment A exhaustively documented the second and
silently assumed the first.

---

## Amendment 2 — 2026-07-29 — Amendment 1 was WRONG. The real cause is a two-sign-in confusion.

**Amendment 1 above is retained as a record of a misdiagnosis, and is superseded
by this.** Its conclusion (that Entra's `appRoleAssignmentRequired` blocked the
service account) is **false**. Do not act on it.

### What actually happened

Live application logs settle it:

```
event: entra_signin_denied   email: docs-dr3@svdp.us   reason: "unknown"
```

`reason: 'unknown'` is `evaluateEntraSignIn`'s verdict for _no `users` row with
this email_. So Microsoft authenticated `docs-dr3` **successfully** — Vision's
own SSO gate then refused it, and the message shown is Vision's own
`auth_login.error_access_denied` string.

**The operator was signing into VISION as `docs-dr3`, not into the Microsoft
consent prompt.** There are two sign-ins in this flow and they are easy to
conflate:

1. Sign into **Vision** as a real admin (`bill.barnard@svdp.us`).
2. _Then_ click **Connect document service account**, which starts a **separate**
   OAuth authorize flow where the Microsoft prompt takes `docs-dr3@svdp.us`.

Reaching `/admin/doc-ingest/connect` while logged OUT redirects to `/login`, and
the first sign-in screen the operator meets is therefore Vision's — which,
combined with an instruction to "sign in as docs-dr3", produces exactly this.

**`docs-dr3` must never be able to sign into Vision.** It has no `users` row by
design and should not be given one; it is an identity for reading files, not an
application user.

### How the misdiagnosis happened, recorded so it is not repeated

The message was searched for with `grep -rn … --include=*.ts --include=*.tsx`.
The string lives in **`src/i18n/locales/en/operator.json`** — a file class the
filter excluded. The empty result was then reported as _"this string exists
nowhere in the codebase, therefore it is Microsoft's page"_, and an Entra
`appRoleAssignmentRequired` finding (true, but unrelated) was accepted as the
cause. **An absence of evidence produced by a filtered search is not evidence of
absence.** i18n'd user-facing copy will essentially never be found by a
`.ts/.tsx`-only grep.

### Consequences

- The Entra app assignment change is **unnecessary**. `appRoleAssignmentRequired`
  is genuinely `true`, but the account never got far enough for it to matter.
  Adding `docs-dr3` to _DR3-Vision Admin Access_ should be reverted;
  `docs/runbooks/entra-assign-docs-dr3.ps1` has a conditional removal step.
- **The real fix is documentation, not configuration**: the connect surface must
  make the two-sign-in sequence unmistakable, and the operator instruction must
  never say "sign in as docs-dr3" without first saying "while signed into Vision
  as yourself".

---

# Pipeline addendum (accepted 2026-07-29) — §3.2 D4–D8 and §3.4

**Appended, not renumbered.** Everything above stands. This records the decisions
made building the ingestion pipeline itself: discovery, subscriptions, the delta
sweep, the classifier, and the guardrail. Two of them are findings about
Microsoft's own platform that change what is achievable, and they are stated
first because they bound everything else.

## P1 — ⚠ `sharedWithMe` is deprecated, and discovery is built behind a seam because of it

`GET /me/drive/sharedWithMe` — the API this entire design depends on — was
**deprecated by Microsoft in November 2025**. Per learn.microsoft.com it, and
`/me/insights/shared` alongside it, "operate in a degraded state until November
2026, after which [they] stop returning data." Microsoft has published **no
one-to-one replacement**; their own Q&A thread on the deprecation concludes with
"I am not aware of any publicly documented one-to-one replacement", gesturing
only at the Microsoft Search API.

This is not a detail to note and move past. "What has been shared with this
account" _is_ discovery, and D1's whole premise — the owner shares, Vision reads
in place — has no meaning without an enumeration of what was shared.

What is done about it:

- discovery calls a `SharedItemSource` interface, never Graph directly, so
  replacing the enumeration is one implementation and not a rewrite of the
  traversal, dedup and reconciliation logic, none of which cares where the roots
  came from;
- `SHARED_WITH_ME_SUNSET` is a single constant and `/admin/doc-ingest/health`
  renders a live countdown from it;
- it is logged as **C-43** in `docs/OPEN-ITEMS.md` with a date and an owner.

**A speculative Search-API implementation is deliberately NOT shipped.** It
cannot be verified against the live tenant today, and an unverified fallback that
silently returns a _different_ set of sources is worse than a loud countdown: the
failure mode of a wrong enumeration is a document nobody notices is missing,
which is the exact class of silence this ADR exists to eliminate.

## P2 — Change subscriptions need write consent we deliberately do not hold

Microsoft's permissions table for `PATCH /subscriptions` lists the delegated
permission required to create or manage a `driveItem` subscription on OneDrive
for Business as **`Files.ReadWrite.All`**. D5 consented to **`Files.Read.All`** —
read-only, with no write path anywhere in the codebase. Graph is therefore
expected to refuse subscription creation with a 403.

That is a real conflict between a requirement and a security posture, and it is
resolved in favour of the posture:

- the subscription attempt still runs, so the day the scope is widened push
  begins working with **no code change**;
- the refusal is recorded as an anomaly whose text states plainly that this is
  the expected consequence of read-only consent and not a misconfiguration, so
  nobody burns a day hunting a bug that is not there;
- the sweep carries correctness regardless, exactly as D4 requires.

The trade, stated so it can be decided rather than drifted into: granting
`Files.ReadWrite.All` gives this integration **write access to every file the
service account can reach, across every drive shared with it, permanently**, in
exchange for reducing change latency from one sweep interval (15 minutes) to
about a minute — on data that already arrives correctly. The recommendation is
not to grant it. Either way it is Bill's decision (**C-44**), not a defect.

## P3 — The sweep is the correctness path; push is only latency

The strongest constraint in §3.2 D4, restated here because it is the decision
every other one bends around: **a push-only ingester fails silently.** A
subscription lapses, a notification is dropped, a handshake breaks behind a
proxy — and nothing errors. The data stops moving while every surface keeps
reporting success. That is precisely what had MyMRC ingesting nothing for months
(ADR-0057 D9).

So `runDocIngestSweep` runs on a schedule **independent of webhook health**. It
never checks whether a subscription exists, never skips because a notification
arrived recently, and does not stop when the push path is entirely dead — there
is a test for each of those three. A `doc_ingest_sweep_runs` ledger row is
written on **every** run including a throw (the `ap_poll_runs` contract, ADR-0046
C6), because a sweep that stops running has to be visible; and
`/admin/doc-ingest/health` leads with sweep freshness rather than subscription
count, since a page headlining "3 active subscriptions" would look healthy while
the correctness path was dead.

Given P2, this is not merely defensive design — it is currently the _only_
working path, which is a useful accident: the fallback is the thing under
continuous test rather than a cold spare nobody exercises.

## P4 — Identity is the immutable driveItem id, and the `remoteItem` unwrap is where that is won

D8 requires that a rename is not a new file, a move is not a new file, and two
people sharing one document is not two documents. All three collapse into one
rule: key on `(drive_id, item_id)`.

The subtlety is that `sharedWithMe` does not return that pair directly. It
returns a **local stub** whose own `id` belongs to the _service account's_ drive,
wrapping the real item in a `remoteItem` facet. Keying on the stub would make
every source appear to live in one drive and would break dedup the moment the
same file arrived by a second route. `projectDriveItem` therefore unwraps it
once, at the transport boundary, and nothing downstream ever sees a stub.

## P5 — Classification is locked by the absence of a second flag

D5's "classify once, confirm once, then locked" is implemented as: `doc_class IS
NOT NULL` **is** the lock. There is deliberately no `confirmed` boolean, because
a boolean is a second source of truth that can disagree with the column it
describes — and the first time it did, the pipeline would either re-ask a settled
question or skip an unsettled one. `classifySourceIfNeeded` returns early on a
non-null `doc_class`, and `confirmClassification` refuses to overwrite one
(changing a registered kind is a separate, separately-audited action).

`unknown` is a first-class outcome rather than a failure. Bill pre-registers
nothing, so an unrecognized document is the _normal_ case for a new share: it
queues, it waits for him, it does not error, and it does not page — paging on it
would page on every share, which ADR-0037's gate rules out explicitly.

`vendor_invoice` is in the vocabulary **so it can be refused**. It is not routed
here, and the flag names `ap@svdp.us` (ADR-0046) as the correct address, because
a document sitting in a queue nobody processes is the failure that flagging
exists to prevent.

## P6 — One variance concept, imported rather than reimplemented

The D7 aggregate check calls `evaluateVariance` from ADR-0046 Amendment 5
(D-M5-4) and re-exports its `$50`-flat / `15%` constants rather than declaring
its own. The directive asked for one anomaly concept in the system and not two,
and the mechanism matters: if these were separate constants, the first time
anyone tuned one of them the system would hold two different opinions about what
"abnormal" means, with nobody able to say which applied where. A test pins both
values so a future fork is a red build rather than a silent divergence.

Two deliberate consequences:

- **Only _aggregate-looking_ columns are checked.** A workbook is full of numeric
  columns that are not aggregates — years, row ids, ticket numbers — and scoring
  those as money produces alarms that are pure noise. Under ADR-0037 a guardrail
  that cries wolf is worse than none, because the operator learns to click
  through it.
- **A unit count is scaled into the evaluator's integer-cents space.** That is a
  unit bridge, not a claim that counts are dollars: it makes the flat threshold
  read as "50 units" for a count column, which is the same job the flat threshold
  does for money — stopping the percentage rule firing on tiny numbers.

## P7 — "Do not retry in a loop" is a stored latch, not a convention

D8 requires that a password-protected or oversized file is marked and paged and
then **left alone**. `doc_sources.read_blocked_at` + `read_blocked_ctag` are that
latch. Two properties make it correct rather than merely present:

- it lives in Postgres, so a container restart cannot forget it and resume the
  loop;
- it releases on a **content** change (a new `ctag`), because a genuinely new
  file deserves exactly one more attempt while an unchanged one deserves none.

Password-protected files are detected from the container's **magic bytes** before
any parser runs: an encrypted OOXML file is an OLE/CFB compound file, not a
damaged zip. Sniffing that gives a precise, actionable "this needs a password"
rather than a generic parse failure — and precision is what justifies latching at
all, since latching on an ambiguous error would strand a file that was merely
corrupt for a moment.

Oversize is refused by a **streaming** read that aborts at the cap, never by
buffering and checking afterwards, and it never returns a truncated buffer: a
truncated workbook parses perfectly cleanly and produces wrong billing numbers,
which is the worst available outcome.

`.xlsm` support is not a flag. exceljs is a pure-JS reader with no macro engine,
so `vbaProject.bin` is simply never executed — it is a property of the parser
rather than a setting, which is why it can be relied on. Tested against real OOXML
bytes rather than a stub.

## P8 — "Owner left" is inferred from the one signal we are actually allowed to see

D8 asks that an owner leaving be distinguished from a share being revoked, and
that the alert **name the previous owner**. Vision cannot ask Graph whether a
person still exists: that needs `User.Read.All`, and this integration holds
`User.Read` (its own identity) by design.

So the inference is drawn from the only observable signature: **every** source a
given owner shared became unreachable in the same pass, and there was more than
one. A single revoked share does not look like that; a disabled account does. The
alert names them from the `owner_upn` recorded at discovery — which, once the
account is gone, is the only place that name still exists — and it states the
alternative explanation rather than asserting a conclusion it cannot prove.

It also suppresses the per-file anomalies it subsumes: twelve pages for one
departure is exactly the deduplication failure ADR-0037's fourth question asks
about.

## P9 — Consequences

**We commit to:**

- Replacing the `sharedWithMe` enumeration before 2026-11-01 (**C-43**). The seam
  makes it cheap; the countdown makes it hard to forget.
- Keeping the sweep's independence from webhook health. Any future change that
  makes the sweep conditional on a subscription, a notification, or a "nothing
  changed" hint has reintroduced the push-only failure mode.
- Treating a staged revision as _not the baseline_. The guardrail compares against
  the last **applied** revision, so a rejected change can never silently become
  the new normal.

**We accept:**

- Push notifications do not currently work (P2), so change latency is one sweep
  interval. Correctness is unaffected.
- The owner-left inference (P8) is a heuristic. It can be wrong in one direction
  — an owner revoking all of their shares at once looks identical — and the alert
  says so rather than hiding it.
- The first non-empty row is taken as the header row. It is right for every
  workbook this pipeline has seen, and a wrong guess degrades to "the guardrail
  compares odd-looking column names consistently", not to a wrong number.

**Unverified at time of writing (C-45):** nothing here has run against the live
tenant. Bill has not completed the one-time sign-in, so the real `sharedWithMe`
payload, the real validation handshake, a real subscription attempt, and real
`.xlsm` daily-log bytes are all unproven. The design's answer to each of those
failing is "slower" or "reported", never "silently wrong" — and first contact is
exactly what should test that claim.

---

## Amendment 3 — 2026-07-29 — discovery must be re-founded, and §5.1's permission claim is FALSE

### A. `sharedWithMe` is not merely deprecated — the capability is being removed

`GET /me/drive/sharedWithMe` **and** `GET /me/drive/recent` **and** `/insights/shared`
all carry the same retirement: degraded until **2026-11**, then no data. That is
the whole _user-relative aggregation_ family, which is why Microsoft's own Q&A
answer is that there is **no one-to-one replacement** — the capability is going,
not the URL.

Worse, the degradation is **already active**: Microsoft applied a mitigation
reducing the returned set to **1 item**. Independent reports show Graph Explorer
listing 6 shares while the API returns 1, and `msgraph-sdk-dotnet#3040` is
labelled _Won't fix_ as a server-side limitation.

_(Documentation ambiguity: a Microsoft moderator states 2027-11 on the
replacement thread while the API reference says 2026-11. Plan to 2026-11-01.)_

### B. ⚠ §5.1's "no tenant-wide file access" is FALSE for this registration

§5.1 tells the operator to emphasise to IT: _"read-only, and scoped solely to
what is explicitly shared with the account. **No tenant-wide file access.**"_

**That is not true of app registration `2da92424-…`, and was not true when it was
written.** Decoding a client-credentials token for that app returns:

```
roles: ['Mail.ReadWrite', 'Files.Read.All', 'Mail.Send']
```

Application `Files.Read.All` — tenant-wide read of **every** drive with no
signed-in user — was granted 2026-07-09 for the ADR-0049 workbook bridge, whose
D6 says as much explicitly. ADR-0067 D5 reuses that same registration.

**The IT conversation therefore cannot honestly be framed as avoiding tenant-wide
access.** It must be framed as _which token each code path uses_. §5.1 is
corrected by this amendment; do not quote its original wording to anyone.

**Corollary that must not be lost:** `Sites.Selected` buys **zero** isolation on
this registration. Microsoft is explicit that a broader grant such as
`Files.Read.All` _overrides_ `Sites.Selected` restrictions. Achieving that
security story requires a **separate app registration**, which contradicts D5.
Nobody should propose `Sites.Selected` here as a security win.

### C. The live-document vision SURVIVES. What is lost is zero-touch discovery.

Every viable replacement returns a real `driveItem` in its home drive, keyed on
immutable `(driveId, itemId)` and re-read live each sweep. **Nothing degrades to
snapshots** except the email path, which is already labelled `ingest_source='email'`.

**The honest re-scope, in one line: _"share it and Vision finds it"_ becomes
_"share it and register it once."_** Bill's requirement — _"we will just share it
to the spec address from various users and owners"_ — **survives intact for
staff**: they still just share. The one-time registration lands on Bill or an
automation, never on the person sharing.

### D. Ranked replacement (supersedes the P1 `SharedItemSource` default)

1. **Shortcut / `remoteItem` enumeration — PRIMARY.** Staff share as today; a
   shortcut is materialized in `docs-dr3`'s own OneDrive; enumeration becomes
   `GET /users/docs-dr3@svdp.us/drive/root/children` filtered on the `remoteItem`
   facet. **This is not a new API — it is the same facet by a different route**
   (`sharedWithMe` items _always_ carried `remoteItem`). The `projectDriveItem`
   unwrap, `(drive_id,item_id)` keying, traversal, dedup and reconciliation are
   **unchanged** — precisely the swap the `SharedItemSource` seam exists for.
   Reads use the already-consented delegated `Files.Read.All`; automating
   shortcut creation needs delegated **`Files.ReadWrite`** (the signed-in
   account's OWN drive — **not** `.All`), so D3 survives literally: the write
   creates a pointer in Vision's own service-account drive.
   _Caveats:_ shortcuts are **folder-only**, pushing the product toward "share a
   folder"; and `onedrive-api-docs#1427` reports shortcuts missing from `/delta`
   on OneDrive for Business — **discover via `/root/children`, not `/delta`**,
   which is what the mandatory sweep already is.
2. **`/shares/{encodedSharingUrl}` redemption — COMPANION**, and the answer for
   single files. The sharing URL is a **registration token, never the read
   path**: resolve once, capture `(driveId,itemId)`, read normally forever after.
   ⚠ **Permission unverified** — the docs table lists `Files.ReadWrite` as
   least-privileged and omits `Files.Read.All`; must be tested live. Note
   `Prefer: redeemSharingLink` _grants durable access_ — treat it as a write.
3. **Group / Teams drive delta — the structural fix, and worth putting to Bill.**
   Add `docs-dr3` to specific Teams; enumerate `/me/memberOf` →
   `/groups/{id}/drive/root/delta`. **Discovery is permanently solved**, no
   deprecated API anywhere in the path, and the blast radius is _legible to IT_
   ("the service account is a member of these three Teams"). Cost: the document
   must live in a Team rather than personal OneDrive.
4. **Microsoft Search — cross-check only, never enumeration.** Relevance-ranked,
   capped, eventually-consistent, no delta, no completeness guarantee. **A missing
   document would be silent** — the exact failure class this ADR exists to
   eliminate. Safe only as a reconciliation pass that _raises_ an anomaly when it
   sees a source `doc_sources` doesn't know; it may add suspicion, never remove a
   source. **P1's refusal to ship a speculative Search implementation was correct
   and stands.**
5. **`/me/drive/following`** — one cheap call to settle; weak evidence it works on
   OneDrive for Business.
6. **Dedicated library + `Sites.Selected`** — re-evaluated honestly rather than
   deferred to D1. Still not primary: highest staff behavioural cost ("save your
   file _here_"), breaks liveness for files that live elsewhere, and per §B above
   buys no isolation on this registration.
7. **Email ingestion** — snapshot, already labelled, documented degradation path.

### E. Measure at first contact — do not assume

The moment Bill completes the Connect sign-in, run one pass covering:
does `sharedWithMe` still return anything **in this tenant** (how much runway is
actually left vs the 1-item mitigation)? · does `/shares` work with delegated
`Files.Read.All`? · do shortcuts appear in `/root/children` **and** `/delta` on
ODB? · does `/me/drive/following` return anything? Each is a single Graph call,
and together they convert this amendment from reasoning into measurement.

### F. Corrections to the research that produced this amendment

- The `docs-dr3@svdp.us` mailbox was reported as returning **HTTP 500**. Measured
  independently it returns **403** on `/mailFolders/inbox`, while
  `dr3-vision@svdp.us` returns 200 with the same token. A 403 with
  `Mail.ReadWrite` granted is the signature of an **ApplicationAccessPolicy**
  scoping the app's mail access to the AP mailbox — a control working as
  intended, **not** a defect. Email-based auto-registration would need that
  policy widened, which is a decision, not a repair.
- `docs-dr3`'s drive returns **200** (OneDrive provisioned — D10's concern is
  settled). `dr3-vision@svdp.us` returns **404** for its drive, confirming D1's
  reasoning that a shared mailbox has no drive identity.

## Amendment 4 — 2026-07-29 — the first real document, and four defects it exposed

TEREX.xlsx was the first document to pass through the live pipeline. It was
proposed **`unknown`, confidence 0.1**, with the reasoning _"the workbook is
completely empty — no sheets, no column headers, no row data, and no content
sample."_ The stored `parse_summary` for that same file, written 1.5 seconds
later, recorded **40 sheets and 2,117 data rows**.

Bill read this as a parser bug and asked for the parser to be fixed. It was not a
parser bug. `parse.ts` needed no change: the file was downloaded whole (490,671
bytes, sha256 matching Graph's declared size), parsed correctly, and the
classifier faithfully described the input it was handed. **The input was empty
because nothing had put anything in it yet.**

### A — Classification ran before the document was fetched

`sweep.ts` called `classifySourceIfNeeded` before `ingestSource`. But
`ingestSource` is what CREATES the `doc_source_version` row that holds
`parse_summary`, so on a source's _first_ sweep the classifier received
`summary: null`.

The justifying comment claimed the ordering served the guardrail's condition 4
("no longer parses as its registered classification"). That was wrong on its own
terms: `classifySourceIfNeeded` writes only `proposed_*`, while the guardrail
reads `source.doc_class` (`ingest.ts:217`), which only Bill's confirmation sets.
**The ordering bought nothing it claimed to buy, and cost a fabricated verdict on
every new document.**

Timestamps, from the live database, are unambiguous:

| Row                                           | `created_at` (UTC) |
| --------------------------------------------- | ------------------ |
| `doc_sources` (TEREX)                         | 16:14:02.815       |
| `doc_ingest_anomalies` — "completely empty"   | **16:14:10.310**   |
| `doc_source_versions` — 40 sheets, 2,117 rows | 16:14:11.817       |

The anomaly asserting emptiness was written **before the parsed content
existed**.

Fixed three ways, deliberately redundant because this class of defect is silent:
ingest now runs first; `classifySourceIfNeeded` **refuses** to classify a `file`
source that has no version row at all (folders, which never have one, are
unaffected); and the prompt renders the two states distinctly —
`Parsed content: NOT AVAILABLE` with an explicit instruction not to infer
emptiness, versus `Parsed content: AVAILABLE`.

**The general lesson, which is the reason this amendment is long:** a model asked
to judge nothing will confidently describe nothing, and that description is
indistinguishable from a finding. Rendering "not measured" and "measured as zero"
through the same template is how absence of evidence becomes evidence of absence
— the same failure shape as Amendment 2's filtered `grep`, one layer down.

### B — A stale anomaly outlived its own evidence

The second sweep re-classified correctly (`equipment_inventory`, 0.41). Nothing
resolved the `unclassified` anomaly, because `resolveAnomaly('unclassified', …)`
was only ever called from `confirmClassification` — which requires Bill to
confirm, which he will not do while the surface tells him the file is empty. So
`doc_sources` said `equipment_inventory` while an open anomaly said "completely
empty": **two operator surfaces disagreeing about the same document.**
`classifySourceIfNeeded` now resolves the anomaly when a later pass lands a real
kind.

### C — Re-classification was ungated

`classifySourceIfNeeded` re-ran on every sweep for every unconfirmed source: one
Claude call per document per 15 minutes (~96/day each), each silently
overwriting the previous proposal. Now gated — a proposal is stale only when a
version newer than `classification_attempted_at` has landed.

### D — P2 above is FALSE, and its recommendation was dangerous

**P2 and `SUBSCRIPTION_SCOPE_NOTE` claimed Microsoft requires delegated
`Files.ReadWrite.All` to create a `driveItem` subscription, and framed granting
it as a latency-vs-security trade for Bill to decide (C-44). That is wrong.**

[learn.microsoft.com/graph/api/subscription-post-subscriptions](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions)
lists, for `driveItem` on OneDrive for Business, delegated **`Files.Read.All`** —
with no higher-privileged alternative offered — and states: _"Due to security
restrictions, Microsoft Graph subscriptions don't support write access
permissions when only read access permissions are needed."_ **We already hold
exactly the documented permission.** `GET /subscriptions` returns 200, so the
token is accepted; the 403 is not a blanket scope rejection.

The real blocker is the **resource**. Same page: _"On OneDrive for Business, you
can subscribe to only the root folder… You can't subscribe to `drive` or
`driveItem` instances that aren't folders, such as individual files."_ The
service account reaches these documents through **item-level** shares — it has no
effective permission on any drive root, and a per-file subscription is not a
legal target. **There is nothing to subscribe to, at any permission level.**

This was almost worse than a silent failure: a defect that would have
recommended a permanent, tenant-wide **write** grant to fix something the grant
could not fix. It survived because two bugs cancelled — the scope-detection
regex `/403|forbidden|accessDenied/i` was tested against
`DocIngestAccessDeniedError.message`, which reads `"access denied for POST
/subscriptions"`: no status code, no "forbidden", and `accessDenied` ≠
`access denied` (the space defeats it). It could never match the one error it was
written for, so `scopeRelated` was always `false` and the wrong explanation was
never actually shown to anyone. Both are fixed: detection is by error **type**,
and the note now states the structural cause and explicitly warns **against** the
grant it used to recommend.

**C-44 is closed, not decided.** There is no decision to make. Push notifications
are unavailable for individually-shared files as a property of Graph, the delta
sweep is the mechanism rather than a fallback, and D4 holds by construction.

### E — The subscription table leaked a row every sweep

`ensureSubscriptions` looked for an existing row with
`state IN ('pending','active')`. A `failed` row matched nothing, so
`createSubscription` **inserted a fresh row** each cycle: 96 rows/drive/day,
unbounded. Worse, `sweep.ts` selects rows in `('pending','active','failed','expired')`
for the delta pass, so Graph call volume grew linearly with uptime. Found live
with 2 rows for one drive after 2 sweeps — of everything in this amendment, the
only defect that **degrades without bound**.

Now: one row per drive, always. A dead row is retried **into**, on exponential
backoff from one sweep interval to a day — so a permanent refusal costs one
Graph call a day instead of 96, and the day the share becomes a drive-root grant
push starts working with no code change and no operator action. `delta_link` is
preserved across retries (it is the sweep's cursor and is valid independently of
push). Orphan cleanup now covers `failed`/`expired` rows too, which previously
could not be reached at all.

### F — What is NOT fixed here

- **Discovery is still capped.** `sharedWithMe` returns 1 item in this tenant
  while at least 2 files are genuinely granted to `docs-dr3` (a Graph search
  surfaced `DR3 Machine List (2).xlsx`, an Outlook-attachment share that
  `sharedWithMe` does not index). Amendment 3's `remoteItem` shortcut route is
  measured **NO-GO**: `/me/drive/root/children` returns zero shortcuts, so
  switching to it would take discovery from 1 source to 0. Bill's constraint —
  _"I shared files not folders"_ — is the reason. The `/shares` operator
  registration path is the answer and is being built.
- **`owner_upn` is NULL on every source.** The `sharedWithMe` `remoteItem` facet
  carries `shared.sharedBy` but neither `shared.owner` nor `createdBy`, which are
  the only two fields `projectDriveItem` reads. A direct
  `GET /drives/{id}/items/{id}` does return the true owner. Until enrichment
  lands, P8's "owner left the org" inference is **inert** — it buckets by
  `owner_upn` and skips nulls.
- **`Sites.Read.All` is broader than this pipeline needs.** The service account
  can enumerate 11,403 driveItems across 42 SharePoint sites, including
  `NSStaff` (Night Shelter case-management files). That is materially wider than
  §5.1's "no tenant-wide access" and wider than Amendment 3's correction. It is
  not a bug — it is org-wide site membership — but it deserves an explicit
  decision rather than a default, and it is why Graph search must not become a
  discovery source (**C-47**).

## Amendment 5 — 2026-07-29 — discovery gets a second, operator-driven route

Amendment 3 concluded that discovery must be re-founded and proposed the
`remoteItem` "Add shortcut to My files" route as the replacement for the
deprecated `sharedWithMe`. **Measured live, that route is a NO-GO.** Read-only,
as `docs-dr3@svdp.us`:

| Route                         | Count                                                    |
| ----------------------------- | -------------------------------------------------------- |
| `/me/drive/sharedWithMe`      | **1** (no `nextLink`)                                    |
| `/me/drive/root/children`     | 1 — a real local folder, **zero `remoteItem` shortcuts** |
| `/me/drive/following`         | 0                                                        |
| `/me/drive/recent`            | 0                                                        |
| `/shares/u!{token}/driveItem` | **200**, with `createdBy`                                |

Switching primary discovery to `remoteItem` today would take discovery from one
source to **zero**. Bill's constraint is the reason and it is decisive: _"I shared
files not folders."_ Nobody has clicked "Add shortcut to My files", and there is
no reason they should have to.

`sharedWithMe` is nonetheless under-reporting. A Graph search surfaced
**`DR3 Machine List (2).xlsx`** in Bill's own OneDrive under `/Attachments/`,
readable by `docs-dr3` with `effectiveRoles: ["read"]` — a genuine per-user grant
that appears in **none** of the four enumeration routes above. It is an
Outlook-attachment share, which the shared-with-me index does not carry. So:
`sharedWithMe`-visible = 1, actually-granted ≥ 2, and the gap is not something a
different enumeration endpoint closes.

**Decision: keep `sharedWithMe` as the enumeration seam and add
`/shares/u!{base64url(webUrl)}/driveItem` as an OPERATOR-DRIVEN registration
path.** Bill pastes a document URL at `/admin/doc-ingest`; Vision resolves it to
`(driveId, itemId)` and creates the source through the **same `upsertSource`**
discovery uses, so classification, the confirm queue, the guardrail, the audit
trail and the kill switch all behave identically regardless of how a document
arrived. A second insertion path would be a second set of defaults to drift, and
that drift would surface only as a document that quietly never got classified.

Three properties worth stating because each was a decision, not a default:

- **It is READ-ONLY, enforced by an omission.** Microsoft's `/shares` docs
  describe `Prefer: redeemSharingLink`, which grants the caller **durable access**
  to the item — a permission change. It is never sent, and a test asserts no
  `Prefer` header goes out.
- **No scope widening.** The route runs on the `Files.Read.All` the integration
  already holds.
- **Four failures, four sentences.** A revoked share (403), a deleted file (404),
  a mistyped link (400) and a halted connection (503) need four different things
  from Bill. "Could not add the document" is true of all four and useful for none.

### `owner_upn` enrichment — and the erase that made it inert

`sharedWithMe`'s `remoteItem` facet carries `shared.sharedBy` but neither
`shared.owner` nor `createdBy`, which are the only fields `projectDriveItem`
read — so `owner_upn` was NULL on every source, and P8's "owner left the org"
inference (which buckets by owner and skips nulls) could never fire. A direct
`GET /drives/{driveId}/items/{itemId}` does return `createdBy`, so discovery now
spends one extra Graph call when a **file** first appears.

`createdBy` wins over `shared.owner` here — the departure alert names the author
— and `shared.sharedBy` is consulted at **no depth whatsoever**: the colleague
who forwarded a workbook is not its owner, and letting them stand in for one
would fire the alert on the wrong person's departure.

**The first version of this enrichment was inert, and every test of it passed.**
`upsertSource`'s update branch wrote `owner_upn: item.ownerUpn` unconditionally,
and that value is NULL for every source `sharedWithMe` returns — so the owner
resolved at creation was blanked on the next sweep, 15 minutes later, with no
trace. Sources predating the enrichment (TEREX.xlsx, live now) would also never
have been filled. A known owner is now only ever replaced by another **known**
owner, and a null one is backfilled. Both cases are pinned by regression tests;
the create-path tests that passed throughout are the reason this needed one.

## Amendment 6 — 2026-07-29 — the delta pass was silently freezing ingestion, and §D over-generalised

Written after an independent architecture review. Two of the three findings were
already live in production; one re-opens a route the previous amendment closed
too broadly. From this amendment on, every factual claim carries **[M]**
measured, **[D]** documented, or **[I]** inferred — see §D.

### A. The delta pass blanked the content marker, permanently stopping ingestion

**[D]** Microsoft documents that delta OMITS properties: _"Delta query won't
return some DriveItem properties… **OneDrive for Business** — Create/Modify:
**`ctag` omitted**. Delete: `ctag`, `name` omitted."_ —
https://learn.microsoft.com/en-us/graph/api/driveitem-delta

`applyDeltaItems` (`sweep.ts`) wrote `ctag: item.ctag` unconditionally, so every
delta pass wrote **NULL over a good marker**. `ingestSource` then hit
`if (!ctag) return { outcome: 'unchanged' }` — and `unchanged` is
indistinguishable from success.

**Net effect: after the first delta pass a document was NEVER INGESTED AGAIN,
while every sweep reported `status: ok`.** That is exactly the silent-staleness
class this ADR was written to eliminate (P3, ADR-0057 D9) — sitting inside the
mechanism built to prevent it.

**[M]** Confirmed on the live database 2026-07-29 18:13 UTC, before the fix:
`doc_sources` held `ctag = NULL, etag = NULL` for TEREX.xlsx, while its
`doc_source_versions` row held the real marker
`c:{58DD7F92-C24C-4AC6-B3A5-1584F4DAE23F},2977`. `delta_synced_at` confirmed the
delta pass had run. The only document in the system was already frozen.

Two independent fixes, because either alone would have left the class open:

1. **A delta page may SUPPLY a marker, never REMOVE one.** It is a change
   _signal_, not a source of truth about content markers.
2. **A missing marker RECOVERS or ALARMS — it never reports "nothing to do".**
   `ingestSource` now re-reads the item from Graph to recover the current ctag,
   and raises a `download_failed` anomaly if it cannot. The original reasoning
   ("no ctag means no idempotency key, so refuse") was correct as far as it went
   but chose the wrong failure direction: it returned the one outcome that looks
   like success.

The second fix matters more than the first. Fix 1 closes the known cause; fix 2
closes every future cause, because the condition can no longer be silent.

**A test had pinned the defect in place** — `ingest-d8.test.ts` asserted
`outcome === 'unchanged'` for a null ctag, encoding the silent stop as intended
behaviour. Replaced with the two tests that would have caught this.

### B. Amendment 4 §D over-generalised, and that hid a live route

§D concluded: _"There is nothing to subscribe to, at any permission level."_
**That is false as written.** The defensible statement is narrower: \*there is no
legal subscription target for **item-level shares in colleagues' personal
OneDrives\***. That narrower claim holds, and §D's correction of P2 stands —
**C-44 remains correctly closed.**

What the broad phrasing hid: **[D]** a SharePoint **`list`** is a subscribable
resource at `/sites/{site-id}/lists/{list-id}`, and the create-subscription
permissions table gives its delegated permission as **`Sites.Read.All`** —
https://learn.microsoft.com/en-us/graph/api/resources/change-notifications-api-overview
and https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions
(both verified by direct fetch, not recollection). **We already hold delegated
`Sites.Read.All`.** A document library is a list. So push notifications are
available **today, with no scope widening**, to any document that lives in a
library rather than a personal OneDrive.

**[D]** Separately, this independently re-kills the shortcut route: delta and
notifications do not traverse `remoteItem`. _"When using delta in a drive with
shared folders, the shared folders themselves will be returned… but the items
contained within a shared folder will not be returned."_ —
https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/using-sharing-links
A subscription on our own drive root would fire when a _shortcut_ is added, never
when a _document_ changes. Amendment 5's measured 1→0 NO-GO is now
over-determined. **Stop revisiting the shortcut route.**

### C. Confirmation gates INTERPRETATION, not intake — three surfaces said otherwise

**[M]** `doc_class` appears in `ingest.ts` exactly three times and gates no
admission: it selects which sentence a guardrail finding carries, fills the
advisory `detected_kind`, and rides in the audit payload. An unconfirmed source
is downloaded, hashed, archived to R2, versioned and applied identically to a
confirmed one.

Three shipped strings claimed otherwise — `messages.ts` (_"Nothing is ingested
from a document until you confirm what it is"_), `classification.ts` (in a live
anomaly Bill reads), and `SourcesClient.tsx` — **and a test asserted the false
string**, which is how it survived.

**The behaviour is right; the copy was wrong.** Capture-then-label is correct:
archiving evidence must not wait on a human, and the blast radius is contained —
an applied version lands in `file_drops` with `status: 'received'`, an operator
inbox, not a computed figure. All three strings now say what is true. This is the
same defect class as Amendment 4 §A's "completely empty": **a surface asserting a
state the system was not in.** An operator who catches one false assertion is
right to discount every assertion after it.

Also fixed: `classification_attempted_at` was stamped even when the Claude
fallback FAILED. Since §4C's staleness gate suppresses re-classification until
newer content lands, one transient timeout froze a proposal permanently on a weak
local guess. Only a completed attempt now counts as an attempt.

### D. Claim labelling is mandatory from here

Six of the errors recorded in Amendments 1–6 share one shape:

> **A conclusion was drawn from an instrument structurally incapable of producing
> the opposite result — then stated in the voice of a measurement.**

A filtered `grep` that excluded the file class by construction. A permissions
table recalled rather than fetched. A classifier handed `null` and asked whether
the document was empty. A discovery route recommended without ever counting what
it would return. Amendment 4 §A _named_ this pattern — and Amendment 5 and §B
above then repeated it. **Naming a failure mode does not prevent it; a required
field does.**

Three rules, effective now:

1. **Label every factual claim** `[M]` (what/when/which call), `[D]` (primary
   URL, quoted from a fetch, not recalled), or `[I]` (from what, and what would
   falsify it). **An unlabeled factual claim is a defect**, like an unlabeled
   timestamp. Under this rule the `Files.ReadWrite.All` error does not survive
   review, because the first question becomes _"where is the URL?"_ rather than
   _"does this sound right?"_
2. **No absence claim without a negative control** — one check that would have
   found the thing if it were there.
3. **No discovery-architecture change without "today N sources, after this
   change M."** If M is unknown, the recommendation is not ready. This one line
   would have stopped Amendment 3 §D before it reached Bill.

Note that rule 2 restates a convention already codified fleet-wide (_trace the
error string to its source; don't pattern-match a keyword to a plausible
subsystem_) — which was written down and still did not fire. Prose guidance is
invisible at the moment a claim is written; a required field is not.

### E. Open, not fixed here

- **Discovery under-reports RIGHT NOW** — `sharedWithMe` returns 1 while ≥2
  documents are granted, and no surface compares reachable-vs-watched. This
  outranks the November 2026 sunset, which is at least loud and dated.
- **A dedicated SharePoint library is the recommended primary discovery route**
  (complete `delta` enumeration, no deprecated API, push per §B, zero new
  grants). Amendment 3 §D6 ranked it 6th partly on _"breaks liveness for files
  that live elsewhere"_ — **[I]** that conflated **move** with **copy**; a moved
  file still has one home and is still read live, so D1's premise is intact.
  Blocked on an organisational decision, not a technical one.
- **[D]** The `/shares` permission table lists delegated `Files.ReadWrite` /
  `Files.ReadWrite.All` / `Sites.ReadWrite.All` and does **not** list
  `Files.Read.All` — https://learn.microsoft.com/en-us/graph/api/shares-get —
  while **[M]** it returns 200 for us on `Files.Read.All`. Our newest discovery
  route runs on undocumented behaviour and our other on a deprecated API. Both
  are dated, from different clocks. Recorded against C-43.
- **The owner backfill has no failure latch** and the notification path takes no
  lock (a batch of N drives runs N concurrent full discoveries). Neither is
  load-bearing at current volume; both scale badly.

---

## Amendment 7 — 2026-07-30 — the pipeline CAPTURES but does not ABSORB

Full audit: `docs/2026-07-30-document-ingestion-absorption-audit.md` (evidence, live
inventory, per-kind table, value-ranked gaps). Recorded here because three of its
findings falsify claims made in this ADR and in the code it describes.

**Verdict.** No parsed value from any ingested document reaches a queryable Vision
table, report, dashboard tile, or comparison against Vision's own numbers.
`applyVersion` terminates at one `file_drops` row with `status: 'received'`. **[M]**
Live at 2026-07-30 00:30 PDT: 3 sources, 0 confirmed, 4 versions, 4 applied, 0
staged, 4 `shared_file` drops — all `detected_kind` NULL. **[M]** Negative control:
`grep -rn "parse_summary|parseSummary|summaryFromJson" src` matches 9 files, all
under `src/lib/doc-ingest/`; the same method surfaced the genuine `health.ts` and
`sweep.ts` readers, so an external consumer would have appeared.

### A. `parse.ts`'s header claim is FALSIFIED, 3 of 3

`parse.ts:237-245` justifies first-non-empty-row-as-header as _"correct for every
workbook this pipeline has seen"_. **[M]** All three live workbooks open with a
merged title row, so `headers[]` holds `["Woodland Trailer List 2025"]`,
`["TEREX MACHINE MAINTENANCE LOG"]`, `["2026", "Commodity Audit (against Vendor
Invoices)  WOODLAND"]`. Real column names sit on row 2+ and are never recorded.

The stated degradation ("odd-looking column names, compared consistently") is also
understated. **[I]** Two mechanisms are disabled: the classifier's `structure` rules
can never match (they look for `serial`/`make`/`model`/`inbound`/`units`), so
classification is filename-only; and D7 condition 1 has **zero** monitored columns,
because no recorded header matches `guardrail.ts:63`'s `AGGREGATE_COLUMN`. Falsified
by any live source whose `headers[]` holds a genuine column name — none does.

**[M]** Consequence for trust: all four versions auto-applied with a clean guardrail
verdict. That is not evidence the changes were safe; it is evidence there was
nothing to compare. Until the header defect is fixed, a clean verdict should read
"not assessed".

### B. The stored artefact holds no usable numbers

**[M]** `Woodland Data Auditing Tracker (1).xlsx` — a commodity-audit-against-vendor-
invoices workbook, the highest reconciliation value of the three — stores
`numericTotals: {}` on **both** sheets. `Woodland Trailer list.xlsx` stores one
aggregate, `23062327`, across 118 trailers; **[I]** a sum of identifiers, falsified
by finding a real 23-million-unit column. `textSample` for a workbook is built from
sheet names and headers only (`parse.ts:266`) — **[D]** no cell value ever enters it.
`parse_summary` is a guardrail input, not a data layer; **[I]** any real absorption
must re-read the R2 bytes.

### C. "§3.6 document elimination backlog" is not in this ADR

**[M]** `grep -rniE "elimination|system of record|takes? (this )?over"` over this file
→ zero matches; `grep -rniE "document elimination"` over `docs/` → zero matches
anywhere. **[I]** It plausibly lives in the external Phase 3 directive this ADR cites
for `§3.3`/`§3.5`; falsified by producing that text. Either way: **no phased backlog,
no per-document retirement criterion, and no acceptance test for "Vision has taken
this over" exists in this repo.** Aspiration, not plan.

### D. ADR-0049 already implements the absorption — and has never run

**[D]** `src/lib/workbook-sync/engine.ts` parses a daily-log workbook with the shared
ADR-0039/0048 `parseWorkbook`, upserts `processed_units_daily`, audits every
Vision-overwrite, and NO-OPs after cutover. That is "absorbed as a reference point
until Vision takes over", already built. **[M]** `workbook_sources` = 1 row
(Woodland, `{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm`), `is_syncing = false`,
`last_polled_at` NULL, `workbook_sync_runs` = **0**.

**[I]** Two pipelines now watch Microsoft files with no code path between them
(negative control: zero references to `parseWorkbook` / `upsertDailyProduction` /
`parseDailyRows` / `processed_units_daily` anywhere under `src/lib/doc-ingest/`).
**[M]** And no daily-log workbook has been shared with `docs-dr3@svdp.us` at all —
the pattern matches none of the three live documents.

### E. Visibility gaps, distinct from absorption

- **[M][D]** `listDocSources()` does not select `parse_summary`; only `listAnomalies()`
  exposes it, only for `staged` versions, and `staged = 0`. It is on **zero** screens.
- **[M][D]** The confirm queue is unreachable by clicking. `src/app/admin/page.tsx:91`
  is the only doc-ingest tile and targets `/admin/doc-ingest/connect`, whose only
  `href` is `/admin` (`connect/page.tsx:63`). Negative control:
  `grep -rn 'href="/admin/doc-ingest"' src --include=*.tsx` → 2 hits, both inside the
  doc-ingest subtree. Three documents have waited ~15 h; nothing counts them down.
- **[M][D]** `confirmClassification` does not backfill `file_drops.detected_kind`, so
  the four inbox rows stay kind-less permanently.

### F. The taxonomy is already too narrow — with live proof

**[M]** Claude declined to force-fit the commodity-audit tracker into any `DOC_KIND`
and proposed `unknown` at 0.50. `unknown` is excluded from `CONFIRMABLE_KINDS`
(`sources/route.ts`), so the source is stuck with an open `unclassified` anomaly and
no path forward. A `commodity_audit` kind is warranted, and `unknown` needs a
confirmable archive-only terminal state so a document can be triaged rather than
left ringing.

### G. What is NOT changed here

This amendment records findings only; no code changed. Fix order, by operational
value: **(1)** header-row detection — extraction built on a mis-headered sheet
produces confidently wrong reference numbers, so this precedes everything;
**(2)** a `doc_class` → extractor dispatch at apply time, landing in a reference
table separate from operational tables; **(3)** a spreadsheet-vs-Vision
reconciliation view per site/period — without it, nothing can ever say Vision has
taken over; **(4)** the visibility fixes in §E, which are a dashboard tile and not a
notification under ADR-0037's 5-minute-actionability gate.
