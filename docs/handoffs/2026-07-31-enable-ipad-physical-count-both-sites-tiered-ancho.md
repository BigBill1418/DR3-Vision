# 2026-07-30 — Enable iPad physical count (both sites) + tiered anchor-overwrite guardrail

**Session context (Bill × Claude, 2026-07-30):**

Bill: enable the iPad physical-count surface at **both** sites. He trusts the crew to re-anchor, so no blanket authorization gate — but a count _overwrites_ Woodland's known-good anchor (2,483), and a mistyped count would silently move the entire floor and every downstream number. Walking through the mechanics, Bill chose a **tiered guardrail**: a confirm step on modest overwrites, and **manager approval required on large swings**. He set the large-swing threshold at **20%** (tightened from a proposed 40% — on a 2,483 floor, 40% let ~1,000 units through on a tap; 20% is ~500).

**Verified against repo state `2026-07-30T20:36Z`:**

- `/operator/[site]/count` exists (ADR-0060), writes a physical on-hand as a new anchor snapshot.
- Gated by the per-surface `ipad_count` rollout flag (ADR-0065) — governs both the screen and its write path.
- Current seed: `ipad_queue` + `ipad_inbound` **live**; `ipad_count`, `ipad_processed`, `ipad_today_summary` **pilot (off)** both sites.
- `site_inventory_snapshots` is append-only anchor history (not a mutable row) — so overwrites are recoverable by re-activating a prior anchor.
- Floor writes carry `assertCurrentPacificDay()` (ADR-0065) — unchanged, still applies.
- Woodland anchor: 2,483 (1,597 program / 886 non-program, 2026-07-22). Eugene: **no anchor**, reads zero until first count.
- Managers hold operator PIN accounts on the iPads (ADR-0060/0061) — the on-device approval path reuses this.

## §1 — The flip

Flip `ipad_count` `pilot → live` at **both** `woodland` and `eugene` at `/admin/rollout`. Rollout-state change, not a deploy; read at request time; reversible.

**Do NOT flip `ipad_processed` or `ipad_today_summary`** — they remain pilot. This handoff is `ipad_count` only.

**Verify the current seed state before flipping** — the standing instruction applies (multiple inherited premises have failed on checking this month).

## §2 — Tiered anchor-overwrite guardrail (the new code)

Trigger is an **overwrite** only. Three tiers:

**Tier 0 — no existing active anchor** → establish normally, zero friction. This is every Eugene count and any site's first count.

**Tier 1 — overwrite, swing ≤ 20%** → **operator confirm step** before write:

- Show current anchor (program / non-program / total + date) next to the entered count.
- Show the delta in words: "This replaces 2,483 with 2,150 — a decrease of 333 (13%)."
- One explicit confirm tap writes it. Cancel returns to entry with the typed value intact.

**Tier 2 — overwrite, swing > 20%** → **holds for manager approval.** Operator cannot self-release. Two approval paths, either satisfies:

- **On-device manager PIN** — a manager enters their PIN on the same iPad to release the write immediately. Reuses the existing operator-PIN mechanism; no new login surface.
- **Remote approval** — the count holds in a pending state, pings the site's managers (Morena/Janette for Woodland) via `notifyStaff()`, and a manager approves from their own screen. Use for when no manager is on the floor.
- The held count persists with its entered value until approved or explicitly discarded — it is never silently dropped and never auto-writes.

**Threshold configurable, seeded at 20%** — a settings value, not a hardcoded constant, so Bill can retune without a code change.

**Server-side enforcement, not just UI:** the anchor-write action independently recomputes whether it is an overwrite and what the swing is. A >20% write arriving without an approval token is refused (422). A hand-crafted request cannot skip the tier. The snapshot's audit row records: overwrite (y/n), prior anchor id + prior totals, swing %, tier, and — for Tier 2 — which manager approved and by which path (PIN vs remote).

## §3 — Recovery surface

Anchors are append-only, so a bad overwrite is recoverable. Add `/admin/inventory/anchors` (or fold into an existing inventory-admin surface): recent anchors per site, with **re-activate a prior anchor** (which writes a new snapshot referencing the restored one — never a hard edit). Admin-only.

If more than a small lift, ship §1+§2 now and file this as fast-follow — the §2 audit record makes script-based recovery possible in the interim, so the floor is never stuck.

## §4 — Actions for Claude Code

1. Verify `ipad_count` seed state both sites; flip `pilot → live`.
2. Build the §2 tiered guardrail: Tier 1 confirm UI, Tier 2 hold + dual approval (on-device PIN + remote), server-side swing recomputation + refusal, full audit record. Threshold configurable, default 20%.
3. Ship §3 recovery surface if small; else fast-follow with the audit record sufficing for interim script recovery.
4. Do NOT touch `ipad_processed` / `ipad_today_summary`.
5. Confirm `assertCurrentPacificDay()` still governs the count write.

## §5 — Success criteria

- `ipad_count` live both sites; Eugene crew can establish its first anchor (Tier 0, no friction).
- A Woodland overwrite ≤ 20% shows current-vs-new + delta, writes on one confirm.
- A Woodland overwrite > 20% cannot be written by the operator alone — releases only via manager PIN on-device or remote manager approval.
- Server refuses a >20% write lacking approval even if the UI is bypassed (422).
- Every overwrite records prior anchor + swing + tier + approver in the audit row.
- A mistyped overwrite is recoverable to the prior anchor.
- `ipad_processed` / `ipad_today_summary` remain pilot.

## §6 — For Bill

Eugene needs its **first physical count** on the iPad to establish an anchor — until then Eugene inventory reads zero. Schedule with Rick. Woodland has 2,483 and needs nothing unless you want a fresh count.
