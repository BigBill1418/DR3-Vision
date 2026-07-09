# Board-pack digest (ADR-0045 §3 addendum)

Bethany's monthly board pack, sent automatically by DR3-Vision. **Born pilot** —
until Bill ramps it, it reaches admins only (for content + targeting validation);
staff/board recipients receive nothing.

## What it is

- **Schedule:** the **2nd Wednesday of the month AND the Monday preceding it**
  (Pacific). Both dates map to one send per month (idempotent on the previous-month
  period).
- **Payload:** per site — previous-month processed units (`processed_units_daily`),
  month-to-date, year-over-year (same month, prior year), and a P&L placeholder
  ("Financials: pending GP integration"). No safety/injuries section.
- **Recipients:** Bethany + Bill (the `board_pack_recipients` roster).
- **First LIVE send target:** 2026-08-10.

## Recipients — action required before go-live

The seed inserts Bill's address and a **placeholder** for Bethany:
`bethany.PLACEHOLDER@svdp.us`. **Replace it with Bethany's real address before the
first live send.** Rows live in `board_pack_recipients` (mirrors
`ap_decision_recipients`); update via a DB update or the admin path if wired.

## How it runs

- A thin cron (`board-pack-digest` compose service, `scripts/board-pack-digest-cron.mjs`)
  fires daily at 07:00 PT and POSTs `/api/internal/board-pack/send`.
- The route decides whether today is a board-pack day; on any other day it is a
  clean no-op. On a board-pack day it builds the payload and sends via
  `notifyStaff('board_pack_digest')`.
- Idempotency: a `board_pack_send_log` row (keyed on the previous-month start) makes
  the double-trigger + any restart a single send per month.

## Enable / ramp

1. Confirm Bethany's real address is in `board_pack_recipients`.
2. The compose service starts with the stack (it is not profile-gated); confirm the
   `board-pack-digest` container is up.
3. Ramp the surface from `/admin/rollout` (flip `board_pack_digest` to `live`,
   noting the criteria) when you are ready for Bethany + Bill to receive it. Until
   then, pilot sends reach admins only.

Rollback of any ramp is a flip back to `pilot` — no code change.
