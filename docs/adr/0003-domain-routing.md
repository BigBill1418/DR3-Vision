# ADR-0003: Domain & routing

**Date:** 2026-05-04
**Status:** Accepted

## Context

DR3-Vision needs a public domain reachable from operator iPads (which connect over both site WiFi and cellular) and from manager browsers in the office. SVdP owns `svdp.us`. The fleet uses Cloudflare DNS and Cloudflare Tunnel for ingress.

## Decision

The public hostname is **`dr3-vision.svdp.us`**.

Routing:
- **Root `/`** — placeholder landing page until a meaningful root view is decided
- **`/login`** — manager/admin email-password login
- **`/operator`** — iPad PWA entry point (name picker → PIN keypad → workflow)
- **`/portal`** — manager browser portal (live dock view, load list, dashboards, exports, audit)
- **`/admin`** — admin-only routes (user management, cross-site analytics, audit deep dive)
- **`/api/*`** — JSON API routes used by the frontend
- **`/healthz`** — health check (returns 200 OK and a `{ ok: true }` body); used by fleet monitoring
- **`/metrics`** — Prometheus metrics scrape endpoint, internal-only

## Alternatives considered

- **Subdirectory under `svdp.us/dr3-vision`** — would conflict with WordPress routing on the main site and complicate cookie scoping
- **Separate domain like `dr3vision.com`** — extra cost, extra cert management, no benefit; SVdP staff already trust `svdp.us`

## Consequences

- TLS terminates at Cloudflare. The fleet tunnel forwards plain HTTP from the edge to CHAD-HQ over the encrypted tunnel.
- Cookie scope: `dr3-vision.svdp.us` (subdomain-scoped). No sharing of session cookies with the main `svdp.us` site.
- HSTS, CSP, X-Frame-Options enabled at the application layer.
- Operator iPads bookmark `https://dr3-vision.svdp.us/operator` and "Add to Home Screen" — this becomes the PWA install.

## References

- Charter §2 (Project context), §5.1 (Security)
- FLEET-PRIMER (Cloudflare tunnel conventions)
