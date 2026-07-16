# File Drop — the admin capture inbox (O-2)

**What it is.** A raw file inbox at **`/admin/file-drop`** (admin-only). Drop ANY
file — an invoice PDF, a monthly workbook, a CSV export, a phone photo, a zip —
and the system reliably **stores it in R2 and records a manifest row**. That's the
whole job: capture. It parses nothing, routes nothing, promotes nothing.

**Why it exists.** Per Bill's directive (O-2, 2026-07-16): _"just allow me to
upload [files] in the vision portal and then you can settle out what they are and
where they belong and handle all of the details — I can just dump the data
there."_ So Bill dumps; **Claude Code (a human operator, later) does the
downstream classification and routing** by reading the manifest and downloading
each object.

## How to use it (Bill)

1. Open **File Drop** (its own dashboard tile, or from the **Admin** hub).
2. Drag files onto the dropzone (or click to pick — multi-select is fine). Any
   type, up to **100 MB** each.
3. Click **Upload**. Each file is stored and appears in the list below.

That's it. You don't have to name, sort, or file anything.

## How to use it (downstream router — Claude Code)

Each manifest row shows the filename, size, content type, a best-effort
**detected-kind hint**, who uploaded it, and the time (Pacific). Per row you can:

- **Download** the original object (short-lived presigned R2 link).
- Set the status to **Routed** (you've filed it where it belongs) or **Discarded**
  (not needed), or **Reopen** back to Received.
- **Edit the note** to record what you did with the file.

Every create and every status/note change is written to the append-only audit log
(`table_name = file_drops`).

### Detected-kind hint (advisory only)

`detected_kind` is a hint, **never a router**. Mapping:

| Match                  | Hint           |
| ---------------------- | -------------- |
| `.xlsm` / `.xlsx`      | `workbook`     |
| `.pdf`                 | `pdf_document` |
| `.csv`                 | `csv`          |
| content-type `image/*` | `image`        |
| anything else          | `other`        |

You always make the real call per file.

## Where things live

- **Objects:** R2, keyed `file-drops/<id>/<sanitized-filename>` (private; the app
  never proxies bytes — the browser fetches via presigned URL).
- **Manifest:** Postgres `file_drops` (migration `20260724_admin_file_drops`,
  additive / ADR-0035 clean-replay).
- **R2 fail-soft:** if R2 is unconfigured at capture, the row still records with a
  non-fetchable `pending-r2-filedrop-…` placeholder key (the list shows
  "Not stored") so capture never silently fails. Re-upload once R2 is provisioned.
- **Discoverability:** an admin-only **File Drop** dashboard tile
  (`src/lib/dashboard-tiles.ts`) plus a link on the **Admin** hub.

## Retention

**Left open.** No automatic purge is defined yet — objects and manifest rows
persist until an operator decides on a retention policy. Discarding a row is a
status change, not a delete; it does not remove the R2 object.
