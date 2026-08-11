# Operator Runbook — Bonus Amendment Workflow + Bi-Site EOD Check

**ADR:** ADR-0028
**Sprint:** Sprint 4 (2026-06-16)

## What changed

1. Managers can edit prior days in the current pay period via a four-eyes request/approval workflow.
2. Closed periods (signed/paid/historical_imported) remain immutable for everyone except the Director (admin escape valve).
3. Date picker is visible to staff — constrained to the current draft period's window.
4. 5 PM Pacific EOD missing-entries notification now covers Eugene AND Woodland, wired as a docker-compose service.

## Deploy

```
git checkout main
git pull
docker compose up -d
```

This applies migration `20260616_amendment_workflow`, recreates `app` with the new amendment routes + UI, and starts a new `dr3-vision-bonus-eod-check` container.

## Verify

1. Migration applied:

```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1;"
```

Expect: `20260616_amendment_workflow`

2. New table exists:

```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "\d bonus_amendment_requests"
```

3. EOD check daemon running:

```
   docker logs dr3-vision-bonus-eod-check --tail 20
```

Expect: `daemon starting` followed by `sleeping until <next 5 PM PT>`.

4. App routes mounted:

```
   curl -s -o /dev/null -w '%{http_code}\n' https://dr3-vision.svdp.us/bonus/amendments
```

Expect 200 (or 401 if unauthenticated).

## Test the EOD ntfy end-to-end

Best on a Wednesday or Thursday afternoon (not a holiday).

> **Trigger (revised 2026-06-17, ADR-0019 §2):** the alert fires only when a
> site has **zero** entries for the day. A partial day (one or more processors
> entered, others didn't) does **not** page. So the test must leave a site with
> _no_ entries at all — removing a single processor's entry will not fire.

1. At ~16:50 PT, log in as Bill, navigate to `/bonus` on each site (Woodland and Eugene). Note today's entries on each site.
2. Temporarily clear **all** of today's entries on each site (DB edit — restore after). Each site must have zero entries for today.
3. At 17:00 PT exactly, observe your phone — expect two ntfy notifications:
   - `[DR3-Vision] No bonus entries for Woodland — <date>.`
   - `[DR3-Vision] No bonus entries for Eugene — <date>.`
4. Restore the entries.

If no ntfy fires:

- `docker logs dr3-vision-bonus-eod-check --tail 50` to confirm the daemon is alive and fired
- `docker exec dr3-vision-bonus-eod-check env | grep NTFY` should show `NTFY_PUBLISHER_TOKEN` set
- `curl -X POST https://ntfy.barnardhq.com/dr3-vision-system -d "test"` should return 200

## Test the amendment workflow end-to-end

1. Log in as Janette at `/bonus`.
2. Use the date picker to navigate to a prior day within the current pay period.
3. Change one employee's mattress count and click Save.
4. The Request Edit modal opens. Type a justification ≥20 chars. Submit.
5. Janette sees a success state; the entry is unchanged on screen (the change is pending approval).
6. Log in as Morena. Navigate to `/bonus/amendments`. Confirm the request appears.
7. Approve. Confirm: Morena, Janette, and Bill all receive email + ntfy. The entry on the original day is now updated.
8. Audit verification:

```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT actor_user_id, action, table_name, created_at FROM audit_log ORDER BY created_at DESC LIMIT 5;"
```

Expect: amendment insert (Janette), entry update (Morena, `actor_label='system:amendment-approved'`), amendment update to `approved`.

## Rollback

1. `docker compose down`
2. Revert the commit on `main`, re-deploy the previous image.
3. Migration is additive — leaving the new table and enums in place is safe even on rollback. Drop manually only if a clean teardown is needed:

```sql
   DROP TABLE bonus_amendment_requests;
   DROP TYPE "BonusAmendmentRequestState";
   DROP TYPE "BonusAmendmentChangeType";
```

## Known limitations

- "Ping Bill" appears immediately on submit — a requester in a hurry can shortcut by pinging Bill in the same breath. This is by design (soft control); the audit log records the time-from-submit-to-ping so abuse patterns are observable.
- ~~Patrick Dills cannot use the workflow at all (separation of duties — he's also an Eugene processor). His prior-day grid is read-only; corrections must be made verbally to Rick or Bill.~~ **No longer true as of 2026-08-11 (ADR-0019.3).** Patrick holds the Eugene ops-signer slot: he uses the workflow normally, approves Rick's requests, and Rick approves his. Do not tell Eugene staff their corrections have to go through Rick or Bill verbally — that guidance is retired.
- Any manager who occupies neither slot in their site's signature chain cannot use the workflow (403). At Eugene that is currently Kelsey Ruhland and Shannon Rockwell; their prior-day grid is read-only and corrections go to Rick, Patrick, or Bill.
- Notes-only edits on prior days are direct (audit-log only, no workflow). Only `mattress_count` changes go through the four-eyes path.
