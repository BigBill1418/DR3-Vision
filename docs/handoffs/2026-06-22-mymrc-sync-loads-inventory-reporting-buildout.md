> **SUPERSEDED by `2026-06-23-current-state-and-buildout-readiness.md`** (kept for history).

# Handoff: MyMRC sync → loads/inventory/reporting buildout

**Date:** 2026-06-22 · **From:** Claude Code (svdp-dev session) · **For:** claude.ai design + system implementation of the next large-scale buildout.

This session stabilized DR3-Vision's data, stood up backups, and **cracked the MyMRC portal auth** that had been silently broken. The hard, environment-bound discovery is done. What remains is design + build, which is the next phase's scope.

---

## 1. What's ready / decided (don't re-litigate)

- **June data fully reconciled, both sites.** Woodland MTD ties to staff ground truth (11,615 thru 6/19); Eugene complete (June 8 = 252 backfilled). Corrections were applied as **reporting-only adjustments** (`bonus_reporting_adjustments`, ADR-0032) that production-total read paths sum but **no bonus-dollar path touches** — closed-period payroll stayed byte-for-byte frozen (96475¢). Don't disturb this.
- **DB backups now live** (were NONE): nightly encrypted `pg_dump -Fc → restic → R2` (`scripts/dr3-pg-backup.sh`, systemd `dr3-vision-pg-backup.timer`, 03:45 PT, 7d/4w/12m/5y). First snapshot verified. Recovery key (RESTIC_PASSWORD) in 1Password. See `docs/operator/backups.md`.
- **Inventory model decision (operator):** **computed running balance reconciled to periodic physical counts.** on-hand = cumulative inbound − cumulative outbound/processed, periodically corrected against a physical count (`site_inventory_snapshots` already has units_indoor/outdoor/in_processing/total).
- **Branding:** reports are **"SVDP - DR3"**, red/black (#a3151a / #363636 / cream #f7f3ea / gold #ffcc69). NEVER "Society of St. Vincent de Paul" / "Lane County" / "DR3-Vision" in report chrome.
- **Email:** Vision is SVdP, a SEPARATE org from BarnardHQ. Send ONLY from `dr3-vision@svdp.us` (the app's M365 mailer / `scripts/send-svdp-mail.sh`), CC the operator at `bill.barnard@svdp.us`. NEVER a BarnardHQ identity.

## 2. MyMRC scraper — current state

The whole loads/inventory feature is **built but dormant** (tables `inbound_loads`, `expected_loads`, `site_inventory_snapshots`, `load_stacks/photos/concerns`; routes `dashboard/[site]/loads`, `operator/[site]/load`, `admin/production-report`; scraper `src/lib/mymrc/` + `scripts/mymrc-{scrape,cron}.mjs`). 0 rows because the feed never worked.

**FIXED this session:** MRC redesigned the Salesforce portal; old scraper silently failed (logged-out 404 parsed as "0 hauls ok"). **Login now works** (verified live, **no MFA**): `input[placeholder="Username"]` / `input[type="password"]` / `button:has-text("Log in")` — committed in `selectors.ts` (SELECTOR_VERSION 2026-06-22). Per-site creds in `~/.dr3-vision-secrets/mymrc.env` (both sites, valid). Account is now scoped by login ("viewing as DR3 Woodland" + Switch Account), not the old `?recycler=` param.

**Full portal map + data shapes:** see `docs/MYMRC-PORTAL-REDESIGN-2026-06-22.md` (committed). Key data pages (all Lightning datatables): `/s/hauls` (inbound), `/s/processed-materials`, `/s/outbound-materials`, plus `/s/availability`, `/s/report/Report/Recent`.

## 3. Build scope (next phase)

1. **Finish the scraper sync.** Rebuild ingestion for the redesigned portal. STRONG recommendation (operator concurs — "it's all Salesforce"): drive the **Aura / UI-API endpoints with the authenticated session** rather than DOM-scraping Lightning datatables (the redesign just broke DOM scraping for the 2nd time). Pull Hauls → `inbound_loads`/`expected_loads`, plus Processed + Outbound. Per-record detail (weights, unit counts) is on each record, not the list view. Also harden `isLoginPage()` to detect the 404/logged-out state so silent failure can't recur.
2. **Inventory.** Implement the computed running balance (inbound − outbound/processed) feeding `site_inventory_snapshots`, with a reconcile-to-physical-count path.
3. **Data analysis & reporting.** Dashboards/reports over loads + inventory + the (already-reconciled) production data.

## 4. Open items

- `isLoginPage()` hardening (above).
- Eugene 6/12 (144) and 6/19 (181) ran light vs typical ~270 — operator hasn't flagged; verify if a report ever depends on them.
- Confirm RESTIC_PASSWORD saved in 1Password (handed to operator; HSH/op weren't reachable to auto-file).
- The `mymrc-scrape` compose service is paused (profile `mymrc`, container stopped/removed) — re-enable once the parser is rebuilt; also re-add to the noc-master service-registry then.

## 5. Access (for an environment-capable session)

svdp-dev `10.99.0.2` via WG (`ssh bbarnard065@10.99.0.2`, key `~/.ssh/id_ed25519`). Postgres: `docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision`. App image `dr3-vision-app:local` has Playwright+chromium. Deploy = `docker compose build app && up -d` (migrate auto-runs). Repo on box at `~/DR3-Vision`. Secrets in `~/.dr3-vision-secrets/`.

---

> Note: this file was committed to the repo (which ClaudeSync mirrors) rather than written via the ClaudeSync `create_handoff` tool, whose write surface was break-glass-disarmed at handoff time. To use the formal handoff PR mechanism instead, arm the window on bos-hq first.
