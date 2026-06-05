# M365 mail-send setup

This runbook is the operator-side procedure for enabling DR3-Vision to send the monthly bonus PDF to `payroll@svdp.us` via Microsoft Graph. Companion to ADR-0021.

**Who does this:** Bill, or a SVdP M365 tenant administrator with sufficient permissions to manage the Entra app registration and create a shared mailbox.

**When:** Once, before T-122 ships. Repeat steps 5–6 when rotating the client secret (every 180 days per ADR-0021).

**Why it can't be code-only:** the mailbox creation and Application Access Policy must be performed in the M365 admin UI (or via PowerShell with administrative credentials). These are tenant-level configuration changes, not application code.

---

## Prerequisites

- M365 tenant admin role (Global Administrator or Exchange Administrator + Application Administrator)
- The existing DR3-Vision Entra app registration from ADR-0016 (created during Sprint 1)
- SSH access to CHAD-HQ (for the env_file drop)

## Step 1 — Create the shared mailbox `dr3-vision@svdp.us`

In the [Microsoft 365 Admin Center](https://admin.microsoft.com):

1. Navigate to **Teams & groups → Shared mailboxes**
2. Click **Add a shared mailbox**
3. Configure:
    - **Name:** DR3 Vision
    - **Email address:** `dr3-vision@svdp.us`
    - **Domain:** svdp.us (confirm the domain dropdown matches)
4. Click **Save changes**
5. Wait ~5 minutes for the mailbox to provision (it takes a few minutes for the address to become routable)

**Verify:**

```bash
# From a machine with Send-As permission to the SVdP tenant, or from any inbox:
# Send a test email TO dr3-vision@svdp.us
# Expect: no bounce. Email lands in the shared mailbox.
```

Shared mailboxes are free in M365 — they do NOT consume a per-user license under 50 GB and when accessed via Send permissions, not as a primary login.

## Step 2 — Extend the existing Entra app registration

In the [Microsoft Entra admin center](https://entra.microsoft.com):

1. Navigate to **Applications → App registrations**
2. Find the existing **DR3-Vision** app (created during ADR-0016)
3. Click into it; note the **Application (client) ID** and **Directory (tenant) ID** — these are already set in DR3-Vision's `AUTH_MICROSOFT_ENTRA_ID_ID` and `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` env vars
4. Click **API permissions** in the left sidebar
5. Click **Add a permission**
6. Choose **Microsoft Graph → Application permissions** (NOT delegated)
7. Search for and select **Mail.Send**
8. Click **Add permissions**

The permission appears in the list with **Status: Not granted for [tenant]**.

9. Click **Grant admin consent for [tenant]** (requires Global Administrator)
10. Confirm; status changes to **Granted for [tenant]**

**Verify:** the API permissions list now shows two permissions:
- `User.Read` (Delegated) — Granted, from ADR-0016
- `Mail.Send` (Application) — Granted, from this step

## Step 3 — Restrict the app to the dr3-vision@svdp.us mailbox

This is critical. By default, `Mail.Send` application permission grants the app the ability to send from ANY mailbox in the tenant. We restrict it to `dr3-vision@svdp.us` only via an **Application Access Policy**.

This step requires **PowerShell with Exchange Online module**. From an admin machine:

```powershell
# Install once if not already present
Install-Module -Name ExchangeOnlineManagement -Force

# Connect (interactive sign-in as a tenant admin)
Connect-ExchangeOnline -UserPrincipalName admin@svdp.us

# Find your Application Client ID from Step 2 above
$appId = '<your-dr3-vision-app-client-id>'

# Create the policy: restrict to dr3-vision@svdp.us only
New-ApplicationAccessPolicy `
  -AppId $appId `
  -PolicyScopeGroupId 'dr3-vision@svdp.us' `
  -AccessRight RestrictAccess `
  -Description 'DR3-Vision app can send only from dr3-vision@svdp.us'

# Verify
Get-ApplicationAccessPolicy | Where-Object { $_.AppId -eq $appId }
```

**Verify the restriction works:**

```powershell
# Should return AccessCheckResult: Granted
Test-ApplicationAccessPolicy `
  -Identity 'dr3-vision@svdp.us' `
  -AppId $appId

# Should return AccessCheckResult: Denied
Test-ApplicationAccessPolicy `
  -Identity 'bill.barnard@svdp.us' `
  -AppId $appId
```

If the second test does NOT return Denied, the policy is misconfigured and the app has broader access than intended. Investigate before proceeding.

## Step 4 — Generate or rotate the client secret

If the existing client secret from ADR-0016 is still valid, you may use it. To generate a new one:

1. Back in **Entra → App registrations → DR3-Vision → Certificates & secrets**
2. Click **+ New client secret**
3. Description: `DR3-Vision-mail-send-YYYY-MM-DD`
4. Expires: **180 days** (per ADR-0021 rotation policy)
5. Click **Add**
6. **Copy the secret value immediately** — it is not retrievable after closing this page

The value is what you'll put in `AUTH_MICROSOFT_ENTRA_ID_SECRET` (this is the same env var ADR-0016 uses for SSO; the app has one secret for both purposes).

## Step 5 — Drop env_file on CHAD-HQ

SSH to CHAD-HQ:

```bash
ssh chad-hq

# Create the secrets directory if it doesn't exist
mkdir -p ~/.dr3-vision-secrets
chmod 700 ~/.dr3-vision-secrets

# Create or edit the m365 env file
cat > ~/.dr3-vision-secrets/m365.env <<'EOF'
# M365 Graph mail-send (ADR-0021)
M365_MAIL_FROM_ADDRESS=dr3-vision@svdp.us
M365_PAYROLL_TO_ADDRESS=payroll@svdp.us

# These three are SHARED with the Entra SSO env file from ADR-0016.
# If they're already set in ~/.dr3-vision-secrets/entra.env, you can omit them
# here and ensure both env files are loaded by docker-compose.
AUTH_MICROSOFT_ENTRA_ID_TENANT_ID=<tenant-id>
AUTH_MICROSOFT_ENTRA_ID_ID=<client-id>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<new-client-secret-from-step-4>
EOF

chmod 600 ~/.dr3-vision-secrets/m365.env
```

## Step 6 — Recreate the app container

**NOT `restart`.** `restart` keeps the existing env baked in at container-create time. Use `force-recreate`:

```bash
cd /opt/dr3-vision
docker compose up -d --force-recreate --no-deps app
```

Watch the boot logs for the first few seconds:

```bash
docker compose logs -f app | head -50
```

Look for:

```
[m365-mail] Token credential initialized for tenant <tenant-id>
[m365-mail] Configured: from=dr3-vision@svdp.us, to=payroll@svdp.us
```

If the logs show `M365_MAIL_FROM_ADDRESS not configured, mail-send disabled`, the env_file wasn't loaded. Check that `docker-compose.yml` lists `~/.dr3-vision-secrets/m365.env` as an env_file for the `app` service.

## Step 7 — Verify end-to-end

From a browser logged in as Bill (admin):

1. Navigate to a test bonus month with both signatures present (or create one through the UI)
2. The PDF should auto-generate and send
3. Check `payroll@svdp.us` (or a test recipient first — recommended for the first send) for the email

Independent verification via Exchange Online message trace:

```powershell
Connect-ExchangeOnline -UserPrincipalName admin@svdp.us

Get-MessageTrace `
  -SenderAddress dr3-vision@svdp.us `
  -StartDate (Get-Date).AddHours(-1) `
  -EndDate (Get-Date) |
  Format-Table Received, SenderAddress, RecipientAddress, Subject, Status
```

You should see the send with `Status: Delivered`.

## Step 8 — Test recipient redirect for first send (recommended)

For the **very first send** in production, redirect to a test inbox (your own) instead of `payroll@svdp.us`:

```bash
# Temporarily override the to-address
sed -i 's/M365_PAYROLL_TO_ADDRESS=payroll@svdp.us/M365_PAYROLL_TO_ADDRESS=bill.barnard@svdp.us/' ~/.dr3-vision-secrets/m365.env
docker compose up -d --force-recreate --no-deps app
```

Do one test send, verify it lands in your inbox with the correct co-branded PDF, then restore:

```bash
sed -i 's/M365_PAYROLL_TO_ADDRESS=bill.barnard@svdp.us/M365_PAYROLL_TO_ADDRESS=payroll@svdp.us/' ~/.dr3-vision-secrets/m365.env
docker compose up -d --force-recreate --no-deps app
```

This is a one-time safety check. After the first real send to payroll, this step is not repeated.

## Troubleshooting

### `AADSTS70011: The provided value for the input parameter 'scope' is not valid`

The token request scope should be `https://graph.microsoft.com/.default` (literal). Other variants fail with this error.

### `Forbidden — Either the app does not have permission, or the application access policy prevents this access`

Either step 2 (`Mail.Send` permission grant) or step 3 (Application Access Policy) is misconfigured. Re-run the verification queries from step 3.

### Email sends but lands in payroll's junk folder

This is rare for intra-tenant mail but can happen if:
- `dr3-vision@svdp.us` is too new (M365 sometimes flags new mailboxes)
- The HTML body triggers a content-based filter
- DKIM signing for the tenant is not configured (unrelated to DR3-Vision; check tenant config)

Add `dr3-vision@svdp.us` to payroll's safe senders list as a workaround.

### Client secret expired

Watch for the warning email from Entra (sent 30 days before expiry). Repeat step 4 to generate a new secret, then update `AUTH_MICROSOFT_ENTRA_ID_SECRET` in `~/.dr3-vision-secrets/m365.env`, then step 6 to recreate the container.

The old secret remains valid until its expiry date — there is no race condition during rotation as long as both secrets exist briefly.

## References

- ADR-0019 (Bonus Management System — the calling system)
- ADR-0021 (M365 Graph mail-send — architecture)
- ADR-0016 (Entra ID SSO — the app this extends)
- `docs/operator/entra-id-setup.md` (Entra SSO setup runbook — predecessor)
- Microsoft Graph sendMail API: https://learn.microsoft.com/en-us/graph/api/user-sendmail
- Application Access Policy: https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access
