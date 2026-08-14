# ADR-0103 — The capture held a page the heal had already closed

**Date:** 2026-08-14 (Pacific)
**Status:** Accepted
**Amends:** ADR-0057 Phase 1 (the `AdminSession` self-heal contract)
**Incident:** 2026-08-13 11:01 PM PT — `[DR3-Vision] MyMRC sync error - woodland [outbound]`

---

## 1. The alert

```
[DR3-Vision] MyMRC sync error - woodland [outbound]
page.waitForTimeout: Target page, context or browser has been closed
fingerprint=mymrc-error:woodland:outbound
```

Priority `high`, topic `dr3-vision-system`, 2026-08-13 23:01:58 PT. The same
fingerprint had fired once before, 2026-08-12 00:01:21 PT. Twice in the seven
days the ntfy cache retains — intermittent, not a storm.

The container log names the whole mechanism in four lines:

```
06:01:43 mymrc: session dropped mid-run — rebuilding a clean session (admin)
06:01:55 mymrc: login submitted (admin)
06:01:57 mymrc: mid-run re-auth recovered on attempt 1/3 (admin)
06:01:58 woodland/outbound FAILED (error) — page.waitForTimeout: Target page, ... closed
```

**The re-auth worked.** One second later the feed died anyway.

## 2. What actually broke

`AdminSession.ensureAuthenticated` recovers a mid-run session drop the way
bootstrap does (ADR-0057): tear the dirty context down, build a fresh one, log
in, re-navigate. `rebuildAndLogin` reassigns the `context`/`page` closure vars in
place, so the session's own methods keep working. Its docstring states the
consequence for everyone else:

> `getPage()`/`getContext()` return the LIVE page/context (the self-heal rebuilds
> the context, so callers **must never cache the reference across an
> `ensureAuthenticated`**).

`backfill-portal-client.ts` `captureListPage` was the one caller that did:

```ts
const page = admin.getPage(); // ← captured once
page.on('request', onRequest); // ← listeners bound to THAT page
page.on('response', onResponse);
await admin.gotoWithRetry(url, 'networkidle');
await admin.ensureAuthenticated(url); // ← may close that page
await page.waitForTimeout(CAPTURE_SETTLE_MS); // ← throws on the corpse
```

A heal closes the context, so `page` is dead and the settle call rejects with
Playwright's `Target page, context or browser has been closed`. That propagates
out of `captureListPage`, out of the feed, and pages Bill.

**This is a contract violation, not a Playwright quirk.** The contract was
written down in ADR-0057 and this caller predates nobody enforcing it.

## 3. The half that would have been worse

Re-reading `admin.getPage()` just before the settle would have stopped the
alert. It would also have shipped a silent data defect.

The listeners are the point of this function. They are bound to the **dead**
page, and the heal does its own re-navigation to the same URL
(`rebuildAndLogin` → `gotoWithRetry(verifyUrl)`) with **nothing of ours
listening**. So a capture patched up that way returns:

- `framework: null`
- `requestMessages: []`
- `responseBodies: []`

…and no error. Downstream, `fetchListPage` would raise
`PortalContractDriftError` on the missing envelope — loud, and only because that
guard already exists. Where an empty capture is merely _thin_ rather than empty,
it under-syncs billing data and says nothing.

**The throw was doing us a favour.** It is the only reason this surfaced at all.
The fix has to restore the capture, not just stop the exception.

## 4. Decision

`captureListPage` runs as a **bounded, replayable pass**:

1. Re-read `admin.getPage()` **inside** each pass — never cached across
   `ensureAuthenticated`.
2. Detect a heal by **page identity** (`admin.getPage() !== page`), not by a
   flag. `ensureAuthenticated` heals silently; the live page no longer being ours
   is the only honest evidence it happened.
3. A healed pass is **discarded and replayed** on the healed page — listeners,
   navigation and settle included — so the capture is real rather than empty.
4. Budget: `MAX_CAPTURE_PASSES = 2`. Pass 2 runs on a session
   `ensureAuthenticated` has already _proven_ authenticated (it throws
   `AuthFailedError` otherwise), so a third pass could only chase a portal
   dropping us faster than we can log in — the deadman's job to report.
5. If the budget is exhausted with the last pass still healed, the capture is
   **discarded, not returned**. That pass did capture traffic, but
   `ensureAuthenticated` only heals when the page reads logged-**out**, so the
   traffic came off an unauthenticated page. Returning empty makes
   `fetchListPage` wedge loud and resumable. Trusting it would under-sync
   silently.

### Alternatives rejected

- **Re-read the page before the settle only.** Fixes the exception, ships the
  silent-empty capture of §3. Rejected: it converts a loud failure into a quiet
  one, which is the wrong direction.
- **Move `ensureAuthenticated` before the listeners attach.** The drop is
  detected _by_ navigating; there is no useful pre-navigation check, and a drop
  can still land during the capture nav.
- **Retry the whole feed one level up.** Re-does the login and every other list
  page to fix one page's capture, and the stale-page throw would still be the
  trigger. Repairing it where the page is cached is narrower and testable.
- **Have `ensureAuthenticated` re-attach caller listeners.** Makes the session
  own its callers' event wiring — the coupling ADR-0057 Phase 1 removed.

## 5. Adjacent defect found while diagnosing: `list-page.ts` was binary

`grep` returned **zero matches for `export`** in a 571-line module that exports
23 symbols. `file` called it `data`, not source.

One **raw 0x00 byte**, written as a literal into a template literal on line 530
as a composite-key separator:

```ts
const dedupKey = `${req.entityName}<NUL>${req.filterName}`;
```

NUL is valid UTF-8, so TypeScript compiled it and every test passed. But `grep`
and `ripgrep` classify a file containing NUL as **binary and skip it silently** —
they report no hits, not an error. Every codebase-wide audit run in this repo has
had a 571-line blind spot in a core MyMRC module, and none of them could have
told us.

Changed to the escape `\u0000` — byte-identical at runtime (verified: normalising
the escape back to a raw NUL reproduces the previous file exactly), with a
comment saying why it must stay an escape.

**Standing rule: control characters in source are written as escapes, never as
literal bytes.** A file that lies to `grep` corrupts every audit that follows it.

The failure mode is easy to re-introduce and gives no feedback: the first draft of
_this ADR_ went out with a literal NUL in the sentence above, and the only symptom
was `grep` going quiet on the file. A repo-wide sweep found no other affected
file (`git ls-files` + NUL scan, 2026-08-14) — and because a rule nobody can see
being broken is not a rule, that scan is now a test:
`src/lib/repo-hygiene.nul-bytes.test.ts` fails the suite on any tracked text file
containing 0x00. Verified adversarially by staging a probe file with a NUL and
watching it fail.

## 6. Consequences

- A mid-run session drop during a list-page capture no longer fails the feed; it
  costs one extra navigation.
- The alert that fired twice in seven days should stop. It was a true positive —
  it just named the symptom (`waitForTimeout`) and not the cause (a cached page).
- `grep`-based audits now see `list-page.ts`. Prior audit results over this repo
  should be treated as having excluded it.
- The `error` alert kind stays exactly as loud as it was. Nothing was silenced.

## 7. Verification

- `backfill-portal-client.capture-heal.test.ts` — 4 tests, driven through a fake
  `AdminSession` whose heal closes the live page and re-navigates itself.
  **Confirmed adversarially**: reverted to the pre-fix source and watched 3 of
  the 4 fail with the exact production string,
  `page.waitForTimeout: Target page, context or browser has been closed`.
- `vitest run src/lib/mymrc/` — 437 passed.
- `tsc --noEmit` and `tsc -p tsconfig.mymrc.json --noEmit` — both clean (the
  MyMRC bundle compiles standalone, alias-less).
