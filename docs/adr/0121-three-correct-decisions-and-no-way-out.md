# ADR-0121 — Three correct decisions and no way out

- **Status:** Accepted (emergency, shipped during floor hours)
- **Date:** 2026-08-20
- **Incident:** Woodland floor, 12:36 PM – 2:0x PM PT

## Context

At 12:52 PM PT Bill reported the Woodland floor page as _"no response, totally
locked up, totally unusable."_ A full iPad refresh did not help.

The server was healthy throughout, and this is what made the incident hard to
read. Measured during the outage:

- `dr3-vision-app` healthy, `/api/healthz` 0.13 s, `/operator/woodland/hauls`
  0.48 s.
- Postgres idle — zero advisory locks held across ~600 samples at 250 ms, zero
  lock waiters, zero transactions older than 5 s.
- Check-ins were **succeeding**: `cfc91dbe` (H-137887) was created at 20:00:56
  UTC = **1:00:56 PM PT**, i.e. during the reported outage.
- Photo uploads were succeeding: 12 captured, 12 uploaded.
- No `Failed to find Server Action`, no rollout gate closed
  (`ipad_queue`/`ipad_hauls` both `live` for woodland), no session revocation
  (`sessions_invalidated_at` NULL for every active operator).

The floor was not refused. It was **trapped one step in**.

`abaf1aae` (H-137810) was checked in at 12:36:25 PT; its BOL photo landed at
12:36:35. It then sat at status `arrived` for over 90 minutes while three
operators took it over in turn. Every other load that day moved off `arrived` in
43 s – 2 m 19 s.

## The defect

Three decisions, each defensible on its own, compose into a screen with **zero
live controls**:

1. `load-workflow.tsx:200-221` — the BOL step is gated on `bolDone`, a client
   `useState`. Capturing the BOL does **not** move `load.status` (it stays
   `arrived`), so any reload, and any takeover by the next operator, returns to
   stage 1.
2. `stage-bol.tsx:45` — Continue was `disabled={!hasFile || isPending}`, and
   `hasFile` is `useState(false)`, false on every fresh mount regardless of what
   the server holds.
3. `photo-input.tsx:377` — capture is
   `disabled={… || (count > 0 && status !== 'error')}` with `count` seeded from
   the server's `photo_counts.bol`; the "add another" control (`:408`) renders
   only from `done`/`queued`, and a fresh mount is `idle`.

Capture disabled → add-another absent → Continue disabled. And it **survives a
hard refresh**, because the trapping state is a `load_photos` row in Postgres,
not anything in the browser.

Each rule is right. ADR-0109 was right to stop offering two identical-looking
ways to take the required photo. The trap is in the SEAM, which is why no
file-scoped review and no existing test caught it — and why the existing
`photo-input.limit.test.tsx` did not: it mounts `initialCount` 0 and MAX (3).
**Production was at 1**, the one band neither endpoint covers.

ADR-0109 also removed the accidental escape hatch that had masked this: before
it, `initialCount` defaulted to 0, so capture stayed live and re-taking the photo
re-armed Continue. The regression shipped 2026-08-19 10:35 AM PT (#268,
`336d64d`) and took ~26 hours to reach an operator who re-entered a load.

## Decision

Gate the stage's Continue on the **server fact** as well as this mount's state:

```
disabled={(!hasFile && photoCount === 0) || isPending}
```

in **both** `stage-bol.tsx` and `stage-door.tsx`. `photoCount` was already
plumbed from `page.tsx`'s `photo_counts` (`load-workflow.tsx:220,229`); nothing
new is threaded.

`stage-door.tsx` was not the file that trapped the floor today only because the
load never reached it. Its shape is identical and it is armed, so it is fixed in
the same change rather than left to be rediscovered by an operator standing at a
truck. Stage 2 (weight) is not affected — it escapes via its own "None" button.

No data is touched. The stuck rows need no repair: with Continue live, the
operator re-opens the load and proceeds.

## Alternatives rejected

- **Delete the `load_photos` row in prod to un-stick the load.** Un-sticks one
  load, leaves the trap armed for the next one, and destroys a BOL photo that is
  the paperwork for a real truck. Operator-visible data deletion is Bill's call,
  and the code fix makes it unnecessary.
- **Re-enable capture when `status === 'idle'` and `count > 0`.** Puts back the
  second identical control ADR-0109 deliberately removed, and asks the operator
  to re-photograph paperwork they already photographed.
- **Move the stage off `bolDone` onto a server-derived stage.** The right shape,
  and where this should go — but it changes how every stage is selected, which is
  not a change to make at 1 PM with trucks on the dock. Recorded as follow-up.

## Consequences

- Re-entering a stage that already has its photo now offers a live Continue. The
  forced-photo rule (ADR-0060) is intact: `photoCount === 0` with nothing
  captured still refuses, asserted in both directions.
- `stage-reentry.test.tsx` mounts the **real** composition — `StageBol` /
  `StageDoor` over the real `PhotoInput` — because a suite that stubs
  `PhotoInput` cannot see this class of defect at all. It asserts _at least one
  enabled control_ by counting buttons rather than naming one testid, so the
  other two controls cannot vanish unnoticed, and it covers bands 0/1/2/3.

## Follow-ups (not in this PR)

1. **A zero-live-controls detector.** `DeadEndBeacon` is absent from all seven
   `stage-*.tsx` files. Mounted there, it would have fired at 12:36:35 instead of
   the floor being the discovery mechanism at 12:52. With an ntfy alert graded
   `high` (15-min cooldown, tier-1 click to `/operator/<site>/load/<id>`, topic
   `dr3-vision-floor` per ADR-0036/0037).
2. **Server-derived stage selection**, retiring the `bolDone` client latch.
3. **Unrelated, found while investigating:** Bill's manual M-186301 correction
   (960 program / 110 non-program) is not in `processed_units_daily` — the row
   still reads 970/100 with `source = 'import'`. ADR-0119 guarded the MyMRC
   bridge against overwriting manual corrections but the **workbook-import**
   writer is a third author and is not covered. Separate PR.
