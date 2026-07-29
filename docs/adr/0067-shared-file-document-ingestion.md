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
