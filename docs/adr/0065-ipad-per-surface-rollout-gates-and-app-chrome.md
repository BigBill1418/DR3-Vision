# ADR-0065: Per-surface iPad rollout gates, current-day-only floor scoping, and two app chromes

**Date:** 2026-07-28
**Status:** Accepted
**Supplements:** ADR-0047 (staff-output rollout gate), ADR-0060 (iPad floor surfaces), ADR-0008/0014 (brand + surface palettes), ADR-0061 (floor i18n)
**Partially supersedes:** [ADR-0064](0064-always-visible-back-bar.md) (back-only manager bar)

> **Numbering note.** `0063` and `0064` were both claimed by in-flight work
> (`0063` is cited by `src/lib/admin-equipment.ts` on a concurrent branch; the
> `0064` file was missing and is backfilled alongside this one). This ADR takes
> `0065` to avoid a collision.

## Context

Bill starts using the iPad on the floor on **2026-07-28**. Three things blocked
that.

**1. Rollout gating was all-or-nothing.** Every iPad floor surface read ONE
rollout code, `loads_inventory`. That same code also gates the manager desktop
(`/dashboard/[site]/loads-inventory`, `/dashboard/[site]/processed-units-close`)
and every loads/inventory write via `assertLoadsInventoryActivated`. It is
`live` at both sites. So there was no way to turn off a single iPad screen: the
only lever available would have dropped the managers' tabs too.

**2. The queue showed the entire future, on the wrong day boundary.** The queue
filtered `expected_arrival_at: { gte: startOfToday }` with **no upper bound** —
every future load was on it. On 2026-07-28 that was **14 rows where 1 was
actionable** (1 today; 13 spread across 07-29 → 08-07).

Worse, `startOfToday` came from `new Date(); d.setHours(0,0,0,0)` — **server
local** midnight. The container runs UTC with no `TZ` set (`docker exec
dr3-vision-app date` → UTC), while both sites are Pacific (Woodland CA / Eugene
OR). From **5:00 PM Pacific onward, UTC has already rolled to the next day**, so
an evening-shift operator's queue would silently switch to the WRONG DAY
mid-shift — hiding the loads they were working and showing tomorrow's. This is a
live correctness defect independent of any scoping request, and it would have
misfiled evening loads.

The repo already had the correct primitives (`pacificDayISO`,
`pacificDayStartInstant`, `pacificMidnightInstantOfDayISO`), and
`floor-inbound.ts`, `bulk-inbound.ts`, `onHand` and the MyMRC bridge all key on
Pacific midnight. **The queue was the odd one out.**

**3. Navigation was inconsistent and, in one place, absent.** Sign-out existed
on 2 of the 9 operator screens; `/operator/[site]/load/[id]` — a 7-stage
workflow — had **no back and no sign-out at all**, so its only exits were submit
and reject. On the manager side the ADR-0064 bar gave every page a way home but
**no page had any sign-out control**: a manager's only way out was clearing
cookies. A fixed locale switcher overlapped page content on two operator
screens, and the operator header markup had three incompatible shapes.

## Decision

### D1 — One rollout surface per iPad screen

Five new `kind='ui'` codes, each read by exactly the screen and the write path
it governs:

> **See [Amendment 1](#amendment-1--verification-pass-2026-07-30) (2026-07-30).**
> The `/queue` and `/load/[id]` rows of this table described intent, not shipped
> code — only the server actions and the hub card read `ipad_queue`. Both pages now
> read it. Amendment 1 also records why `ipad_queue` at `live` is correct rather
> than drift against Bill's "disable all except inbound haul processing."

| Code                 | Governs                                           | Seeded  |
| -------------------- | ------------------------------------------------- | ------- |
| `ipad_queue`         | `/queue` + `/load/[id]` + the dock server actions | `live`  |
| `ipad_inbound`       | `/inbound` (F-2) + its API                        | `live`  |
| `ipad_count`         | `/count` (F-3) + its API                          | `pilot` |
| `ipad_processed`     | `/processed` (F-4) + its API                      | `pilot` |
| `ipad_today_summary` | the F-1 on-hand block inside the hub              | `pilot` |

The manager desktop continues to read `loads_inventory`, so an iPad flip cannot
touch it. Re-enabling is `/admin/rollout` → flip the row → save. No deploy.

### D2 — Seeding `ipad_queue` / `ipad_inbound` as `live` is a deliberate ADR-0047 deviation

ADR-0047 decision #3 says new surfaces are **born pilot**. These two are seeded
`live`, and the reason is that born-pilot protects **new exposure**; it is not a
mandate to take a **working** surface down. These gates are being _retrofitted
over already-live functionality_ — `loads_inventory` is `live` at both sites, so
the truck queue and inbound confirm are in operators' hands right now. Seeding
their new gates `pilot` would be an unannounced regression of working
functionality on the next deploy: the opposite of the safety ADR-0047 exists to
provide. The three surfaces Bill asked to turn OFF are seeded `pilot`, which is
simultaneously his decision and the ADR-0047 default.

### D3 — The hub is never gated

Bill: _"leave the site picker do not strand anyone."_ PIN success routes to
`/operator/[site]/today`, so gating the hub would drop a successfully
authenticated operator onto a dead screen. What is gated is its **content**: the
F-1 summary block and each card. Every card is now gated, **including the truck
queue card**, which was previously hardcoded un-gated — an operator must never
see a card whose destination will refuse them. If every surface is off, the hub
still renders its heading, an explanation, and the chrome's Log Out.

### D4 — Gate the WRITES, not just the pages

`requireActivatedOperator(siteCode, surfaceCode)` now takes an explicit surface
code with **no default**, so a caller cannot silently re-couple to the master
gate. Critically, `src/app/operator/[site]/actions.ts` — the dock workflow
server actions — had **no rollout gate at all**. They write `inbound_loads`,
which feeds `onHand` and billing, so hiding the queue card while leaving the
actions open would have been a money-safety hole: a bookmarked
`/operator/<site>/load/<id>` could still drive them. `ctx()` now asserts
`ipad_queue`.

### D5 — The floor is CURRENT-PACIFIC-DAY ONLY

Bill: _"vision on the ipad is only going to show hauls from the current day … no
historical or future views."_

- New `currentPacificDayWindow()` in `@/lib/time` returns the half-open
  `[start, endExclusive)` instant window for the current Pacific day, built from
  the same `pacificDayStartInstant` the billing paths use. **No second day-key
  definition is introduced.**
- The queue is bounded by it. The per-row date badge is deleted — every row is
  today by construction.
- `/inbound` and its API list **1 day**, not 14. The hub's badge counted a
  14-day lookback (exactly the historical view being ruled out) and is now
  scoped to today. Both `listFloorInboundDays` and `countUnconfirmedInboundDays`
  also gained an **upper** bound at the next Pacific midnight — they previously
  had only a window start, so a future-dated row would have rendered as a
  selectable day that the server-side pin then refused to save. Both are
  floor-only callers, so this cannot affect the office paths.
- **Server-side pin:** `assertCurrentPacificDay()` rejects (422
  `date_not_today`) any floor write naming another day. The floor APIs take the
  target day in the request body, so UI scoping alone is not a control — a
  hand-edited or replayed offline-queue entry could reach another day. It
  **refuses** rather than silently retargeting to today, because silently
  rewriting the day would file units against the wrong production day.

The Pacific boundary fix is a **correctness fix in its own right**, not merely a
scoping change.

### D6 — Two chromes, because the auth models genuinely differ

`ManagerChrome` (dashboard / bonus / admin / `/`) and `FloorChrome` (operator).
Not one component:

|                | ManagerChrome                | FloorChrome                      |
| -------------- | ---------------------------- | -------------------------------- |
| Identity       | Entra SSO, personal device   | 4-digit PIN, **shared** device   |
| Sign-out lands | `/login?signedout=1`         | `/operator/<site>` (name picker) |
| Palette        | deep-space + cyan (ADR-0051) | **green** (ADR-0008/0014)        |

Sending an operator to `/login` would strand them on a Microsoft sign-in button
they can never satisfy — they have no SSO account. Sending a manager to the name
picker would be meaningless.

- **Back is always an explicit destination, never `router.back()`.** On the
  floor especially: the offline queue plus `revalidatePath`/`redirect` make
  history an unreliable description of where the operator came from.
- **Logout is a LOCAL sign-out** (`signOut()` clears the Auth.js cookie); it does
  **not** perform an Entra front-channel logout, so the user's M365 session in
  the same browser is deliberately untouched. Bill chose this explicitly.
  Consequence: on the manager side "sign out then sign in" is a silent SSO
  round-trip, not a password prompt — **this is not a shared-device logout**.
  The shared device is the iPad, which has its own PIN-based model.
- **The label is "Log Out"**, per Bill, replacing "Switch user". Behavior
  (shift handoff back to the name picker) is unchanged; the wording is what
  operators actually look for.
- `/login` now shows a "You've been signed out" confirmation, so a successful
  sign-out is distinguishable from an expired-session bounce.

### D7 — The shared pill primitive owns geometry, not palette

`NavPill` supplies the shape: icon + label, `min-h-[44px]` (ADR-0060 / WCAG
2.5.5), persistent border, visible focus ring. The **palette is supplied by the
caller** as `toneClass`: `SPACE_TONE` for the office, `GREEN_TONE` living in
`operator/_components/floor-tone.ts`.

That split is not stylistic. The ADR-0051 / C-16 sweep
(`office-dark-theme-sweep.test.tsx`) statically forbids green brand classes
anywhere under `src/app` outside the floor tree. Baking a `tone: 'green'` map
into a shared `_components` file put floor colors in an office file and tripped
that guard — correctly. Keeping the green tone physically in the operator tree
keeps the ADR-0008 invariant true **statically** rather than by convention.

### D8 — The floor shell owns background, chrome, and top clearance

`FloorShell` (in the operator layout) owns `min-h-screen`, the ADR-0014
background split (black on the pre-PIN trio, green on working screens), and the
sticky chrome band. The locale switcher moves from `fixed end-3 top-3` into that
band. This removes the overlap class outright: pages previously compensated for
the floating switcher with whatever top padding someone picked (`pt-20` on some,
`py-10` on the site picker where the logo overlapped it, `py-8` on the queue
where the sign-out button sat _under_ it, `py-6` on the load workflow). Pages now
render content only, and a shared `FloorPageHeading` replaces three incompatible
header markups.

## Alternatives considered

- **Flip `loads_inventory` to `pilot`.** Rejected — it is shared with the
  manager desktop and every loads write; it would drop the managers' tabs.
- **Born-pilot for all five (strict ADR-0047).** Rejected per D2: it would take
  working surfaces away without warning. Documented rather than done silently.
- **404 a gated surface.** Rejected — a bookmarked URL should degrade to the
  already-translated "not turned on yet" block, not a dead end.
- **One chrome component with a `variant` prop.** Rejected per D6: the sign-out
  destinations are semantically different, not cosmetically.
- **Fix the queue window with `setHours` plus an upper bound.** Rejected — it
  keeps the UTC boundary bug. The point is to share the billing day-key.
- **Silently clamp an out-of-range floor write to today.** Rejected — it would
  file units against the wrong production day.
- **`router.back()` for the floor.** Rejected — see D6.

## Consequences

- Bill can disable any iPad surface from `/admin/rollout` in seconds, with no
  deploy and no effect on the manager desktop.
- The dock workflow's server actions are gated for the first time.
- The iPad shows today and only today, on the same day boundary as billing; the
  evening-shift wrong-day defect is closed.
- Every manager page gains a sign-out; every operator screen gains back and
  Log Out; the 7-stage load workflow gains an exit.
- `back-to-dashboard.tsx` and `queue/sign-out-button.tsx` are removed; their
  consumers move to `manager-chrome.tsx` and `operator/_components/`.
- New per-surface rows must be seeded for any future site (migration + `seed.mjs`
  both carry them, idempotently).
- **Residual:** ~90 hardcoded `←`/`&larr;` glyphs remain across ~45 manager page
  files. The strings the new chromes consume were fixed (`floor.common.back`
  removed, chevrons now mirror under RTL); the rest is deliberately out of scope
  for this change and tracked in `docs/OPEN-ITEMS.md`.

---

## Amendment 1 — verification pass, 2026-07-30

**Status:** Accepted. Bill: _"DO NOT leave work not completed or features blocked
or not working push through and finish this and make sure the ipad functions are
completely repaired."_

A verification pass against production (`dr3_vision` on svdp-dev, measured
2026-07-30) found **four** defects. Two were claims in this ADR that the code did
not implement; two were pre-existing and independent of it. All four are repaired.

### A1.1 — The queue's arrival time was rendered in UTC (worst of the four)

`formatTime` / `formatDate` in `src/lib/format.ts` omitted `timeZone`, so `Intl`
fell back to the runtime default. Measured **inside `dr3-vision-app`**:

```
Intl.DateTimeFormat().resolvedOptions().timeZone   ->  "UTC"
format(2026-07-30T17:00:00Z)  as shipped           ->  "5:00 PM"
format(2026-07-30T17:00:00Z)  timeZone: Pacific    ->  "10:00 AM"
```

`2026-07-30T17:00:00Z` is Woodland's real docking appointment for that day —
**10:00 AM PDT, displayed to the operator as 5:00 PM.** The most common MyMRC
slot, `15:00Z` (8:00 AM PDT), displayed as 3:00 PM. Seven hours wrong, on the one
field the dock queue exists to communicate: which truck, when.

`expected_arrival_at` is a genuine UTC instant, not a naive wall-clock — MyMRC
supplies free text (`"2026/07/20 12:00 PT"`) which `mappers.ts` converts via
`parsePacificDateTime`, and `arrived_at` is written by `new Date()`. So the
formatter, not the storage, was the defect.

Fixed by pinning both formatters to `PACIFIC_TZ` **inside `format.ts`** rather than
at each call site, so a future caller cannot reintroduce it. Pacific is correct for
every caller — both facilities and Bill are Pacific. This also corrected two
manager pages (`dashboard/[site]/load/[id]`, `dashboard/[site]/loads/load-row`)
that were lying by the same 7 hours. `pacificDateLabel` remains UTC-rendered for
`@db.Date` business days — that is the storage invariant in `@/lib/time`, not a
second bug.

### A1.2 — An operator could not resume a load they had already started

D5 is about **browsing**. It was also, unintentionally, applied to **unfinished
work**, and that stranded real production data.

The queue lists `expected_loads`; the workflow operates on `inbound_loads`.
Nothing on the iPad ever listed the latter, so the only route into an unfinished
load was the redirect `startLoadAction` performs. Lose that tab — iPad sleeps, PWA
reloads, shift handoff, another operator on the shared device — and the load is
unreachable, because an operator cannot type a UUID. Three independent filters
kept the parent queue row from being a fallback: the current-Pacific-day bound,
`cancelled_at: null`, and the fact that the queue only ever showed the parent.

**Three Woodland loads were stranded, each by a different filter:**

| load       | status     | why unreachable                                              |
| ---------- | ---------- | ------------------------------------------------------------ |
| `f1e26906` | `arrived`  | parent expected 2026-07-29 10:00 AM PDT — past day           |
| `3700cfef` | `finished` | **3 units counted**; parent CANCELLED 2026-07-29 4:00 PM PDT |
| `d792ed15` | `arrived`  | parent expected 2026-08-05 12:00 PM PDT — future day         |

`3700cfef` is the money case: the units were counted at the dock and never
submitted, so they never reached inventory or billing.

New `listOperatorOpenLoads` (`src/lib/loads/open-loads.ts`) + an "unfinished
loads" block at the top of the queue. **Deliberately not day-bounded** — your own
mid-workflow load is not history, it is current work whose arrival instant happens
to be in the past, and applying the floor to it protects nothing while stranding
counted units. Bounded instead by three tighter predicates: your own
`assigned_operator_id` (matching what `load/[id]/page.tsx` already enforces, so no
row renders a link that bounces), a non-terminal dock status, and your site. No
write path changes: `startInboundLoad` was already idempotent and the state machine
already accepts `finished -> submitted`.

### A1.3 — D1 was not implemented for the two pages it names

D1 says `ipad_queue` governs "`/queue` + `/load/[id]` + the dock server actions."
Only the **actions** (`[site]/actions.ts` `ctx()`) and the **hub card** read it.
Both pages were ungated. Flipping `ipad_queue` to `pilot` would therefore have:

- hidden the hub card (correct), and
- left `/operator/<site>/queue` and `/operator/<site>/load/<id>` fully rendered and
  bookmarkable, with every button throwing an ungated
  `LoadsInventoryNotActivatedError`.

Both pages now read the gate and degrade to the shared translated
`floor.common.not_activated_*` block, which is what the "404 a gated surface"
alternative was rejected in favor of. The write gate in `actions.ts` stays —
defense in depth, not a replacement.

### A1.4 — A thrown error discarded the entire chrome this ADR added

`src/app/global-error.tsx` was the app's only error boundary, and it renders its
own `<html>`/`<body>` — so it **replaces** the operator layout, discarding
`FloorShell`, the green palette, the locale provider, and the `FloorChrome` band
carrying Back and Log Out. Any thrown error put a floor operator on a black,
English-only "Something went wrong" screen with **zero navigation on a shared
iPad**. That is the same stranding D3/D6 exist to prevent, arriving through the one
path nobody had gated — and A1.3 was a live route to it.

New `src/app/operator/error.tsx`. A route-group boundary renders **inside**
`operator/layout.tsx`, so the background, the translations and the Back/Log Out
band all survive the error. It adds a Retry (`reset()`, which avoids a full reload
that could serve a stale Serwist shell) and, because the hub has no Back pill by
design, an explicit "back to my screens" link. Telemetry still goes to GlitchTip.
`global-error.tsx` remains for a failure in the root layout, which a nested
boundary cannot catch.

### A1.5 — `ipad_queue` at `live` is CORRECT, not drift

Bill's 2026-07-28 instruction was _"disable all the ipad surfaces except inbound
haul processing for now."_ `ipad_queue` is `live` at both sites, which reads like
drift against that. It is not, on two independent grounds:

1. **The dock queue IS inbound haul processing, and it is in active use.** Four
   `b2b_haul` loads went through the 7-stage dock workflow in the 45 days to
   2026-07-30, the most recent arriving **2026-07-29 9:49 AM PDT**. Woodland has
   exactly **1** expected load today (10:00 AM PDT), correctly floored down from 45
   total `expected_loads` rows spanning 2026-05-06 → 2026-08-07 — D5 is working.
2. **Turning it off would create a data dead end, not just an inconvenience.** The
   three A1.2 loads sit in non-terminal states. `ipad_inbound` cannot absorb their
   day: `confirmFloorInboundDay` refuses a day that has per-load dock captures
   (409 `per_load_exists`), and `listFloorInboundDays` marks it read-only. So
   gating the queue off leaves counted units with **no** path into inventory from
   the floor.

The three surfaces Bill named — `ipad_count`, `ipad_processed`,
`ipad_today_summary` — are `pilot`, matching both his instruction and the ADR-0047
default. **No production gate row needs to change.** The correct reading of D1 is
that `ipad_queue` governs the dock-processing surface, and the table above is
amended to say so explicitly.

### Consequences of Amendment 1

- The dock queue shows Pacific arrival times. So do the two manager loads surfaces.
- An operator can always reach a load they started, on any day, even if MyMRC
  cancelled its parent — and a `finished` load is one tap from submission.
- Flipping `ipad_queue` to `pilot` is now safe: both pages degrade to the
  translated block instead of crashing.
- No thrown error can strand an operator on a shared iPad without Back or Log Out.
- **Guard added:** `floor-surface-coverage.test.ts` derives its inputs from the
  filesystem — it enumerates the real `page.tsx` files under `src/app/operator/`
  rather than a hand-written path list, then asserts (a) every screen has an exit,
  (b) every screen in the D1 table reads its gate and degrades translated, (c) the
  hub is never gated, (d) no operator page computes a day with `setHours(0…)` or a
  UTC ISO slice. A new operator screen is covered automatically. Verified to fail:
  removing the queue gate turns it red with a named message.
- `format.pacific.test.ts` locks the zone with the exact production instants,
  including the DST seam and the evening-shift `2026-07-31T01:30:00Z` → 6:30 PM PDT
  case.
- **Residual (unchanged scope):** four MANAGER surfaces still derive a day key with
  `new Date().toISOString().slice(0, 10)` in the browser
  (`dashboard/[site]/ops/OpsClient`, `dashboard/[site]/equipment/EquipmentClient`,
  `dashboard/[site]/loads-inventory/LoadsInventoryClient`,
  `dashboard/[site]/processed-units-close/ProcessedUnitsEntryClient`, plus
  `admin/billing-rates/format` and `admin/processed-units/ProcessedUnitsClient`).
  From 5 PM Pacific onward those default their date input to TOMORROW. No operator
  surface is affected — the negative control over `src/app/operator/**` is clean —
  so this is tracked for a manager-side pass rather than fixed here.

---

## Amendment 2 — the Pacific day, everywhere (2026-07-30; recorded 2026-08-11)

**Status:** Accepted. **The code shipped 2026-07-30; this record did not.** It is
written twelve days late, and the delay is the reason it exists in this form — see
"Why this was written late" below.

**Closes:** the residual at the end of Amendment 1 — the six manager surfaces that
still derived a day key from the UTC day, "tracked for a manager-side pass rather
than fixed here."

### A2.1 — The defect

Amendment 1 fixed the *floor* clock and named, but deliberately did not fix, the
*manager* one. Six client screens each derived today as:

```ts
new Date().toISOString().slice(0, 10);
```

`toISOString()` converts to UTC first. From **5:00 PM Pacific — which is 00:00Z the
next day** — every one of them returned **tomorrow**, so every date input on those
screens defaulted to a production day that had not happened yet. An evening entry
landed silently on the wrong day; nothing errored, because nothing was wrong as far
as the code was concerned.

The six:

| Surface                                                | Role                    |
| ------------------------------------------------------ | ----------------------- |
| `dashboard/[site]/ops/OpsClient`                        | task due-date default   |
| `dashboard/[site]/equipment/EquipmentClient`            | date filter default     |
| `dashboard/[site]/loads-inventory/LoadsInventoryClient` | entry-date default      |
| `dashboard/[site]/processed-units-close/ProcessedUnitsEntryClient` | close-date default |
| `admin/processed-units/ProcessedUnitsClient`            | entry-date default      |
| `admin/billing-rates/format`                            | effective-date rendering |

`admin/billing-rates/format` deserves a note: its comment said `(UTC)` as though
that settled the matter. The wire format is `@db.Date`, so the *format* was never
in question — **which day** was, and both sites are Pacific.

### A2.2 — The fix is deletion, not invention

`appTodayISO()` in `@/lib/time` already existed and is documented "for client
default values." It delegates to `pacificDayISO`, the same definition the floor
uses. The defect was **six re-implementations of a solved problem**, not a missing
primitive, so the fix removed six local helpers and called the shared one.

This is ADR-0090 D1's cost, paid again on a different surface: *"inlining a `??`
chain at five call sites is precisely how `held-by-panel.tsx` came to label a
`submitted` load 'Counting' for five days."*

### A2.3 — The guard, and why it is shaped that way

`src/lib/app-today-iso.test.ts` asserts both halves: that the helper is right, **and
that nobody re-rolls it**. Three properties are worth keeping when this file is next
touched:

1. **It walks `src/app` rather than checking a hand-written list.** A list of the six
   offenders would have passed forever while a seventh screen reintroduced the bug.
   The walk caught five files the author's original grep missed — that grep was
   whitespace-strict and the real code was not, which is the whole argument for the
   guard over a review checklist.
2. **It strips comments before scanning.** The first version fired on its own
   explanation, because the fix documents the anti-pattern by quoting it. *A guard
   that punishes its own documentation trains people to delete the documentation.*
3. **It proves it can fail.** One case asserts the regex matches the pattern it bans;
   another asserts that comment-stripping does **not** hide a live call carrying a
   trailing comment. Without those, the ban could be vacuously green — the same
   defect class as a safety net whose failure mode is silence.

The ban is deliberately narrow: it targets `new Date().toISOString().slice(0, 10)` —
deriving **today** — and not `toISOString().slice(0, 10)` applied to a date the
caller already has. Formatting a known `@db.Date` that way is correct, and several
surfaces still do it legitimately.

**Verification at ship:** whole repo 3,871 tests pass, `tsc` 0, eslint 0, prettier
clean. Re-verified 2026-08-11 when this record was written: all six surfaces import
`appTodayISO`, and the guard is green.

### Why this was written late, and what it cost

The work shipped as `7e1cf342` on **2026-07-30 at 08:45 PT**. No amendment was
written. Five source files and one test carried the comment **"ADR-0065 Amendment 2"**
from that day forward, and for twelve days that citation resolved to nothing.

Nobody noticed, and nobody could have: **the failure mode was silence.** A reader
following the citation would have found ADR-0065 with a single amendment and no way
to tell whether the constraint was real, superseded, or imagined. This is precisely
what ADR-0064 recorded about itself — *"This ADR was referenced by the code it
governs … but the file itself was never committed"* — recurring undetected.

It was found by **ADR-0094 §3 RC-4**, which was counting untracked promises rather
than looking for this, and it turned out not to be alone: the same sweep found
**ADR-0068 Amendment 3/4/5, ADR-0069 Amendment 3, and ADR-0019.5 Amendment 1** cited
by code and likewise never written — 24 dangling citations across four ADRs.

The prevention is **ADR-0097**: a citation resolver that fails CI when an
`ADR-NNNN`/`Amendment N` reference in the tree does not resolve to a real file and
section. Had it existed on 2026-07-30, this amendment would have been written the
same morning, because the build would not have gone green without it.
