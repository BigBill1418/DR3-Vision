# ADR-0021: M365 Graph mail-send for payroll PDF delivery

**Date:** 2026-06-05
**Status:** Accepted
**Extends:** ADR-0016 (Microsoft Entra ID SSO)

## Context

The Bonus Management System (ADR-0019) generates a signed PDF that must be reliably delivered to `payroll@svdp.us` once both signatures land. This is a payroll-critical instrument — late delivery means a delayed pay cycle for Woodland processors.

Two delivery paths were considered:

1. **External SMTP** via a third-party service (Resend was the original handoff scaffold). Same-domain delivery `svdp.us → svdp.us` from a third-party origin server triggers extra spam scrutiny — SPF/DKIM checks may pass, but receiving Exchange Online filters often quarantine same-domain mail from non-Microsoft IPs as a textbook spoofing pattern.

2. **Microsoft Graph API** via the existing Entra tenant. Intra-tenant delivery `dr3-vision@svdp.us → payroll@svdp.us` is recognized by Exchange Online as same-organization mail, bypassing most external spam filtering. Free with existing M365 licensing. Audited in Exchange message trace independently of DR3-Vision's own logs.

Bill's call was the second path. This ADR captures the decision and implementation contract.

## Decision

DR3-Vision sends the monthly bonus PDF (and any future system-generated emails) via **Microsoft Graph `POST /users/{from-mailbox}/sendMail`**.

### Authentication model

**Application permission** (not delegated). The DR3-Vision Entra app authenticates as itself using its client ID + client secret (or certificate; client secret in V2, certificate rotation for V2.1+). No user is in the loop for sending.

The token is acquired against the OIDC v2.0 endpoint:

```
POST https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token
  grant_type=client_credentials
  client_id=<dr3-vision app client id>
  client_secret=<from .env>
  scope=https://graph.microsoft.com/.default
```

Tokens are cached in-process with a refresh margin of 5 minutes before expiry. No persistent token store needed — re-acquiring is cheap and avoids credential-storage risk.

### App registration extension

The existing DR3-Vision Entra app registration (ADR-0016) gains one new application permission:

- **`Mail.Send`** (application, not delegated) — admin-consented once by SVdP's M365 tenant administrator

The existing permission is preserved:

- **`User.Read`** (delegated, from ADR-0016) — used by the SSO flow for users to sign in and read their own profile

No second app registration. Single app, two purposes:
1. SSO for managers/admins (user-delegated, `User.Read`)
2. System mail-send (app-delegated, `Mail.Send`)

This is the more operationally simple path. A future rotation that compromises one credential rotates both — acceptable because both are owned by the same service. Splitting into two apps was considered and rejected: the marginal isolation benefit doesn't outweigh the doubled admin overhead.

### From mailbox

`dr3-vision@svdp.us` — a purpose-built shared mailbox in the SVdP M365 tenant.

This mailbox does NOT need an Exchange Online license if it is configured as a shared mailbox (under 50 GB and not used as a regular user account). Shared mailboxes are free in M365 — only the licensed user accounts (the admins who access them) consume licenses. The DR3-Vision app, sending as the mailbox, is not a "user" for licensing purposes.

The choice of mailbox matters for:

- **Recipient clarity:** payroll@svdp.us sees "From: dr3-vision@svdp.us" — obvious source, easy to auto-filter
- **Auditability:** Exchange message trace shows the mailbox as sender; ties back to DR3-Vision unambiguously
- **Future bounce/reply handling:** if payroll's inbox auto-replies, the response goes to dr3-vision@svdp.us where it can be retrieved (rather than `noreply@`)

### sendMail call structure

```typescript
// src/lib/m365-mail.ts (new)
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';

const credential = new ClientSecretCredential(
  process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID!,
  process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
  process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
);

const graphClient = Client.initWithMiddleware({
  authProvider: new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  }),
});

export async function sendPayrollPdf(opts: {
  monthId: string;
  pdfBuffer: Buffer;
  filename: string;
  subject: string;
  htmlBody: string;
  isAmendment: boolean;
}): Promise<{ messageId: string }> {
  const fromMailbox = process.env.M365_MAIL_FROM_ADDRESS!; // dr3-vision@svdp.us
  const toAddress = process.env.M365_PAYROLL_TO_ADDRESS!;  // payroll@svdp.us

  const response = await graphClient
    .api(`/users/${fromMailbox}/sendMail`)
    .post({
      message: {
        subject: opts.subject,
        body: { contentType: 'HTML', content: opts.htmlBody },
        toRecipients: [{ emailAddress: { address: toAddress } }],
        attachments: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: opts.filename,
          contentType: 'application/pdf',
          contentBytes: opts.pdfBuffer.toString('base64'),
        }],
        importance: opts.isAmendment ? 'high' : 'normal',
      },
      saveToSentItems: true,
    });

  // The 202 response from sendMail does not include a messageId; we audit the call ID.
  return { messageId: graphClient._requestContext?.id ?? 'unknown' };
}
```

### Email content

Subject line shape:

- Normal: `DR3 Woodland Bonus Report — September 2026`
- Amendment: `[AMENDED] DR3 Woodland Bonus Report — September 2026`

HTML body is short (the PDF is the canonical document):

> Attached is the signed monthly processor bonus report for DR3 Woodland.
>
> **Reporting period:** September 1–30, 2026
> **Total payout:** $X,XXX.XX
> **Signed by:** Janette Thomas (Facility Manager) and Morena Gomez (Operations Manager)
>
> Please process this report in the next payroll cycle. Questions: contact Bill Barnard (operations@svdp.us).
>
> ---
> This is an automated message from DR3 Vision. Do not reply to this address; it is not monitored continuously.

The PDF attachment is the source of truth. The HTML body is a convenience summary for payroll's inbox.

### Retry policy

`sendMail` calls are wrapped in retry-with-exponential-backoff:

- 5 retries with backoff base 1s, max 32s between attempts
- Retry on: 429 (rate limit), 503 (service unavailable), 504 (gateway timeout), network errors
- Do not retry on: 401 (token expired — refresh and retry once), 403 (permission denied — surface to operator), 400 (bad request — surface to developer)

If all retries exhaust, the failure publishes to `dr3-vision-system` ntfy with fingerprint `bonus-mail-failed:<month-id>`. The month state remains `signed` (not `paid`), and the manager portal surfaces a "PDF generated but mail delivery failed — retry" button.

### Audit

Every send (success or failure) writes an `audit_log` row with:

- `actor_label = 'system:m365-mail-send'`
- `action = 'insert'` (the message record)
- `table_name = 'bonus_months'`
- `row_id = <month-id>`
- `after` includes the message subject, recipient, attachment filename, response status, Graph request ID, retry count

Exchange Online's own message trace provides an independent audit at the tenant level. The two together (DR3-Vision audit + Exchange trace) form a robust delivery record.

### Rotation

Client secret rotation cadence: **180 days** (longer than the typical 90 days because this is a shared service credential, not a user credential, and is operationally painful to coordinate — extend by adding new secret first, swap deployment, retire old secret).

Procedure documented in `docs/operator/m365-mail-send-setup.md`.

## Alternatives considered

- **External SMTP via Resend.** Originally scaffolded in the Sprint 1 handoff. Removed when ADR-0016 dropped the email/password flow that used it for password reset. Re-introducing for payroll delivery would mean wiring a third-party API key for one use case while M365 Graph offers a strictly better path.

- **Delegated permission via a user account.** A licensed user could call `POST /me/sendMail` after delegating their permission to the app. Rejected: requires a real user to be logged in or to have a refresh token persisted; we want unattended automated delivery from an unattended app context.

- **Power Automate flow triggered by webhook.** Build a Power Automate flow that listens on a webhook from DR3-Vision and sends the email from there. Rejected: adds a vendor dependency layer (Power Automate licensing, flow management UI), opaque error surfacing, slower iteration.

- **Two separate Entra apps (SSO app, mail-send app).** Cleaner separation of concerns, isolated credential blast radius. Rejected as marginal benefit: both apps have the same trust boundary (the DR3-Vision service), credential compromise would affect both regardless, doubled admin overhead.

- **Different from-mailbox names** (`bonus@`, `noreply@`, `operations@`). `dr3-vision@svdp.us` chosen because it's purpose-built, descriptive, future-proof (handles non-bonus emails as DR3-Vision generates more), and easy for payroll to auto-filter.

## Consequences

- The Entra app registration's permission scope is no longer minimal (was just `User.Read` for SSO). `Mail.Send` is broad — it can send mail from any mailbox in the tenant the app has access to. Mitigations:
  - **Application Access Policy** (Exchange Online) restricts the app to sending only from `dr3-vision@svdp.us`. Set up during operator setup (see runbook).
  - This is a hard isolation, not a code-level convention.

- M365 Graph rate limits apply: ~10,000 requests per 10 minutes per app per tenant. DR3-Vision sends ~1 bonus PDF per month per site + amendments — orders of magnitude under the limit.

- A Microsoft service outage on Graph API means PDF delivery queues until recovery. Acceptable — bonus reports are not real-time, monthly cadence has tolerance for hours-long outages. ntfy alerts Bill if delivery fails after retries.

- Future system emails (audit-log notifications, weekly summaries, etc.) ride on the same infrastructure with the same retry/audit/rotation pattern. The `sendPayrollPdf` helper generalizes to `sendSystemEmail`.

- SVdP M365 tenant administrator (likely Bill or a SVdP IT contact) is now a critical operator. Setup is documented in `docs/operator/m365-mail-send-setup.md` step-by-step.

## References

- ADR-0016 (Entra ID SSO — the app this extends)
- ADR-0019 (Bonus Management System — the calling system)
- `docs/operator/m365-mail-send-setup.md` (operator setup runbook)
- Microsoft Graph sendMail API: https://learn.microsoft.com/en-us/graph/api/user-sendmail
- Microsoft Application Access Policy: https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access
