# ADR-0102 — The transport that could never find a file

**Date:** 2026-08-12 (Pacific)
**Status:** Accepted
**Amends:** ADR-0049 (workbook sync) — D5 rollover, and the D2/D4 Graph transport
**Incident:** 2026-08-12 ~7:14 AM PT — a `status=not_found` page for DR3 Woodland:
_"672 consecutive failed poll(s); last successful read NEVER."_

---

## 1. The page was right about the symptom and wrong about the cause

The alert said:

> The file was not found — check for a rename, a typo, a stray copy, or a moved folder.

Every one of those is a thing to check on Kelsey's end. None of them was true.
**`AUGUST 2026 DAILY LOG WOODLAND.xlsm` was sitting in its folder, 710,386 bytes,
modified 2026-08-12 02:45 UTC — 7:45 PM PT the previous evening.** The floor had
been filling it in all along.

The run ledger is unambiguous: **1,098 polls between 2026-07-31 13:02 UTC and
2026-08-12 14:18 UTC, every single one `not_found`, `last_success_at` NULL.** Not a
regression — this source has never once succeeded.

There were **two independent defects**, and either alone is sufficient to produce
exactly this page. That is why fixing the obvious one changed nothing.

## 2. Defect A — the drive_upn was a SharePoint URL, not a UPN

`workbook_sources.drive_upn` held **`kelsey_ruhland@svdp.us`** — an underscore
where the account has a dot. Graph's answer is not ambiguous:

```
GET /users/kelsey_ruhland@svdp.us/drive
→ 404  ResourceNotFound: "User not found"
```

The real account is **`kelsey.ruhland@svdp.us`**, which resolves to drive
`b!4CzvoBCatkKoV1oZd9MkhSzOViAhiXNFthpKKUzGJEHt66jhPKMvTLNpGh1zvpwT`, owner
"Kelsey Ruhland".

The underscore is not a typo so much as a **transcription of the wrong
identifier**. SharePoint renders a personal site as
`…-my.sharepoint.com/personal/kelsey_ruhland_svdp_us`, flattening `.` and `@` to
`_`. Someone read the UPN out of that URL. It looks exactly like an email address
and is not one.

**And the transport could not say so.** `graphJson` maps any 404 to
`{ value: [], notFound: true }`, and `listFolder` turns that into `[]` —
_"missing folder ⇒ empty, never a throw (D5)"_. That rule is correct for a month
whose folder does not exist yet. It is badly wrong for a user who does not exist:
**"this account is not real" and "this month's file isn't created yet" become the
same empty list**, and the alert then confidently recommends hunting for a
renamed file. Six weeks of looking in the wrong place follow from one collapsed
distinction.

## 3. Defect B — `$select` omitted the facet the code branches on

This is the fatal one, and it is why correcting the UPN did **not** fix the poll.
With the right account and the right folder, the very next poll still returned
`not_found`.

```ts
const FILE_SELECT = 'id,name,cTag,size,lastModifiedDateTime';   // ← no `file`

function toDriveFile(raw: RawDriveItem): DriveFile | null {
  if (raw.file === undefined || raw.file === null) return null; // "folder, not a file"
  …
}
```

`$select` returns **only** the properties it names. `file` was never among them,
so `raw.file` was `undefined` on every item, so `toDriveFile` classified
**everything as a folder** and returned null for all of it. Measured against the
live folder:

| `$select`                          | items returned | kept by `toDriveFile` | `getFile(…)`         |
| ---------------------------------- | -------------- | --------------------- | -------------------- |
| shipping (`…lastModifiedDateTime`) | 3              | **0**                 | `null` → `not_found` |
| with `file,folder`                 | 3              | **1**                 | **found**            |

`listFolder` could not return a file **for any folder, in any drive, ever**.
Every consumer — the poll, the D8 archival sweep — was reading an empty world.
"Last successful read NEVER" is not a coincidence; it was the only possible
outcome.

### Why no test caught it

`graph-transport.ts` carried the comment _"UNTESTED by unit tests (no creds in
CI); the mock is the tested path."_ And `mock-transport.ts` stores ready-made
`DriveFile` objects and hands them straight back. It models the transport's
output shape and nothing whatsoever about Graph's request semantics — it has no
concept of `$select`, so under the mock every field is always present.

**A double more permissive than the real dependency cannot fail on the bug it
exists to catch.** The mock was green for six weeks against a transport that
could not find a file.

## 4. The fix

**Defect A** is a data fix on the one row (§6), plus the observation in §7 that
the 404 collapse must stop lying.

**Defect B** is two changes in `graph-transport.ts`:

1. `FILE_SELECT` gains `file,folder`. `folder` is selected as well so
   file-vs-folder is a **positive test on both sides** instead of an inference
   from one absent field — inference from absence is what let this pass as a
   legitimate answer.
2. `listFolder` **throws `FilesContractDriftError`** when a page comes back with
   items of which _none_ carries either facet. We asked for both, so that state
   means the select was dropped or the contract moved — and the symptom of not
   catching it is an empty folder, which is indistinguishable from a correct
   answer. Checked per page and only when items exist, so a genuinely empty
   folder stays empty and one odd item (a package, a shortcut) cannot trip it.

New `graph-transport.test.ts` drives the real transport against a fetch double
that **honours `$select`** — returning only the named properties, as Graph does.
That one fidelity detail is the difference between a test that can fail and one
that cannot. All four behavioural assertions fail against the shipped select.

## 5. The rollover was only half automated

ADR-0049 D5 promised: _"On 8/1 the same pattern resolves August's file WITHOUT a
config change."_ It templated the file NAME. It assumed every month's workbook
sits in one fixed folder.

Woodland does not work that way. The real layout is month-scoped **and**
year-scoped:

```
DR3/Woodland/Woodland Operations/2026 Daily Logs/August 2026 Woodland/
    AUGUST 2026 DAILY LOG WOODLAND.xlsm
```

So a static `folder_path` is correct for at most one month and then silently
wrong — **a `not_found` every 1st, forever**, phrased as though the file had been
renamed. Fixing only the UPN and pinning the literal August folder would have
re-broken this on 1 September.

`resolveMonthlyFolderPath` expands the same `{MONTH}` / `{MONTH_TITLE}` /
`{YEAR}` tokens in the path, and the engine expands it with the **same
`monthAnchor`** it already computes for the file name. That anchor is
`isGrace ? priorMonthAnchor(started) : started`, so the ADR-0049 Am.4 B1 grace
window reads the prior month's file out of the **prior month's folder** for free,
rather than hunting last month's name in this month's directory. A token-free
path — including the empty-string drive-root default — is returned unchanged, so
every other source behaves exactly as before.

Verified against the live drive across the boundary:

| Poll date  | Expanded folder                             | Result                              |
| ---------- | ------------------------------------------- | ----------------------------------- |
| 2026-08-12 | `…/2026 Daily Logs/August 2026 Woodland`    | **file present**                    |
| 2026-09-01 | `…/2026 Daily Logs/September 2026 Woodland` | folder exists, file not yet created |
| 2026-12-15 | `…/2026 Daily Logs/December 2026 Woodland`  | folder exists                       |
| 2027-01-05 | `…/2027 Daily Logs/January 2027 Woodland`   | folder does not exist yet           |

September through December 2026 are **already created**, so rollover is now
genuinely hands-off for the rest of the year. The January 2027 year-folder does
not exist yet, which is the same benign case D5 already handles: a missing folder
is a `not_found` no-op inside the grace window, and it resolves the moment
somebody creates `2027 Daily Logs`.

## 6. What changed in production

`workbook_sources` row `eb16135b-9577-4f75-b1ec-50a83588981a`:

| field            | before                   | after                                                                              |
| ---------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `drive_upn`      | `kelsey_ruhland@svdp.us` | `kelsey.ruhland@svdp.us`                                                           |
| `folder_path`    | `''` (drive root)        | `DR3/Woodland/Woodland Operations/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland` |
| `naming_pattern` | _(unchanged)_            | `{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm`                                           |

The naming pattern was **always correct** — the engine resolved
`AUGUST 2026 DAILY LOG WOODLAND.xlsm` on all 1,098 failed polls, which is exactly
the name of the file it could not see.

An `audit_log` row under `system:woodland-workbook-sync-repair-adr0102` carries
the before/after, the diagnosis and the evidence.

## 7. Consequences, and one thing deliberately left open

- The transport can find files. This is the first time that has been true.
- `not_found` now means the file is not there, because the two conditions that
  used to masquerade as it are gone.
- **Still collapsed, and it should not be:** a 404 on the _drive_ is reported
  identically to a 404 on the _folder_. A nonexistent `drive_upn` is a
  configuration error that no amount of checking for renames will fix, and it
  should say so rather than recommending a search of somebody's OneDrive. The
  narrow fix is to probe `/users/{upn}/drive` when a listing 404s and raise a
  distinct status. **Not done here** — it is a new status through the engine, the
  ledger and the alert copy, and this change is already load-bearing. Filed as
  follow-up; the §2 evidence is the reproduction.
- `driveUpn` is validated as `z.string().min(3)` at the admin API, which accepts
  a SharePoint URL fragment happily. A registration that cannot resolve should
  not be storable — also follow-up, and the cheaper half of the same problem.
- D8 archival now sees one month per run where the folder is month-scoped,
  instead of a flat folder holding every month. Narrower than D8 assumed, stated
  plainly in the code, and still correct for fixed-folder sources.
- DR3 Woodland is **not** cut over (no `rollout_surfaces` row), so this sync is
  live and load-bearing, not legacy.
- It is the **only** `workbook_sources` row, so no other registration carries the
  never-succeeded signature. The three doc-ingest sources (TEREX.xlsx, Woodland
  Data Auditing Tracker (1).xlsx, Woodland Trailer list.xlsx) are a different
  subsystem on different credentials and are unaffected.
