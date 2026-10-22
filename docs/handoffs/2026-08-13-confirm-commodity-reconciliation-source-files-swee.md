# 2026-08-12 — Confirm the commodity-reconciliation source files, and sweep the read-only unblockers

**Session context (Bill × Claude, 2026-08-12):**

The Q-2 finding (`docs/q2-commodity-reconciliation-finding-2026-08-12.md`) established that the absorbed commodity tracker is a sign-off log with no numbers, but named two reachable-but-unwatched files that almost certainly carry the real MyMRC-vs-vendor-invoice reconciliation inputs:

- **Woodland Outbound Auditing 2026.xlsx** (461 KB, 2026-07-30) — shipped-loads side; likely per-load weights + amounts.
- **Woodland Invoices tracking.xlsx** (52 KB, 2026-07-29) — invoice side; likely invoice numbers + dollar amounts.

Bill: *"do all that you can via Claude Code."* So this handoff does the **read-only, confirm-and-report** work end to end — turning "likely" into "confirmed", and clearing adjacent read-only unblockers — while stopping firmly short of the two things that are Bill's alone: **wiring Layer B reconciliation** (needs threshold judgment that died with Kelsey) and **the C-47 access-scope decision** (client-PII exposure). Confirm, report, tee up. Do not decide.

**Standing instruction:** re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` on current `main` first; verify premises against live code/DB. And re-read the Q-2 finding — it is the spec for Phase 1.

---

## PHASE 1 — Confirm the two candidate files actually hold reconciliation data (the main task)

The finding stopped short of opening the files' cells because that needs the live Graph token. Doing it **properly and safely** is the job here.

- **Add the two files as watched `doc_sources`** (the finding's recommended cheap step): `Woodland Outbound Auditing 2026.xlsx` and `Woodland Invoices tracking.xlsx`. They are already in `doc_ingest_reachable_items` (readable but unwatched — the sweep's "can read 11, watching 3" anomaly names exactly these).
- **Let the existing classifier + header detection sample them** (ADR-0067 Am.8 header detection — the merged-title-row fix — must be what reads them; verify it resolves real headers, not a banner row).
- **Report each file's ACTUAL columns.** The specific question: do they carry **per-commodity weight, dollar amount, invoice number, and any expected-vs-actual / variance** field? That is the difference between "reconciliation is buildable from files" and "still not enough." Name the real column headers found in each.
- **Cross-file check:** can Outbound (weights/loads) and Invoices (amounts/invoice numbers) be **joined** — is there a shared key (load id, haul number, date+commodity) that would let a reconciliation match a shipped load to its invoice? Report whether the join key exists. This is the crux of whether Layer B is buildable at all.
- **Read-only. Do NOT absorb into a money-touching typed table, do NOT wire reconciliation, do NOT build Layer B.** If sampling requires reading bytes via the live Graph token, that is acceptable **for classification/header sampling only** — the same read the sweep already does for watched files — not a bulk money-data import. If confirming columns genuinely cannot be done without staging money data, STOP and report that boundary rather than crossing it.

**Phase 1 output:** a written confirmation — for each of the two files, the real columns, whether weight+amount+invoice+variance are present, and whether a join key links them. This turns the Q-2 finding from "likely" to "confirmed yes/no," and it is the input to Bill's separate decision on whether to build Layer B.

## PHASE 2 — Resolve the sweep's reachable-vs-watched backlog (read-only triage)

The discovery guard (ADR-0080) is flagging **8 reachable documents that Vision is not watching**. Phase 1 watches 2 of them. For the remaining ~6:

- **List all reachable-but-unwatched files** with name/size/owner/modified from `doc_ingest_reachable_items`.
- For each, state in one line what it likely is and whether it is a candidate for watching (operational data) or should stay unwatched (e.g. anything that looks like client-PII / case management — which loops to C-47, do NOT watch those).
- **Do NOT auto-watch them.** Produce the triage list; Bill decides which to add. The point is to convert a vague "8 unwatched" alarm into a named, decidable list.

## PHASE 3 — Verify the batch (#256) actually landed clean

PR #256 (the quota-digest / renumber / F-1 / F-4 batch) shipped fast. Confirm on live `main`, and report any gap:

- **Quota digest (ADR-0071 Am.2):** confirm `enabled=true` for Woodland, `min_misses=3` on the live config row (not just the schema default), the daemon anchor is 20:00 PT, `latestDueMonFriWeek()` targets the current Mon–Fri week, and `bill.barnard@svdp.us` is an active recipient. Confirm the next scheduled send is **this Friday 20:00 PT**. If any of these is only half-applied, fix it.
- **ADR renumber:** confirm 0078/0087/0097/0098 collisions are resolved, no dangling cross-references remain (grep), and **no migration name was altered**.
- **F-1:** confirm COR headcount renders a real number or "not recorded", never `—` or a false 0.
- **F-4:** confirm the stale migration reference is documented, table untouched.
- Report a green/red per item.

## PHASE 4 — Surface, don't fix: the two decisions that are Bill's

Do NOT act on these — just produce a crisp one-paragraph decision brief for each so Bill can decide quickly next session:

- **C-47** — the `docs-dr3` account can enumerate 11,403 files across 42 SharePoint sites including Night Shelter client-PII. State precisely what scope (`Sites.Read.All` vs narrower) doc-ingest actually needs based on what it reads today, so Bill can decide the narrowing. Investigation/brief only — no permission changes.
- **VLM equipment proposal (ADR-0087)** — one paragraph: what it proposes, what it would cost, what it unblocks, and the open question for Bill.

---

## Actions for Claude Code

1. Re-read CHANGELOG + OPEN-ITEMS + the Q-2 finding on main.
2. **Phase 1:** watch the two candidate files; sample columns via the existing classifier/header detection; report real columns + whether weight/amount/invoice/variance exist + whether a join key links Outbound↔Invoices. Read-only; build no Layer B.
3. **Phase 2:** produce the named triage list of the ~6 remaining reachable-but-unwatched files; recommend watch/don't-watch each; auto-watch nothing; keep anything PII-looking unwatched (C-47).
4. **Phase 3:** verify #256 landed clean on live main, item by item, fix any half-applied piece, report green/red.
5. **Phase 4:** write the C-47 and ADR-0087 decision briefs; change nothing.
6. Tag Bill with: the Phase 1 column confirmation (the headline — is Layer B buildable from files?), the Phase 2 triage list, the Phase 3 verification, and the two decision briefs.

**Do NOT:**
- Do NOT build, wire, or stage Layer B reconciliation — Phase 1 confirms data exists; building is Bill's separate call.
- Do NOT import bulk money data from the two files — classification/header sampling only.
- Do NOT auto-watch the remaining unwatched files — triage list only.
- Do NOT watch or sample anything that looks like client-PII / case management — that is C-47, Bill's decision.
- Do NOT change any Graph API permission scope — C-47 is investigation/brief only.
- Do NOT alter any migration name while verifying the renumber.
- Do NOT decide C-47 or the VLM proposal — brief only.

## Success criteria

- For each of the two candidate files: real columns reported, and a clear yes/no on whether per-commodity weight + amount + invoice + variance are present and joinable — i.e. **is Layer B buildable from files?** answered with evidence.
- The reachable-but-unwatched backlog is a named, decidable list, nothing auto-watched.
- #256's five outcomes are each verified green on live main (or fixed + reported).
- C-47 and ADR-0087 each have a one-paragraph decision brief ready for Bill.
- Nothing money-touching was wired, no PII was sampled, no permission scope changed.

## For Bill

The one answer that matters here: after Phase 1 you will know whether the commodity reconciliation you thought died with Kelsey is buildable from two spreadsheets that were sitting unwatched the whole time. If the columns are there and they join, Layer B is back on the table — it just needs you (or Rick) to set the variance thresholds empirically over a few months instead of inheriting Kelsey's. If the columns aren't there, you will know that too, with evidence, and can stop chasing it. Everything else in this handoff is read-only cleanup and two briefs teed up for your call.
