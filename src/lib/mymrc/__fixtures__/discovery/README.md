# MyMRC discovery fixtures — SYNTHETIC (ADR-0057 Phase 0)

**These are NOT live captures.** Unlike the parent `__fixtures__/*` files (real
DR3 Woodland payloads captured 2026-07-03 for ADR-0038), everything in this
`discovery/` folder is **hand-authored synthetic data** built to exercise the
`discovery.ts` enumeration/redaction parser before the first live Phase 0 run.

- Names, ids, emails, and phones here are **invented** (`example.com`, `+1-555-…`,
  "Jane Operator", "Pat Client"). Committing them unredacted is safe — no real
  person or account is represented.
- Salesforce **key prefixes are realistic** (`001` Account, `a2K` Haul_Request__c,
  `005` User, `003` Contact) so prefix cross-linking is tested faithfully.

When the real Phase 0 discovery runs (gated on Bill entering credentials in the
admin surface), `scripts/mymrc-discovery.mjs` writes the genuine per-object
bundles to `__fixtures__/<objectApiName>/` — **redacted** by `redactRecord()` —
NOT into this synthetic folder.

## Files

| File | Purpose |
|---|---|
| `home-getitems-multi.json` | `/s/home` envelope with two `getItems` actions (Account + Haul_Request__c) carrying descriptors + `params.entityName` — the primary enumeration path. |
| `descriptorless-getitems.json` | A `getItems` action with NO descriptor/params (id-prefix-only) — exercises the key-prefix fallback + record cross-link. |
| `account-getrecord-envelope.json` | An `Account` `getRecordWithFields` envelope with nested `Owner`/`CreatedBy` (User) and `Primary_Contact__r` (Contact) — the redaction test target. Business fields (`Name`="DR3 Woodland", `Recycler__c`, `BillingCity`) must survive; person name/email/phone must not. |
| `nav-getnavigationmenu.json` | A `NavigationMenuDataProvider/getNavigationMenu` envelope carrying the live authenticated nav (`menuItems`, incl. a nested `subMenu`). Drives `extractNavMenuHrefs` / `resolveObjectPages`: the seven object slugs survive; Home/FAQs/Support/Reports are filtered. |
| `hauls-list-page.json` | A single OBJECT list page (`/s/hauls`) `getItems` envelope for `Haul__c` — the REAL enumeration source (ADR-0057 Phase 0 fix: objects live on per-object nav pages, not the `/s/home` 404). Exercises `enumerateObjects` pointed at a per-object page. |
