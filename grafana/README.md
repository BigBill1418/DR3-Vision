# DR3-Vision Grafana provisioning

Commit-tracked Grafana artifacts for DR3-Vision, consumed by the BarnardHQ
fleet's Grafana provisioning (ADR-0022 §5/§6). Nothing here runs inside the
app — these are config files the fleet's Grafana watches and imports.

## Files

| File                         | Purpose                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `dashboards/dr3-vision.json` | Dashboard (uid `dr3-vision`). Operational overview, MyMRC integration, Operator iPad path, Bonus Management, cross-cutting panels. |
| `alerts/dr3-vision.yaml`     | Grafana-alerting provisioning rules (`apiVersion: 1`). Critical → ntfy `dr3-vision-system`; warning → in-app only.                 |

## How the fleet consumes these

The fleet Grafana mounts a provisioning tree:

```
/etc/grafana/provisioning/
  dashboards/   # a file provider points at the fleet dashboard registry
  alerting/     # rule + contact-point + notification-policy YAML
```

1. **Dashboard** — the fleet's dashboards provider is configured with
   `foldersFromFilesStructure` / a file-glob that includes each service's
   `grafana/dashboards/*.json`. On change, Grafana re-imports by `uid`
   (`dr3-vision`), so edits update the existing dashboard rather than
   creating duplicates. Keep the `uid` stable.

2. **Alert rules** — `alerts/dr3-vision.yaml` is dropped into
   `provisioning/alerting/`. Grafana loads the rule groups into the
   `DR3-Vision` folder. The Prometheus datasource is referenced by the
   provisioning uid `prometheus` (the fleet's standard scrape datasource);
   expression steps use the built-in `__expr__` datasource.

## Routing (ADR-0022 §6 + docs/COMPLIANCE.md)

Rules carry routing labels; the fleet's shared
`provisioning/alerting/policies.yaml` does the actual contact-point mapping:

- `severity: critical` + `route: ntfy` + `ntfy_topic: dr3-vision-system`
  → contact point that POSTs to `https://ntfy.barnardhq.com/dr3-vision-system`
  with `X-Title: [DR3-Vision] …` and `Authorization: Bearer <publisher-token>`
  (per the fleet ntfy standard / ADR-0036). Pages Bill.
- `severity: warning` + `route: in-app` → silent/in-app contact point. The
  alert fires and is visible in Grafana + the DR3-Vision dashboard, but does
  **not** publish to ntfy. This matches the routing matrix: operational
  events stay in-portal; only system-level events page (ADR-0037 gate).

> The contact points and notification policy live in the fleet provisioning
> tree (not in this repo) because they are shared across services and carry
> the per-service publisher tokens. This repo ships only the rules + the
> routing labels they key on.

## Metric names

Every PromQL expression references the metric names defined in
`src/lib/observability/metrics.ts`. `src/lib/__tests__/grafana-config.test.ts`
asserts the dashboard parses, carries uid `dr3-vision`, and that no expression
references a metric that does not exist in `metrics.ts` (drift guard). Run:

```bash
npx vitest run src/lib/__tests__/grafana-config.test.ts
```
