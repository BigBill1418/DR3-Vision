# ADR-0075 — A name collision is a fork in the road, not a wall

**Status:** Accepted (2026-08-04)
**Supplements:** ADR-0062 (the equipment-master seed), ADR-0063 (the admin equipment surface + the `(site_id, display_name)` unique), ADR-0046 Amendment 9 (the AP equipment escape hatch and its resolve worklist)
**Does NOT supersede:** ADR-0063 D3. The `(site_id, display_name)` unique index stands, unchanged and unweakened.

## Context

On **2026-08-04** an approver worked an invoice for a Terex machine at Woodland
through the AP equipment escape hatch, and the system taught them to make the
data worse.

The timeline, reconstructed from production:

- **10:58:41** — an equipment request is filed with the description `Terex machine`.
- **10:59:20** — 39 seconds later an `equipment` row is inserted, and the request
  is resolved **34 ms** after that. The gap is the shape of a person retyping,
  not deliberating.

Production now holds **three rows for one machine**, all at Woodland, all
`vehicle`, each cited by a different approved invoice:

| id         | display_name    |
| ---------- | --------------- |
| `7e35a4aa` | `Terex`         |
| `bee54def` | `Terex Machine` |
| `1125fb30` | `Terex machine` |

Three things had to line up to produce that.

**1. `resolveEquipmentRequest` had exactly one verb.** Its input type carried
`displayName` + `category` and nothing else, and its body called
`createEquipmentInTx`. There was no way to say _"that asset is already in the
registry — it's that one."_ An approver whose asset already existed under a
slightly different spelling had **no legal move at all**: creating collided, and
pointing at the existing row was not an option the code offered.

**2. The refusal named no alternative, and its remediation 403s for its own
audience.** The message read:

> An asset with that name already exists at this site. Open /admin/equipment,
> reactivate or rename it, then resolve this request against it.

The equipment-request worklist is deliberately reachable by a **site manager**
holding `can_resolve_equipment_requests` (ADR-0046 Am.9 — the whole point being
that the person who knows the machine is the one who should name it).
`/admin/equipment` is **admin-only**. So the sentence's only actionable advice
sent most of the people who could ever read it to a door that returns 403. What
remained was a wall with a text box next to it.

**3. The uniqueness is case-SENSITIVE, so retyping around the wall works.**
`(site_id, display_name)` is an exact-match unique. `Terex machine` is a
different string from `Terex Machine`, so the second attempt succeeded — and the
system reported success. Nothing anywhere said _"you have just created a
duplicate."_

That is not an operator error. Given a wall, a text box, and a job to finish,
lower-casing the name is a rational move. The defect is that the wall was the
only thing on offer.

**Why this is worth fixing now and not later.** Equipment linkage is
approval evidence on invoices (ADR-0046 Am.5 / D-M5-6), and the registry is the
option set every approver picks from. A fleet where one machine appears three
times makes every downstream question — _what did we spend on the Terex this
quarter_ — quietly unanswerable, and it gets worse monotonically: each collision
teaches the same workaround. There is an **open request right now** (`a2ab144d`,
"trailer 540010", Woodland) whose asset **already exists** (`3c063c8d`, `trailer
540010`, active). Resolving it through the old code path would have hit the exact
same wall and produced the fourth duplicate.

## Decision

### D1 — Resolve MAY target an existing asset

`ResolveEquipmentRequestInput` becomes a discriminated union:

- `mode: 'create'` (**the default when `mode` is absent** — every existing caller
  and payload behaves exactly as before), or
- `mode: 'existing'` with `equipmentId`, optional `reactivate`, `backfillLink`,
  `note`.

The existing-branch loads the target **inside the transaction** and asserts it
exists, is not merged, and lies within the actor's site reach — **re-derived from
the equipment row, never from the payload** (hard rule #2). Both branches then
share one identical tail: the conditional `status: 'open'` stamp, the link
backfill, and the audit row. The existing-branch **never** calls
`createEquipmentInTx`.

The audit `after` gains `resolution_mode`, so the log can distinguish a request
that GREW the registry from one that pointed at what was already there — which is
the entire subject of this ADR.

### D2 — A 409 carries what it collided WITH

`createEquipmentInTx`'s `name_taken` failure now returns `existing[]`: the
canonically-matching rows at that site, **including inactive and already-merged
ones**. The resolve layer raises `ApEquipmentNameTakenError` carrying that list;
the route answers `409 { error, code: 'name_taken', existing: [...] }`.

The panel turns that into a choice: each candidate renders as _name · category ·
site_, badged when inactive or merged, with **"Use this one"** — labelled
**"Reactivate and use"** when the target is inactive — and **"Rename mine"**,
which clears and refocuses the field. A 409 with an **empty** list (the P2002
race backstop, which has no candidates to offer) still renders the plain banner,
so there is exactly one branch to write and no empty suggestion box.

A debounced lookup (`GET /api/admin/equipment/similar`) surfaces the near-miss
**before** the submit that would fork it. It is gated by
`requireEquipmentRequestAccess()`, **not** `requireAdmin()` — gating it admin-only
would rebuild the original dead end one layer down, since the manager would type
a colliding name and get a bare wall again because the lookup that would have
rescued them 403'd. It reads and nothing else, and site reach is checked before
any row is read.

### D3 — Canonical detection is a DETECTOR, never a CONSTRAINT

`canonicalizeName()` = trim → collapse whitespace → lower-case → strip
`[^a-z0-9]`. `Terex Machine` ≡ `terex machine` ≡ `TEREX  MACHINE`; `EQ43 — Shear`
≡ `eq43 shear`.

**There is deliberately NO case-insensitive unique index, and there must not be
one.** Production holds a violating group **right now** (`Terex Machine` /
`Terex machine` — verified 2026-08-04: exactly one such group fleet-wide).
Migrations run in the deploy's **init container**, so a `CREATE UNIQUE INDEX`
that cannot build does not fail a review — it **crash-loops the deploy**. The
database keeps refusing only exact collisions; the application notices the
near-misses and offers them.

The blindness this accepts is real and recorded: `Terex` and `Terex 2`
canonicalise differently and will never be suggested for each other. Detection
catches the typo-shaped duplicate; the merge tool (D4) catches the rest.

### D4 — Merge repoints ATTRIBUTION, never MONEY

`mergeEquipment(winnerId, loserId, actor)`, in one transaction:

- repoints `ap_equipment_links.equipment_id`,
- repoints `ap_equipment_requests.resolved_equipment_id`,
- stamps the loser `{ is_active: false, merged_into_id, merged_by, merged_at }`,
- writes the audit row **inside the same transaction**, carrying both repoint
  counts.

It **never writes `ap_requests`** — not `status`, not the amounts, not
`decided_by`/`decided_at`. The approval already happened and the money already
moved; a bookkeeping correction to _which machine an invoice names_ must not
reach back into the decision. This is the same invariant ADR-0046 Am.9 #3 holds
for resolution, and it is enforced by a test that spies the `apRequest` writers
and asserts they are **never called at all** — a comment cannot enforce it. That
test was **falsified** during development: adding an `ap_requests` write to
`mergeEquipment` turns it red, and removing it turns it green again.

`equipment_events` is outside the blast radius **by construction**: it is a
Terex-first log keyed on a free-text `equipment_code` string with no FK into this
registry (ADR-0048 D3). Nothing there references an equipment id, so nothing
there needs repointing.

Refused: self-merge, cross-site (a merge de-duplicates within one site's
registry; transferring a site is a separate, audited edit), and either side
already merged (chains would make `merged_into_id` a linked list nothing follows
correctly). **Nothing is ever hard-deleted** — `ap_equipment_links.equipment_id`
is `onDelete: Restrict` and those rows are financial-approval evidence.

Merge is **admin-only** (`requireAdmin()`), unlike its sibling lookup. _Detecting_
a duplicate is something the whole resolve audience must be able to do; _declaring
two records to be the same physical machine_ silently rewrites what every invoice
citing the loser now names, and is not reversible from the UI.

### D5 — `merged_into_id`, not an `is_active` overload

A dedicated nullable self-FK column (`onDelete: Restrict`) plus `merged_by` /
`merged_at` and an index, rather than reusing `is_active`.

The two facts are genuinely different. `is_active = false` means _"not selectable
right now, may come back"_ — and a returning asset is **reactivated**.
`merged_into_id` means _"this row is not a thing any more; the thing is over
there"_ — and it never comes back.

**The seed resurrection trap makes the distinction load-bearing.**
`scripts/seed-equipment-master.mjs` keys its idempotency on `(site_id,
display_name)`, and a merged loser **keeps its name** — nothing here is ever
renamed or deleted. A naive re-run after a merge finds the loser by name and
writes `is_active = true` straight back onto it, silently re-splitting the rows
an admin just joined and putting the duplicate back in front of every approver.
The seed now follows `merged_into_id` **one hop** to the survivor and updates
_that_; if the survivor is missing (impossible through the app — `onDelete:
Restrict` — so it means data damage) it **skips** rather than resurrecting. One
hop only, because merge chains are refused at the API, so a chain cannot form.

Merged rows drop out of the admin list by default (**including the `status: 'all'`
view**, which is exactly where an admin goes hunting for a name they cannot
find), out of `listSiteEquipment()`, and out of `assertEquipmentForSite()` — those
last two must agree in both directions, or a stale tab would render an option
that 400s on save.

### D6 — One wording, in `messages.ts`, and no i18n

Three copies of the collision sentence existed and disagreed. `messages.ts`
`equipment.nameTaken` is now the single canonical string; the inline literals in
`lib/ap/equipment-requests.ts` and the resolve route's P2002 backstop are deleted
and both read from it. The route instruction ("Open /admin/equipment…") is gone —
remediation is offered as **buttons**, not prose pointing at a 403.

**No locale keys.** Hard rule #4 (en/es/ur on day one) governs the
**operator-facing** app. `/admin` is English-only by ADR-0017, and every surface
this ADR touches sits behind the admin or equipment-request gate.

## Alternatives considered

**Add a case-insensitive unique index and nothing else.** Rejected — and it is
the tempting one. It would crash-loop the deploy: production holds a violating
group today and migrations run in an init container. Even with the data cleaned
first, it converts the collision from a wall into a _harder_ wall; the operator
still has nothing to click, and the workaround becomes `Terex  Machine` or
`Terex-Machine` instead. It also cannot be added later without first merging the
live duplicates — which is why O-10 blocks any future attempt.

**Drop the uniqueness entirely.** Rejected. The unique is what keeps two
indistinguishable options out of the approver's picker and what
`seed-equipment-master.mjs` keys its idempotency on. Removing it makes
duplication legal and silent — strictly worse than a wall.

**Ship the merge tool only, and leave resolve alone.** Rejected. That is a mop
without closing the tap: the resolve panel would keep manufacturing duplicates
faster than an admin merges them, and every merge needs a human judgement that
two records are one machine.

**Ship the collision UI only, and skip merge.** Rejected. It stops new
duplicates but strands the three that exist, each already cited by an approved
invoice, with no path to correctness.

**Auto-merge on canonical match.** Rejected. Canonical equality is a _hint_,
not proof — `Terex` vs `Terex 2` is the counter-example, and an automated merge
silently rewrites what approved invoices name. A human confirms; the machine
suggests.

**Grant site managers access to `/admin/equipment`.** Rejected. That fixes the
broken instruction by widening an admin power, which is exactly the reconflation
hard rule #2 forbids (site _reach_ is not admin _powers_). The instruction was
the wrong answer; the fix is to not need it.

## Consequences

- **Resolve now has two modes.** Callers passing no `mode` are unchanged, so the
  admin create page and every existing payload behave identically. New tests pin
  both branches, including atomicity and the 403 on an out-of-reach target.
- **Every consumer of `equipment` must filter merged rows.** Done here for the
  admin list, the AP picker, its validator, and the similar-name lookup. Any
  future reader of this table inherits the obligation.
- **The seed now depends on `merged_into_id`.** A change to the merge model that
  breaks the one-hop follow re-opens the resurrection trap; a guard test pins it.
- **Detection has known limits.** Canonical equality will not catch `Terex` vs
  `Terex 2`, or two genuinely different spellings of the same machine. Those need
  the merge tool and a human.
- **Merge is an admin escalation.** A site manager who spots a duplicate can no
  longer fix it alone — they resolve correctly against the survivor (D1) and
  raise the merge with Bill. That is the intended trade: the destructive-ish
  operation is rarer than the detection.
- **The approver's picker now shows a site code.** It has been fleet-wide since
  2026-07-28, so two similarly-named assets from different yards were previously
  indistinguishable in one flat list.
- **Two follow-ups are Bill's clicks, not this change's:** merging the three live
  Terex rows (O-10) and resolving `a2ab144d` against the existing `trailer 540010`
  (O-11). Neither was performed here — both require a human to confirm the
  physical facts.
