# Incident — MyMRC scrape login failure, 2026-08-18

**Status:** Diagnosed (support role). Classification section reserved for the incident lead.
**Severity:** Low — no data loss, no missed hourly cycle beyond the boot slot.
**All times Pacific (PDT, UTC−7).** Container clocks and `mymrc_sync_runs` are UTC; every
timestamp below has been converted.

---

## 1. One-line

A deploy recreated the whole DR3-Vision stack at 3:50:46 PM. The mymrc-scrape **boot
scrape** — which fires 5 seconds after container start — failed. The next hourly cycle,
9 minutes later, ran clean end-to-end on the same stored credential. The credential was
never the problem.

---

## 2. Timeline

| Time (PT)                | Event                                                                                                                                                                         | Source                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 3:38:20 PM               | PR #271 (ADR-0110) merged to `main` — commit `480e61d`                                                                                                                        | `git log`              |
| 3:49:40 PM               | Deployer builds `dr3-vision-app:local`                                                                                                                                        | `docker image inspect` |
| 3:50:43 PM               | `dr3-vision-migrate` starts; ~20 DR3 containers recreated 3:50:43–3:51:00 PM                                                                                                  | `docker inspect`       |
| 3:50:46.97 PM            | **`dr3-vision-mymrc-scrape` created** (`RestartCount: 0` — new container; prior container's `docker logs` history destroyed)                                                  | `docker inspect`       |
| 3:50:47.78 PM            | `cron host started`                                                                                                                                                           | container log          |
| 3:50:52.79 PM            | Boot scrape spawned (`BOOT_DELAY_MS = 5_000`); `next scrape in 547s`                                                                                                          | container log          |
| 3:50:57.90 PM            | `persisted session logged-out — discarding it, fresh login (admin)`                                                                                                           | container log          |
| 3:51:05.23 PM            | `login submitted (admin)`                                                                                                                                                     | container log          |
| **3:51:08.37 PM**        | **`admin session start failed: mymrc: still logged out after fresh login (admin)`** → `purgeState()`, exit 1                                                                  | container log          |
| 4:00:00.10 PM            | Top-of-hour scrape spawned                                                                                                                                                    | container log          |
| 4:00:20.27 PM            | `login submitted (admin)`                                                                                                                                                     | container log          |
| **4:00:23 – 4:01:39 PM** | **Full clean run.** hauls 17/2, haulsCompleted 800/1, processed 800/0, outbound 800/0; mirror freshness green (hauls 08-18, processed/outbound 08-17); `scrape exit code 0`   | container log + ledger |
| 4:31:32 PM               | `received SIGTERM, exiting` — incident lead stops the container                                                                                                               | container log          |
| 4:38:14 PM               | Container restarted by incident lead                                                                                                                                          | `docker inspect`       |
| 4:38:21 PM               | Boot scrape spawned; `next scrape in 1299s`                                                                                                                                   | container log          |
| **4:38:24 PM**           | **`fatal: browserType.launch: Target page, context or browser has been closed`** — `chrome-headless-shell` took **SIGSEGV (signal 11, SI_KERNEL)** ~2 s after container start | container log          |
| 5:00 PM                  | Next top-of-hour cycle — expected clean (see §6)                                                                                                                              | prediction             |

**The boot slot failed twice, with two different symptoms. Every top-of-hour cycle passed.**

---

## 3. Confirmed evidence

### 3.1 The run ledger has recorded no auth failure in 27 days

`mymrc_sync_runs`, full-table census, times converted to Pacific:

| status            | rows  | most recent (PT)       |
| ----------------- | ----- | ---------------------- |
| `ok`              | 2,563 | **2026-08-18 4:01 PM** |
| `stale_mirror`    | 74    | 2026-08-17 7:00 AM     |
| `error`           | 18    | 2026-08-13 11:01 PM    |
| `contract_drift`  | 9     | 2026-08-10 2:16 PM     |
| **`auth_failed`** | **3** | **2026-07-22 8:57 AM** |

The last `auth_failed` row predates the ADR-0057 Phase 1 self-heal ship. Nothing today.

Every non-`ok` row since 2026-07-22 is one of exactly two families:
`page.waitForTimeout: Target page, context or browser has been closed` (the ADR-0103
page-cache class) and `getItems: response body was not JSON` (contract drift). **No
credential-rejection row exists in the entire ledger since the credential was stored.**

### 3.2 The 8/12 and 8/13 alerts were page-cache, not auth — verified

Ledger rows: `08-12 00:01 outbound error` and `08-13 23:01 outbound error`, both
`page.waitForTimeout: … has been closed`. Both are `status='error'`, fingerprint
`mymrc-error:woodland:outbound` — **not** `auth_failed` / `mymrc-auth-failed:woodland`,
which is a separate `AlertKind` with a separate title and click target. ADR-0103 records
the 8/13 log line `mid-run re-auth recovered on attempt 1/3 (admin)` firing **one second
before** the failure — direct proof the credential was valid at that moment. Claim holds.

### 3.3 The boot-scrape failure writes no ledger row

`scripts/mymrc-scrape.mjs` pages and exits 1 on admin-session-start failure **before**
any per-feed `mymrc_sync_runs` row is opened. Consequence: **the run ledger read 100%
green straight through this outage.** Any dashboard or dead-man built on
`mymrc_sync_runs.status` is structurally blind to the entire admin-auth failure class.

### 3.4 Egress path is stable and IPv4

Scraper host public egress: **216.115.11.18** (IPv4). The host holds no global IPv6
address (`fdcb::/8` ULA + link-local only) and IPv6 egress returns nothing, so the portal
is reached over IPv4 only. Host uptime 17 days. One `eth0: Lost carrier` /
`DHCPv6 lease lost` / `Gained carrier` flap at **12:11:56 AM PT today** — the only network
event in 7 days. It is IPv6-only and 3h39m before the first failing cycle, and eleven
clean hourly scrapes ran after it. Not causal, but worth recording as the one candidate
for a public-IP rotation if the upstream NAT re-leased at the same moment.

### 3.5 Resource envelope at the time of the segfault

Container: `Memory=1 GiB`, `MemorySwap=2 GiB`, `PidsLimit=256`, `ShmSize=64 MiB`.
Host: 83 GB total, **69 GB available**, load 4–5, **zero OOM kills in `dmesg`**. The
Chromium crash was SIGSEGV, not SIGKILL — so it is not a cgroup OOM. The common factor
with the 3:51 PM failure is the _slot_, not the resource: both fired ≈5 s after container
create, while ~20 sibling containers were still coming up.

---

## 4. Premises checked and falsified

| Premise as reported                       | Verdict                          | Evidence                                                                                                  |
| ----------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "Fails login every cycle since ≥3:50 PM"  | **False**                        | Exactly one failing cycle (3:50 PM boot). The 4:00 PM cycle succeeded fully.                              |
| "Last clean scrape was 12:34 AM PT today" | **False**                        | Clean hourly runs 2:00 AM → 4:01 PM PT today, plus off-hour runs at 2:50 PM and 3:12 PM.                  |
| Credential rejected / password expiry     | **Excluded**                     | The 4:00 PM cycle authenticated on the _same_ stored credential. Also arithmetically impossible — see §5. |
| Lockout                                   | **Excluded**                     | Same — a lockout does not clear itself in 9 minutes and then survive 4 more logins.                       |
| Login-flow change / selector drift        | **Excluded**                     | The 4:00 PM login used the identical `SELECTOR_VERSION = '2026-07-22'` code path and succeeded.           |
| Salesforce seasonal release               | **Excluded**                     | Nothing shipped on 8/18 — see §5.                                                                         |
| **Post-login-probe false negative**       | **Consistent with all evidence** | See §7.                                                                                                   |

⚠️ **Timezone trap, recorded for the next reader.** `mymrc_sync_runs.started_at` is
`timestamp without time zone` (Prisma default) holding UTC. Writing
`started_at AT TIME ZONE 'America/Los_Angeles'` converts in the **wrong direction** —
it reads the naive value as Pacific and _adds_ 7 hours, producing timestamps in the
future. The correct form is
`started_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles'`. The first pass of
this investigation printed run times of "08-19 06:01" for a run that actually happened
at 4:01 PM on 08-18. Same class as ADR-0104's "the dates were UTC not Pacific."

---

## 5. External intel

_Sources tier-1 where marked; all verified 2026-08-18._

**No Salesforce release landed on or near 2026-08-18.** Winter '27: pre-release org
access **2026-08-13**, release notes **2026-08-19**, sandbox preview **2026-08-28**,
production upgrade weekends **2026-08-29, 2026-10-03, 2026-10-10**. Summer '26 (the
release currently in production) reached production 2026-05-15 through 2026-06-13. There
is no production login/aura change dated 2026-08-18. _(Salesforce Ben, ENWAY, Maintask —
tier 2/3; salesforce.com/products/innovation/releases returned 403 to automated fetch,
so this is not tier-1 confirmed. Worth a manual check of Trust for the specific instance
if the classification ever turns on it.)_

**Password expiry is arithmetically excluded.** Salesforce "User passwords expire in"
accepts only 30 / 60 / 90 / 180 / 365 days or Never; the org default is 90. The credential
was stored 2026-07-22 — 27 days ago. No configurable value fires at 27 days; the nearest,
30 days, lands 2026-08-21. _(Salesforce Help, "Password Policy Fields in Profiles".)_
Caveat for the record: the _stored_ date is not the _set_ date. If MRC set this password
in mid-May (the portal was first verified 2026-05-06), a 90-day policy would land near
2026-08-18. That coincidence is worth knowing about — but it is moot here, because the
4:00 PM cycle authenticated successfully.

**Device Activation is the live risk this account carries, even though it did not fire
today.** Salesforce challenges logins from an unrecognized browser/device/IP with an
emailed verification code, and is extending Device Activation to **all users who do not
authenticate with MFA or SSO**. ADR-0057 D5 records "No MFA on Bill's account, so plain
Playwright login works" — so this account is squarely in the population that gets device
activation. External (Experience Cloud customer/partner) users are the group for whom
email-based verification is available. Device recognition is cookie-borne and is lost on
"new device, cleared cache, or updated IP range."

That last clause matters structurally: **the scraper deliberately clears its cookies on
every heal.** `rebuildAndLogin()` calls `newSessionContext(false)` — a fresh context with
no persisted seed — and `purgeState()` deletes `auth.json` outright on failure. So every
failed cycle destroys the device-activation cookie, which would make the _next_ cycle
challenge again. If Device Activation ever does switch on for this org, the current
design converts it from a one-time prompt into a permanent outage. Mitigations admins use:
**Login IP Ranges** on the profile, or the profile permission **"Skip identity confirmation
at login from an IP address within the Login IP Range"**. The scraper's egress
(216.115.11.18) is stable and would be a clean single-entry range.

_Sources: [Salesforce Help — Password Policy Fields in Profiles](https://help.salesforce.com/s/articleView?language=en_US&id=platform.users_profiles_password_policies_ref.htm&type=5), [Salesforce Help — Changes to Device Activation for SSO Logins](https://help.salesforce.com/s/articleView?language=en_US&id=005237070&type=1), [Salesforce Ben — Winter '27 Release Date + Preview](https://www.salesforceben.com/salesforce-winter-27-release-date-preview-information/), [Salesforce Ben — Mandatory MFA Changes in 2026](https://www.salesforceben.com/how-to-prepare-for-salesforces-mandatory-mfa-changes-in-2026/)._

---

## 6. How login works, and what can make the probe lie

_(Code brief — `src/lib/mymrc/portal-client.ts`, `selectors.ts`. This is the half-page
for the incident record.)_

The portal is **Salesforce Experience Cloud** at `https://mrc-us.my.site.com` (fronted by
Cloudflare). One admin identity serves both sites; tenancy is decided by the data, not the
login (ADR-0057 D1).

**The flow.** `openAdminSession()` → `bootstrap()` navigates to `AUTHED_HOME_URL` (`/s/`)
with `waitUntil: 'domcontentloaded'` and calls `isLoginPage()`. If that reads logged-out,
it logs `persisted session logged-out — discarding it, fresh login (admin)` and calls
`rebuildAndLogin()`: tear down the context, build a clean one with **no persisted seed**,
`login()`, re-navigate to `/s/` (again `domcontentloaded`), re-probe. If it still reads
logged-out → `purgeState()` + `AuthFailedError('still logged out after fresh login (admin)')`.

**`login()` fills by placeholder and clicks by role** — the Lightning form has no `name`
attributes and dynamic numeric ids, so placeholder text is the only stable hook
(`SELECTOR_VERSION = '2026-07-22'`). It then waits a fixed 3 s and logs
`login submitted (admin)` **unconditionally**.

**What the probe actually tests.** `looksLoggedOut()` is a _positive-marker_ test on the
rendered HTML, hardened 2026-07-22 because the old check let the `/s/home` 404 shell pass
as authenticated. It returns logged-**in** only when the HTML contains
`Switch Account`, or `viewing as DR3`, or **≥2 of the object-nav hrefs** — and contains no
visible login control. It is not a cookie check, not a status-code check, not a URL check
alone. Everything unrecognized falls through to "logged out" by design.

**Four ways the probe can lie — all false negatives:**

1. **Aura hasn't rendered yet.** The verify navigation uses `domcontentloaded`, and there
   is **no settle wait and no `waitForSelector`** between the `goto` and the probe. On a
   Lightning SPA, `/s/` at DOMContentLoaded is an empty shell — the Switch-Account banner
   and the nav are painted by Aura afterwards. A slow render therefore yields zero markers
   and reads as logged-out. This is the deliberate tradeoff of the 2026-07-22 hardening:
   closing the false-positive turned every slow render into a false negative.
2. **`login submitted (admin)` is not evidence of anything.** It is logged unconditionally
   after a fixed 3 s wait. The `waitForLoadState('networkidle')` that runs alongside the
   click is wrapped in `.catch(() => undefined)`, so a timeout is invisible, and because it
   races the click it can resolve on the _pre_-click idle state. The line proves the code
   reached that statement — not that a form was submitted or accepted. Timing bears this
   out: the failing cycle spent 4.3 s between context-rebuild and the submit log; the
   succeeding cycle spent 9.5 s.
3. **`gotoWithRetry` never throws.** A navigation that never resolves leaves the page on
   its prior or blank URL — which the probe reads as logged-out. A network or Cloudflare
   stall is indistinguishable from a rejected credential at this layer.
4. **Any unrecognized page reads as logged out** — including an interstitial. A Salesforce
   device-activation "Verify Your Identity" page or a Cloudflare challenge would produce
   exactly the observed message, because neither carries an auth marker. The scraper's
   user-agent advertises `DR3VisionScraper/1.0`, which is a plausible challenge trigger.

**Net:** `still logged out after fresh login (admin)` means _"no authenticated marker was
visible in the HTML at the instant we looked."_ It does **not** mean the credential was
rejected. Distinguishing the two requires the post-submit page capture the incident lead
is taking — which is the right instrument.

---

## 7. Classification — RESERVED FOR THE INCIDENT LEAD

> The Aegis incident lead owns this section. Populate from the captured post-submit page.
>
> - [ ] credential-rejected
> - [ ] login-flow-change
> - [ ] lockout / device-activation challenge
> - [ ] post-login-probe false negative
>
> **Lead's finding:**
>
> _(pending)_
>
> **Supporting evidence from the capture:**
>
> _(pending)_

**Support-role read, offered as input, not as the classification.** Every piece of
evidence available without the capture points at **post-login-probe false negative during
container cold start**: the same credential authenticated 9 minutes later and four times
since; the ledger holds no `auth_failed` row in 27 days; the failure recurred on the
_next_ container start with a completely different symptom (Chromium SIGSEGV) in the same
5-second boot slot. The common factor is the boot slot, not the credential.

**Falsifiable prediction:** the 5:00 PM top-of-hour cycle completes clean without
intervention. If it does not, this read is wrong and the capture should be trusted over it.

---

## 8. Prevention candidates

**P1 — The boot scrape fires too early (root cause candidate).**
`scripts/mymrc-cron.mjs` uses `BOOT_DELAY_MS = 5_000`, commented "so postgres healthcheck
likely settled." Five seconds is not enough when a deploy recreates ~20 containers at
once. Both observed failures are in this slot. Options: raise the boot delay; gate the boot
scrape on the app healthcheck rather than a fixed sleep; or retry the boot scrape once
after a backoff instead of exiting 1. Lowest-risk first step: raise the delay and confirm
the failure stops recurring across the next few deploys.

**P2 — The run ledger cannot see this failure class (observability gap).**
An admin-session-start failure exits before any `mymrc_sync_runs` row is written, so the
ledger stayed 100% green through the outage (§3.3). Any dead-man over
`mymrc_sync_runs.status` is structurally blind here. Fix: write a ledger row for
admin-session-start failure — `feed='__session__'`, `status='auth_failed'` — so the run
ledger is complete and the existing dead-man covers it.

**P3 — Re-grade the alert against ADR-0037.**
The `auth_failed` path pages at priority `high`, topic `dr3-vision-system`, fingerprint
`mymrc-auth-failed:admin`, click → `/admin/mrc-scrape`. Crucially, the worker-entry alerts
in `mymrc-scrape.mjs` call `ntfyPager.page()` **directly**, bypassing the `decidePage()`
cross-tick guard in `sync.ts` (leading-edge + 6 h re-page). The in-process 30-minute
cooldown is a module-scope `Map` in a process that is spawned fresh every tick, so it
dedups nothing across ticks. Result: a sustained auth failure pages **once per hour,
indefinitely**. Against the 5-question gate this fails Q3 (_has the system tried to
self-heal first?_) — today's failure self-healed on the very next tick, and the page fired
before that could be observed. Candidate: suppress the first boot-scrape auth failure and
page only if the following top-of-hour cycle also fails. _Verify what actually reached ntfy
at 3:51 PM before acting — that check is still outstanding._

**P4 — Credential-age surface.**
Nothing today surfaces how old the stored MyMRC credential is. Since this is Bill's
personal login with no fallback by design (ADR-0057 D5/D8), a rotation on his side breaks
ingestion with no warning. Candidate: show "credential stored N days ago" on
`/admin/mrc-scrape`, and page at a threshold well inside any plausible expiry.

**P5 — Pre-empt Device Activation.**
Not today's cause, but the account is in the population Salesforce is moving to mandatory
Device Activation (§5), and the current design (`purgeState()` + seedless context rebuild)
would turn a one-time challenge into a permanent outage. Candidate: ask MRC to add
216.115.11.18 as a Login IP Range on the profile, with "Skip identity confirmation at
login from an IP address within the Login IP Range" enabled. Cheap now, expensive later.

**P6 — Investigate the Chromium launch SIGSEGV.**
`chrome-headless-shell` took signal 11 at launch at 4:38:24 PM. Not an OOM (no kills, 69 GB
free, SIGSEGV not SIGKILL). Worth watching: if it recurs only in the boot slot, P1 covers
it; if it recurs at top-of-hour, it is a separate defect. Note `--enable-unsafe-swiftshader`
is in the launch flags.

---

## 9. Open items for the lead

1. Confirm the 5:00 PM cycle result (the §7 prediction).
2. Confirm what actually reached ntfy at 3:51 PM — topic, priority, whether it deduped.
3. Land the classification in §7 from the post-submit capture.
4. Decide P1 and P2; they are independent of the classification and worth doing regardless.
