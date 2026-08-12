# ADR-0095 — The ledger recorded the attempt, not the page

**Date:** 2026-08-11
**Status:** Accepted
**Amends:** ADR-0019.5 (the em dash that ate the payroll alert) — closes the second half of it
**Extends:** ADR-0067 D9 (the anomaly ledger), ADR-0037 (noise policy)
**Incident:** 2026-08-11 ~5:51 PM PT — "I got a bunch of vision ntfy's about not being
able to download or ingest files. why?"

---

## 1. The answer to Bill's question

**Nothing started failing today. The channel started working today.**

ADR-0019.5 shipped at 2:25 PM PT and the container came up at 3:42 PM PT. The first
document-ingestion page Bill has ever received arrived at **4:13 PM PT** — 31 minutes
later. Three more followed by 5:13 PM. All four describe conditions that predate the
deploy.

The proof is in the bytes. `anomalies.ts` builds every doc-ingest page as:

```ts
title: `Document ingestion — ${anomaly.kind.replace(/_/g, ' ')}`
```

That is a literal U+2014. Per ADR-0019.5 that title threw inside undici *before a
socket opened*, identically on the primary and the fallback. So **every
document-ingestion page ever raised was discarded** — the subsystem has been mute
since it shipped. The title that finally landed in ntfy's cache reads:

```
5b44 5233 2d56 6973 696f 6e5d 2044 6f63   [DR3-Vision] Doc
756d 656e 7420 696e 6765 7374 696f 6e 20  ument ingestion
2d20 7377 6565 7020 6661 696c 6564        - sweep failed
      ^^
```

`0x2d` — an ASCII hyphen. That is `toHeaderSafe()` folding the em dash. The alerts
did not change; the sanitizer that lets them out of the process did.

## 2. The defect this ADR fixes

Being mute was ADR-0019.5's bug. **Being mute *and looking fine* is this one's.**

`maybePage()` stamped `last_paged_at` and *then* published, ignoring the result:

```ts
await prisma.docIngestAnomaly.update({ data: { last_paged_at: now } });
await publishNtfy({ ... });   // return value discarded
```

So the ledger recorded an *intention*, never a delivery. Production carries
`sweep_failed` rows stamped as paged on 07-31, 08-01, 08-06, 08-09 and 08-10 with no
corresponding message anywhere in ntfy's seven-day retained cache. The database said
Bill had been told. He had not.

The second-order effect is worse than the lost page. That stamp arms the 24-hour
re-page window — so **a page that was never delivered suppressed its own retry for a
full day.** The recovery mechanism was disabled by the record of its own failure.

This is the same shape the fleet keeps re-learning: *a counter that increments on the
call rather than the outcome lies about delivery.* ADR-0019.5 found it in a swallowed
`catch`; this is the same lie one layer up, told by a database column instead of an
exception handler.

### Fix

Publish first; stamp only on `result.ok`. `ok` covers `sent`, `fallback-sent`,
`cooldown-suppressed` and `unconfigured` — the last two are deliberate local
suppressions that must not spin. Only `dropped` leaves the row unstamped, so the next
sweep retries fifteen minutes later instead of in twenty-four hours.

## 3. A second defect the incident exposed

`download_failed` was resolved only on the **applied** path, below the guardrail
branch. A source that recovered from a download failure but whose new revision the
guardrail **staged** never cleared its anomaly.

TEREX.xlsx did exactly this on 2026-08-11: Graph 503'd at 4:58 PM, the 5:13 PM sweep
downloaded it cleanly, and the revision staged on an aggregate variance. The
`download_failed` row is still open on a source that is downloading perfectly, and
under the 24h re-page it would have paged Bill daily, forever, for a failure that
healed in fifteen minutes.

Whether a revision **applies** is a guardrail decision about content. Whether it
**downloaded** is not. One must not gate the other, so the resolve moves above the
branch, to the point where we are demonstrably holding bytes.

## 4. What was actually wrong with ingestion

Nothing that is still wrong. For the record, the four pages were:

| PT | Kind | Reality |
|---|---|---|
| 4:13 PM | `sweep failed` | Graph 503 on `sharedWithMe`. Next sweep (4:28) clean. |
| 4:43 PM | `discovery gap` | 11 readable docs, 3 watched. **By design** — registration is manual. Open since 08-07. |
| 4:58 PM | `download failed` | Graph 503 on TEREX content. Recovered 5:13 PM. |
| 5:13 PM | `aggregate variance` | TEREX "Day Total Hrs Used" 328.40 → 444.50 (+35.4%). **Staged, not applied — the guardrail working.** Raised 08-10. |

Sweep failure rate is ~1 run per ~96/day, i.e. ~1%, and has been since at least
07-28. Every one self-healed on the next 15-minute sweep. MyMRC sync is unrelated and
clean.

## 5. Consequences

- A page that does not land is retried on the next sweep instead of being recorded as
  delivered. `last_paged_at` now means what its name says.
- Alert *volume* is unchanged and remains ADR-0037-compliant: four distinct
  conditions paged once each, not one condition paging four times.
- **Not addressed here, deliberately.** Two gradings now merit review, and both are
  policy calls for Bill rather than incident fixes:
  1. `sweep_failed` pages `high` on a *single* transient Graph 503 that self-heals in
     fifteen minutes. ADR-0037's third gate ("has the system tried to self-heal
     first?") argues for paging on the second *consecutive* failure. That preserves
     the ADR-0057 D9 guard — a genuinely dead sweep still pages, fifteen minutes
     later — while removing roughly one false page per day.
  2. `subscription_renew_failed` describes a condition the code itself documents as a
     structural Microsoft Graph limit that is **not fixable and must not be "fixed"**
     by granting a broader scope. It re-pages every 24h forever. Under ADR-0037 gate
     one (actionable within five minutes?) it is a dashboard tile, not a page.

  Both were left alone because weakening a correctness guard's sensitivity during an
  incident, without the operator's call, is how guards quietly stop guarding.
