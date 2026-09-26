# ADR-0139 — A frozen copy is not the document

- **Status:** Accepted, implemented 2026-09-25 (Pacific)
- **Context:** Bill, 2026-09-25 10:27 PM PDT: _"i hope we are still ingesting the docs and
  workbooks - in the path to retiring them all together - where are we on all of that ?
  That is very critical work"_. OPEN-ITEMS § 0.CB. Plan: `docs/plans/workbook-doc-retirement.md`.
- **Extends:** ADR-0067 D1 ("documents stay where they live; Vision reads the live file"),
  ADR-0080 (reachable vs watched), ADR-0037 (grading).

## Context

Document ingestion had reported `ok` with **0 new versions on every sweep since
2026-08-18** (~95 sweeps a day). A zero like that means one of two things: nothing changed,
or the sweep is looking at the wrong thing and calling it success. So it was measured
against Microsoft Graph directly, using the app's own **application** credential. That is
a second identity, independent of the sweep's delegated `docs-dr3@svdp.us` token.

**The sweep was telling the truth about what it watches.** Every one of the 11 watched
documents had a live cTag identical to Vision's stored cTag. Nothing it watched had
changed.

**But 9 of the 11 are Outlook attachment copies**, not the documents:

- They sit in the owner's `root:/Attachments` folder. That is where Outlook uploads a
  file sent "as a OneDrive attachment". Eight are in Kelsey Ruhland's drive and one
  (`DR3 Machine List (2).xlsx`) is in Bill's.
- Every copy is at cTag **revision 2**, made 2026-07-28/29.
- The originals are elsewhere in the same owners' drives, at revisions 68 to 1172. Kelsey's
  `DR3/` tree holds the data-tracking, auditing-tracker, task-list and journal originals;
  the invoices-tracking, outbound-auditing and meeting-notes originals are at her drive root.

ADR-0067 D1's premise (a shared FILE is current state, an emailed attachment is a
snapshot) was violated in exactly the way that ADR warns about. None of our guards noticed:

- cTag comparison, the sweep ledger and reachability all check that Vision keeps up with
  the file it **watches**.
- None asks whether the watched file is the one anyone **edits**.

Also measured: `path_hint` was **empty** for two of the nine copies, while a direct item
GET placed them in `Attachments`. A check that read the column would have found 7 and
reported it confidently.

What was actually missed, by comparing each original's last edit with its copy's creation:

- **One original was edited after its copy:** `DR3 Meeting Notes Log 2026.xlsx` (rev 556,
  2026-08-04 09:30 PDT). It is archive-only (ADR-0104 D8), so no Vision figure depended on it.
- **Every other original was last edited on or before its copy's creation** (2026-05-14 …
  2026-07-29). The workbooks themselves stopped moving, which is the retirement happening,
  not ingestion failing.
- **One live workbook was never watched at all:** `Woodland Stockton Transport Log &
Trailer List.xlsx` (rev 981, last edited 2026-08-14).

## Decision

1. **New anomaly kind `snapshot_source`.** A watched, enabled, active file source is a
   snapshot when:
   - a **direct Graph item GET** places its parent at the drive-root `Attachments` folder
     (`/root:/Attachments`, anchored, so a user folder merely named Attachments deeper in
     the tree does not count); **and**
   - it has not changed in **14 days**.

   The rule is the pair. A copy someone has adopted as their working file keeps moving,
   is live, and never trips it.

2. **One subject for the whole condition** (`discovery:snapshot_sources`), listing every
   copy, its owner and its last change. One page, never nine.
3. **Grade (ADR-0037):**
   - `warning` / `default`, routed to `/admin/doc-ingest`, where both fixes are clicked.
   - Q1: actionable. Share the original and register it, or disable a retired copy.
   - Q2: not customer-visible, so never `urgent`.
   - Q3: cannot self-heal.
   - Q4: one subject.
   - Q5: tier-2 page.
   - **Re-pages weekly**, not daily. The fix waits on a person outside Vision.
4. **Cadence: once a day.** The check runs on scheduled sweeps that start between
   08:00 and 08:29 PT, and on every manual sweep.
   - It is structural and cannot change in 15 minutes except by a human's action.
   - Every sweep would mean about 1,000 extra Graph GETs a day for the same answer.
   - DR3's ntfy helper does not buffer quiet hours, so the window is also what keeps the
     first page off Bill's phone overnight.
5. **Never resolves on an incomplete look.** If any item GET fails, the anomaly stays
   open. "Could not see" is never "clear".
6. **Reports, never acts.** It does not disable copies and does not register originals.
   Registering an original usually needs the owner to **share** it with `docs-dr3@svdp.us`
   first, which is a write in someone else's OneDrive.

## Consequences

- On deploy, the first 08:00 PT sweep raises one `default` page naming the nine copies.
  It clears when each copy is disabled (retired document) or replaced by its registered
  original.
- **Operator action required. This ADR does not fix the data path; it makes the gap
  visible and routes it.** The per-document answer (retire, or re-share the original)
  is in `docs/plans/workbook-doc-retirement.md`.
- **Kelsey's availability ended 2026-08-08** (OPEN-ITEMS § 0.AN). Her account is still
  active: Graph shows the Sept daily log was created under her identity on 2026-08-31 at
  19:06 PDT, and Janette Tomas edits it daily. Eight of the copies, and **every Woodland
  daily log that workbook sync reads**, live in her personal OneDrive. If that account is
  disabled or deleted, two things break. OneDrive retention then applies to all of those
  files. And whatever creates each month's file under her identity stops. That is a bigger
  risk than the snapshot finding. It is recorded as a Bill/IT decision in § 0.CB, not
  solved here.
- `path_hint` is now known to be unreliable for location decisions. Nothing new trusts it.

## Alternatives considered

- **Trust `path_hint`.** Rejected: measured wrong for 2 of 9.
- **Page per document.** Rejected: ADR-0037 Q4. That is nine pages for one conversation.
- **Auto-follow the original** (find the same-named file with the app's `Files.Read.All`
  and watch it). Rejected:
  - it widens the integration's blast radius beyond what was shared with it, which
    ADR-0067 D2 deliberately bounds;
  - name matching is a guess, and a guessed source is the D8 duplicate-identity failure.
- **Run every sweep.** Rejected: cost, and overnight pages. See Decision 4.
