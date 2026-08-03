# ADR-0002: Fleet host

**Date:** 2026-05-04
**Status:** Accepted

## Context

The BarnardHQ fleet has multiple hosts, each with assigned roles. DR3-Vision needs a deployment target that has reliable internet, runs Docker, joins the fleet networks, and is monitored.

## Decision

DR3-Vision deploys to **CHAD-HQ**.

CHAD-HQ joins these fleet networks:

- `SVDP-Guardian` — security/observability ingress
- `SVDP-Intranet` — internal service mesh
- `SVDP-Site` — public-facing service mesh

The container `dr3-vision` runs alongside its own Postgres 16 sidecar via docker-compose. Both are part of the swarmpilot_deployer-managed fleet.

## Alternatives considered

- **CHAD-Edge** — less RAM headroom; Postgres + Next.js + Playwright would saturate it during MyMRC scrapes
- **A dedicated VPS outside the fleet** — would lose access to fleet observability (GlitchTip, Loki, Tempo, Grafana) and require separate backup tooling

## Consequences

- DR3-Vision shares CHAD-HQ resources with whatever else CHAD-HQ runs. We must not assume exclusive use.
- A fleet-wide outage of CHAD-HQ takes DR3-Vision offline. This was the trigger for ADR-0006 (offline queue strategy) — operator iPads must keep working through host outages.
- Fleet conventions for env vars, secret management, healthchecks, and log shipping apply. See `docs/FLEET-DEPLOYMENT.md`.

## References

- FLEET-PRIMER (in transcripts/uploads)
- ADR-0006 (offline queue) — depends on this decision

---

## Amendment 1 — 2026-08-03: the "fleet networks" list was never real

The **decision stands**: DR3-Vision runs on CHAD-HQ (10.99.0.2 / `svdp-dev`), and
that is still where it lives.

The Decision section's claim that "CHAD-HQ joins these fleet networks:
`SVDP-Guardian` (security/observability ingress), `SVDP-Intranet` (internal
service mesh), `SVDP-Site` (public-facing service mesh)" is **not accurate and
never was.** Verified against primary sources on 2026-08-03:

- `docker network ls` on CHAD-HQ lists only per-compose-project bridges
  (`dr3-vision_dr3net`, `svdp-guardian_default`, `svdp-intranet_default`,
  `helix-hub_default`, `callvault_default`, …) plus the swarm overlays. There is
  no shared `SVDP-Guardian` / `SVDP-Intranet` / `SVDP-Site` network, and no
  concept of a "security/observability ingress" or "public-facing service mesh"
  network on this fleet.
- This repo's own `docker-compose.yml` declares exactly one network:
  `dr3net` (`name: dr3-vision_dr3net`, driver bridge).
- **SVDP-Site does not run on CHAD-HQ at all.** It migrated to BOS-HQ in the
  2026-04-20 six-stack wave (`noc-master/data/config.yml` `services[]` →
  `svdp-site`, `placement: bos`); the `svdp-web` / `svdp-wp` / `svdp-db`
  containers are on 10.99.0.4.

What is actually true: DR3-Vision is network-isolated on its own compose bridge,
reaches the public internet only via its in-compose `cloudflared` sidecar, and
its co-tenants on CHAD-HQ today are SVDP-Guardian, SVDP-Intranet, Helix-Hub,
CallVault, DroneOpsMap, LodeStar and the VLM analytics tier.

Fleet observability is not a network join either — logs go to stdout and are
shipped by the CHAD-HQ Alloy agent to **BOS-HQ** Loki (moved HSH-HQ → BOS-HQ
2026-05-09, noc-master ADR-0050). See `docs/FLEET-DEPLOYMENT.md` and ADR-0022.
