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
