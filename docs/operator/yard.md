# Yard view (trailer/yard list scaffold, rollup §1.8)

A manager-facing per-site "Yard" view: rental containers (from
`container_rental_sites`), the site's whole-units-on-hand context (latest inventory
balance), and a minimal trailer list you can add to and edit. It is a **scaffold** —
list + add/edit, no workflow.

## Access

- Path: `/dashboard/<site>/yard` (e.g. `/dashboard/eugene/yard`).
- **Born pilot** behind the `yard_list` UI surface (ADR-0047 D7 pattern): until it
  is ramped, only **admins** see it. Site managers see a "not yet activated"
  message. A plain manager reaches only their own site; an admin or `all_sites`
  manager reaches both (hard rule #2).

## What it shows

- **Rental containers** — location, trailer count, size, monthly rate (from
  `container_rental_sites`; seeded empty until Rick enters real rows).
- **Whole units on hand** — the current computed inventory total for the site.
- **Trailers on yard** — rows in `yard_trailers`: label, location note, and status
  (`on yard` / `at account` / `in service`). Add and edit inline (writes are
  audited).

## Ramp

Flip `yard_list` to `live` for a site from `/admin/rollout` (noting the criteria)
when managers should see it. Rollback is a flip back to `pilot`.

## Notes

- No new rental data is entered here — container rentals stay in the billing-rates
  admin surface (ADR-0040). The Yard view only *reads* them.
- `yard_trailers` is a light physical-whereabouts record that
  `container_rental_sites` does not model; it carries no billing.
