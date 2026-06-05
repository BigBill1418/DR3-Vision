# Sprint 2 handoff

This is the orientation document for the Sprint 2 multi-agent dispatch. Read this first, then proceed in the order below.

## What Sprint 2 ships

1. **Bonus Management System** — daily mattress-count entry for Woodland processors, dual signature workflow, automated payroll-PDF delivery via Microsoft Graph
2. **Vision Dashboard** — tile-based authenticated landing at `/`, replacing the current "coming soon" placeholder
3. **Full fleet observability** — OpenTelemetry traces, GlitchTip errors, Loki logs, Prometheus metrics, Grafana dashboards (originally T-018, deferred from Sprint 1, now Sprint 2 core)

## Read order — every Claude Code agent reads these in sequence

```
1. CLAUDE.md                                          (project-wide rules, unchanged)
2. PROJECT-CHARTER.md                                 (master spec, unchanged)
3. SPRINT-2-HANDOFF.md                                (this file)
4. docs/SPRINT-2-PLAN.md                              (your ticket assignments)
5. docs/adr/0019-bonus-management-system.md           (locks all bonus decisions)
6. docs/adr/0020-vision-dashboard-tile-landing.md     (locks landing UX)
7. docs/adr/0021-m365-graph-mail-send.md              (locks email infrastructure)
8. docs/adr/0022-fleet-observability-wire-in.md       (locks observability)
9. prisma/schema.prisma.bonus.patch                   (schema additions)
10. Existing repo state                               (especially src/lib/auth.ts, src/instrumentation.ts, src/middleware.ts — touched by multiple Sprint 2 tickets)
```

Total reading: ~5,000 lines. Plan ~30 minutes per agent before coding.

## Wave structure (multi-agent dispatch)

Tickets execute in **waves**. All tickets within a wave can run in parallel. The next wave starts when the current wave is complete.

- **Wave A (4 tickets):** Foundation — schema, formula fix, OTel SDK, GlitchTip SDK
- **Wave B (6 tickets):** Bonus core + landing + observability — employees, daily entry, state machine, dashboard, logging, metrics
- **Wave C (6 tickets):** Signatures + PDF + delivery + grafana — signature capture, override, PDF gen, EOD ntfy, M365 mail, Grafana JSON
- **Wave D (3 tickets):** Amendment + history — admin amendment, historical browsing, aggregates
- **Wave E (6 tickets):** Polish + verification — profile photo, health pill, docs, operator residuals, go-live checklist

The critical path is ~6 hops; parallel dispatch should compress wall-clock time substantially. Full ticket detail in `docs/SPRINT-2-PLAN.md`.

## Hard rules — apply to every Sprint 2 ticket

In addition to the project-wide hard rules in `CLAUDE.md`:

1. **Bonus routes are Woodland-scoped.** Rick (Eugene manager) gets 403 on every `/bonus/*` route. The site scope is checked at the page layer, not just the API layer.
2. **State transitions go through the state machine.** Never write directly to `bonus_months.state` or `BonusDailyEntry` from outside `src/lib/bonus/state-machine.ts`. The state machine enforces the legal transitions and writes the audit log entries.
3. **Bonus calculations come from `processor_bonus_rules`.** Never hardcode formula constants in TypeScript. The seed CSV is the source of truth for formula parameters; UI and PDF both pull from it via the same calculator.
4. **PDF generation does not happen in the request path.** It runs as a side-effect of the second-signature transition, in a background-safe context (a server action or queue worker). The signing user does not wait for PDF to complete.
5. **M365 mail-send is fail-open.** If `AUTH_MICROSOFT_ENTRA_ID_*` or `M365_MAIL_FROM_ADDRESS` env vars are unset, the mail-send function logs and returns — does NOT throw. Same pattern as ntfy publisher.
6. **Observability is fail-open.** If `GLITCHTIP_DSN` or `TEMPO_ENDPOINT` are unset, the SDK initialization no-ops cleanly. Same pattern as the existing ntfy publisher.
7. **`/metrics` endpoint is internal-only.** Middleware rejects requests carrying a `cf-connecting-ip` header. Prometheus scrapes from inside the fleet network. If a request reaches `/metrics` via the public tunnel, return 404. **Verify this manually before considering T-109 done.**
8. **Vision Dashboard tiles are role-aware.** Hidden, not greyed. A user who can't access a tile does not see it at all. Coming Soon tiles are different from hidden tiles — they appear to everyone authorized to use the dashboard.
9. **No browser storage for bonus data.** Same rule as the rest of the project. IndexedDB only for the operator iPad PWA shell — bonus entry is desktop/landscape iPad, server-rendered, no offline queue.
10. **Audit log captures every bonus state transition.** Including override events with their override actor + reason. Including amendments with the prior state.

## Risk-and-mitigation table

Already in `docs/SPRINT-2-PLAN.md` at the bottom. Read it before starting.

## What's NOT in Sprint 2

These are explicitly out of scope. Do not let scope creep introduce them:

- Eugene bonus management (schema is site-scoped; future drop-in)
- Real-time multi-user collaborative editing on the bonus entry grid
- Mobile-first bonus entry UI (manager dashboard is desktop / large iPad landscape)
- Two-factor confirmation on signature (Entra MFA already enforces this at the session level)
- MRC API integration (still pending Sam's team's design)
- Photo annotation canvas re-tackle (still V2.1)
- ES + UR native-speaker translation review (still V2.1; bonus UI is admin English per ADR-0017 precedent)
- Operator-side iPad surface changes (operators don't touch bonus; their PIN flow is untouched)

## Operator-side residuals (Bill or SVdP M365 admin)

Two ticket groups in Wave E require human action outside Claude Code:

- **T-122:** M365 mailbox creation + permission grant + Application Access Policy + secret rotation. See `docs/operator/m365-mail-send-setup.md`.
- **T-123:** Fleet observability env var drop + Prometheus scrape config + Grafana dashboard provisioning + alert routing. See `docs/operator/fleet-observability-setup.md`.

The code work in T-100–T-121 can complete in parallel with these residuals. The go-live checklist in T-124 verifies the residuals are done.

## Definition of "Sprint 2 complete"

When the T-124 go-live checklist is fully `[x]`:

- Bonus Management is live in production
- Janette has entered daily counts for a full month
- A test month has been signed by Janette and Morena, PDF generated and delivered to a test recipient
- Bill has tested the amendment flow
- Bill has received an EOD ntfy on a simulated missed-entry day
- All fleet observability subsystems are green in Grafana
- The Vision Dashboard renders correctly for all four user types (admin / both-sites manager / Woodland manager / Eugene manager)
- The "coming soon" placeholder at `/` is gone

Then announce to Janette + Morena + Kelsey.

## Questions

Use `docs/QUESTIONS.md` (existing convention from Sprint 1). Append new questions, don't edit resolved ones.

For Sprint 2-specific questions about scope or design intent, the ADRs are authoritative. The charter has not been updated yet to reflect Sprint 2 — that's T-121's job.
