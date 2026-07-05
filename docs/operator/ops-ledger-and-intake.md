# Ops ledger, Updates digest & contact intake (ADR-0045)

Operator runbook for the P5 surfaces: the meeting-notes / task ledger, the DR3
Updates + board-pack digests, and the website contact-form intake. No new
container or cron — everything rides the existing daily-report tick.

## 1. Ops ledger — `/dashboard/[site]/ops`

- **Who sees it:** any manager of the site, an all-sites manager, or an admin
  (hard rule #2 reach). Managers see their own site's rows; admins and all-sites
  managers also see **org-wide** items (rows with no site).
- **Notes:** free-form meeting/ops notes. A note can spawn **action items**, which
  become `open` tasks in one motion (created in a single transaction with the note).
- **Tasks:** the follow-up queue, filterable by status and "overdue only". Mark a
  task **Done** / **Drop** / **Reopen** — every transition is written to the audit
  log. The tile at the top shows **overdue** and **due-today** counts.
- **Reminders are in-app + digest only, never a push** (hard rule #5). Overdue /
  due-today tasks appear on the tile and as a **Follow-ups due** section in the
  existing daily digest email — which now sends when there are open findings OR due
  tasks (a quiet day still sends nothing).

## 2. Updates digest & board pack — `/dashboard/ops/digests`

- **Who sees it:** admins and all-sites managers only.
- **Vision drafts; a human sends.** Vision auto-generates a DRAFT — it never sends
  these and never impersonates anyone.
  - **Weekly DR3 Updates:** generated every Monday for the prior week
    (production totals, inbound/outbound movement, open-findings count, completed
    follow-ups).
  - **Board pack (Bethany's cadence):** generated on the **2nd Wednesday** of the
    month **and the Monday preceding it** — processed previous-month + month-to-date
    per site, year-over-year where history exists, and big equipment cost events.
- **Idempotent:** re-generation is a no-op per period, so your edits are never
  clobbered. The board pack fires on two dates but only ever produces one draft.
- **Workflow:** open a draft → edit the markdown → **Save draft** → **Finalize**
  (audited) → **Copy HTML to clipboard** → paste into your own mail and send.
  Morena owns the Updates send; Bethany owns the board send. There is no send
  button anywhere on this surface by design.
- **Equipment events** currently show "unavailable" until the ADR-0044 equipment
  module is merged in — this is expected and harmless.

## 3. Contact-form intake — `POST /api/intake/contact`

Public, token-guarded endpoint the website contact form posts to. A submission
becomes a routed follow-up **task** and a notification email to the routed person.
A tour goes to Rick; everything else goes to Morena (seeded, editable in
`contact_routes`). A submission is never lost: even an unroutable topic is held as
a task.

### 3.1 Provision the secret (required — fail-closed)

The endpoint returns **503 and accepts nothing** until `INTAKE_TOKEN` is set.

1. Generate a token: `openssl rand -hex 32`
2. Add it to the production secrets file on CHAD-HQ,
   `~/.dr3-vision-secrets/intake.env`:

   ```
   INTAKE_TOKEN=<the-hex-token>
   ```

   (compose loads it via `env_file`, `required:false` — but the endpoint refuses
   until it is present).
3. Restart the DR3-Vision service so it picks up the env
   (`docker service update --force dr3-vision_web`, per fleet convention — never
   restart the Docker daemon).

### 3.2 Wire the WordPress form (operator/webhook action — NOT Vision code)

On the SVdP WordPress site, configure the contact-form plugin (e.g. WPForms /
Fluent Forms webhook, or a small `wp_remote_post`) to POST JSON to:

```
POST https://dr3-vision.svdp.us/api/intake/contact
Content-Type: application/json
x-intake-token: <the-hex-token>

{
  "topic":   "<the form's subject/category>",
  "message": "<the visitor's message>",
  "name":    "<optional>",
  "email":   "<optional>",
  "phone":   "<optional>",
  "source_form": "website-contact",
  "website": ""        // HONEYPOT — must be an empty, visually-hidden field
}
```

- **Honeypot:** add a hidden `website` field the form leaves blank. Bots fill it;
  a filled honeypot is silently accepted (HTTP 200) and dropped.
- **Routing:** `topic` drives the route. Seeded rules: `tour*` → Rick, `*` →
  Morena. To add/adjust routes, edit `contact_routes` (topic_match supports an
  exact match, a `*`-suffix glob, or the `*` catch-all; lowest `priority` wins).
- **Responses:** `201` accepted · `200` honeypot (silent) · `422` invalid body ·
  `401` bad/missing token · `429` rate-limited · `503` `INTAKE_TOKEN` unset.

### 3.3 PII & retention

`name` / `email` / `phone` / `message` are visitor PII. They are **never logged**
(logs carry row ids + the topic only), are excluded from every export surface, and
are retained per a documented window (default 2 years). The routed **notification
email** does carry the details — that is the delivery, and it is intentional.

### 3.4 Rate limit

Per-IP fixed window (5 / minute) in process memory — hygiene, not a security
control (the token + honeypot are). It is per-replica and resets on restart; if
this route is ever scaled past one replica, move the limiter to a shared store.
