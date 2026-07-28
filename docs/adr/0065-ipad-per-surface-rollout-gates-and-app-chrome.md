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
