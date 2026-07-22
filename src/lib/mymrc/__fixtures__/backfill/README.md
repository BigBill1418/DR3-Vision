# MyMRC backfill fixtures — SYNTHETIC (ADR-0057 Phase 1 D3)

**Hand-authored, not live captures.** Every record id / offset / title here is
**fabricated** (`a2Kf0000FAKE…`) to exercise the offset-pagination codec
(`list-page.ts`) and the offset transport (`backfill-portal-client.ts`) without
committing any real portal PII. The SHAPE mirrors the CONFIRMED-LIVE
`ListViewDataManagerController.getItems` returnValue captured 2026-07-22
(`recordIdActionsList`, `offset`, `hasMoreData`, `filterTitle`,
`entityLabelPlural`, `isErrorListView`).

| File | Purpose |
|---|---|
| `getitems-page-windowed.json` | A non-final page: `hasMoreData:true`, 3 ids. Drives "loop advances / does not stop". |
| `getitems-page-final.json` | The final page: `hasMoreData:false`, incl. a blank `recordId` the codec must drop. Drives "loop stops + ignores blanks". |
| `getitems-error-listview.json` | `isErrorListView:true` — the codec must throw `PortalContractDriftError` (never a silent empty). |
