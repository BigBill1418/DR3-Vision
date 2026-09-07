-- ADR-0130 D9 + D10 — the run ledger records WHERE it looked and WHAT it used,
-- and the untokenised production folder_path is re-tokenised.
--
-- ## D10, and why the data fix is a migration rather than a runbook step
--
-- ADR-0102 §5 specified the tokenised folder value
-- `…/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland`, and `resolveMonthlyFolderPath`
-- implements it correctly — a string with no tokens simply comes back unchanged.
-- The CODE shipped. The production ROW never moved. So on 2026-09-01 the file name
-- rolled to SEPTEMBER while the folder stayed `August 2026 Woodland`, and the
-- transport has been asking for September's file inside August's folder ever since
-- (393 consecutive failed polls as of 2026-09-07, last success 2026-09-01 02:55Z).
--
-- That is ADR-0102 §137's own prediction — "a static folder_path is correct for at
-- most one month and then silently wrong" — landing thirty days later because the
-- fix was written but not applied. It is the SECOND incident in this repo whose root
-- cause is "the ADR shipped, the data did not" (docs/adr/PROMISES.md P-63).
--
-- A runbook step would be the third. The re-tokenisation is therefore expressed
-- here, as data, so it cannot be forgotten again: the migration runs in the same
-- init container as every deploy, and the admin surface now REJECTS the untokenised
-- shape on save so it cannot be reintroduced by hand.
--
-- The rewrite is deliberately CONSERVATIVE and idempotent:
--   * only rows whose folder_path contains NO '{' are touched — anything already
--     tokenised is intentional and left exactly as it is;
--   * only a trailing `<MonthName> <YYYY> <rest>` segment is rewritten, and only the
--     month word and the year within it, to `{MONTH_TITLE}` / `{YEAR}`;
--   * a `<YYYY> Daily Logs`-style parent segment has its year tokenised too;
--   * a row with no month name anywhere is untouched (including the empty
--     drive-root default, which is the value every non-Woodland source has).
-- Re-running it is a no-op because the first pass leaves a '{' in the value.

ALTER TABLE "workbook_sync_runs"
  ADD COLUMN IF NOT EXISTS "folder_path_resolved" TEXT,
  ADD COLUMN IF NOT EXISTS "file_name_matched"    TEXT;

COMMENT ON COLUMN "workbook_sync_runs"."folder_path_resolved" IS
  'ADR-0130 D10 - the folder the transport ACTUALLY asked for this poll, after token expansion. The September outage was invisible for six days because nothing recorded this.';
COMMENT ON COLUMN "workbook_sync_runs"."file_name_matched" IS
  'ADR-0130 D9 - the file name actually used, which is not always the one the naming pattern predicted (SEPT vs SEPTEMBER). NULL when nothing was read. `file_name` remains the EXPECTATION.';

-- D10 data fix. Month name + 4-digit year in a token-free path -> tokens.
UPDATE "workbook_sources"
   SET "folder_path" = regexp_replace(
         regexp_replace(
           "folder_path",
           '(^|/)(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})',
           '\1{MONTH_TITLE} {YEAR}',
           'gi'
         ),
         '(^|/)(\d{4}) Daily Logs',
         '\1{YEAR} Daily Logs',
         'gi'
       ),
       "updated_by" = 'system:adr0130-folder-retokenise',
       "updated_at" = now()
 WHERE "folder_path" NOT LIKE '%{%'
   AND "folder_path" ~* '(^|/)(January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{4}';
