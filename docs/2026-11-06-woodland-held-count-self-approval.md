# 2026-11-06 — Woodland held count: no one could approve it, then it was approved by the same person

Status: **closed for the control gap; the 885 → 362 baseline is still not independently verified.**
All times Pacific (PST). Source: `inventory_count_holds` and `audit_log` on the live database, read 2026-11-06 and
2026-11-07. Blameless review: the people involved did what the screen let them do.

## Summary

A Woodland physical count (885 → 362 units, a 59.1% swing against a 20% threshold) was held under ADR-0072 Tier 2 at
07:18. Until the desktop screen shipped at 09:49 nobody could approve it, because the approval screen could not work for any manager. Staff
re-entered the same count four more times. At 12:50 the held count was approved from the new desktop screen by the manager login
of the same person whose operator login had entered it. That broke the four-eyes rule the Tier-2 hold exists to
enforce, and it went through because the database check compares accounts, not people.

## Timeline

| Time (PST) | Event |
|---|---|
| 07:18 | Hold `998a2dca` created from an operator login: prior 885, new 362, swing 59.1%. |
| 08:24, 08:40, 09:09, 12:31 | Four more identical holds created (three from the same operator login, one from a second person's operator login). |
| (morning) | Bill reports "dr3 vision wont let the managers approve a new count - saying session expired". |
| 09:49 | #313 merged (desktop Held counts screen, honest PIN error); deployed by the auto-deployer after the merge. |
| 12:50:30 | `998a2dca` released from that screen by the manager login of the person whose operator login created it. Path `remote`. |
| 12:50:43 – 12:51:34 | The same manager login discards the four duplicates (reasons "Duplicate" / "Duplicate entry"). |
| 13:16 | #314 merged (floor-PIN link, four-eyes by person). The two Woodland pairs were linked after it deployed. |
| 15:55 | #315 merged (lockout message, stale links refused at use). |
| 2026-11-07 00:54 | #316 merged; the Bill Barnard admin and operator accounts linked afterwards. Scan finds no other pairs. |

## What went wrong

1. **The iPad PIN approval could never work for a manager.** `verifyPin` is operator-only and managers have no PIN, so
   every manager approval failed. The failure came back as 401, and the client mapped every 401 to "session expired",
   so the real problem (no PIN, wrong PIN) was never shown. Result: unresolvable holds and four duplicate counts
   (08:24 to 12:31).
2. **The desktop approval route had no screen until #313.** `POST /api/manager/[site]/count-holds/[holdId]` existed
   but nothing called it. #313 added the screen at 09:49 and it worked, but it inherited the account-level
   self-approval gap from item 3, which was not yet closed when it was used at 12:50.
3. **Four-eyes was enforced per account.** The DB CHECK is `approved_by <> created_by`, which a person holding both an
   operator and a manager login passes trivially. One person entered the count and approved it.
4. **Hold ids were not checked against the caller's site** (found in #313 review; not known to be exploited).

## Fixes (all merged and deployed)

- **#313** — `/dashboard/<site>/held-counts` screen (prior vs new totals, swing %, duplicate flag, approve/discard
  with reason); a wrong PIN is reported as a wrong PIN; hold-id site-ownership check.
- **#314** — `users.floor_user_id` links a manager to the same person's operator account. iPad approval verifies the
  linked account's PIN (its lockout applies). Four-eyes now compares people: an account, the account it links to, and
  any account linking to it count as one person, on both approval paths, checked before the PIN. Discard became a
  guarded single-transaction write.
- **#315** — a locked-out PIN says "locked" (423 `pin_locked`), not "wrong PIN"; a link whose operator moved site, lost
  the operator role or was deactivated is refused at use. The link is deliberately **not** cleared on a role or site
  change, because it is also the same-person record.
- **#316** — the link script accepts an admin account (admins have no site).

## Verified

- Live container runs the fixes; migration applied; 3 links exist (two Woodland pairs, one admin pair), each with an
  audit row naming the admin actor.
- Scan of all 17 non-deleted users for people with both an operator and a manager/admin account, by exact first+last
  name and by first name + site: three people, all now linked.
- CI includes real-Postgres tests for the link, the lockout, the by-person self-release refusal on both paths, and the
  script.

## Not verified / residual risk

- **The Woodland baseline is unverified.** The live snapshot is 362 units (0 indoor, 362 in processing), replacing 885
  from 2026-09-14. Two different people's operator logins entered 362, which is weak corroboration, not a check: it was
  not independent of the approver. **Someone other than the two Woodland staff involved should confirm the physical
  count.** If it is wrong, void the snapshot through the normal snapshot-void path rather than editing rows.
- **No live iPad approval with a real floor PIN has been run.** No hold is pending and none was created in production.
  First real use should be watched; confirm the audit row's `pin_verified_user_id` names the operator account.
- **Links depend on the admin getting them right.** The scan matches names; two accounts for one person under different
  names would be missed. A new person given both account types is unprotected until linked.
- **Five wrong approval PINs also lock that person's floor sign-in** (one PIN, one counter).
- **A pending hold still raises no alert.** It waits on a dashboard link.
- `NEXTAUTH_SECRET` was printed into an operator transcript during this work. It has not been rotated; rotating signs
  every user out.

## Follow-ups

1. Independent physical count at Woodland (owner: site manager other than the two involved).
2. Rotate `NEXTAUTH_SECRET` at a quiet time.
3. Decide whether a pending Tier-2 hold older than N minutes should raise an alert (ntfy / dashboard).
4. When creating a user who will hold two account types, link them in the same step.
