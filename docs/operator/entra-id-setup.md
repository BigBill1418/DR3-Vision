# Microsoft Entra ID setup — DR3-Vision SSO

ADR-0016 makes Microsoft Entra ID the only sign-in path for managers and
admins. Operators stay on the PIN flow on the iPad and are unaffected by
this runbook.

This is a one-time setup (per fleet host). Once the values below are in
`~/.dr3-vision-secrets/auth.env` on CHAD-HQ and the container is restarted,
managers and admins can sign in by clicking **Sign in with Microsoft** at
[https://dr3-vision.svdp.us/login](https://dr3-vision.svdp.us/login).

## 1. Register the app in Azure

1. Go to <https://portal.azure.com> → **Microsoft Entra ID** → **App
   registrations** → **New registration**.
2. **Name:** `DR3-Vision`.
3. **Supported account types:** *Accounts in this organizational directory
   only — single tenant*. (Multi-tenant + personal accounts is wrong; we
   only want SVdP-issued identities.)
4. **Redirect URI:**
   - Platform: *Web*
   - URI: `https://dr3-vision.svdp.us/api/auth/callback/microsoft-entra-id`
5. Click **Register**.

## 2. Capture the IDs

On the app's **Overview** page, copy these two values verbatim:

- **Application (client) ID** → goes into `AUTH_MICROSOFT_ENTRA_ID_ID`
- **Directory (tenant) ID** → substitutes into `AUTH_MICROSOFT_ENTRA_ID_ISSUER`

The issuer string is:

```
https://login.microsoftonline.com/<tenant-id>/v2.0
```

**No trailing slash.** Microsoft's OIDC discovery doc returns the issuer
without one; Auth.js refuses to start when the configured value doesn't
match (caught in production 2026-05-06 — symptom is `[auth][error] dh:
"response" body "issuer" does not match "expectedIssuer"` and a generic
"Server error" page on the first SSO attempt).

Use the tenant-specific issuer, not `/common/v2.0`. The tenant-specific
form rejects foreign Microsoft accounts at the IdP step, before the
DR3-Vision sign-in gate even runs.

## 3. Mint a client secret

1. **Certificates & secrets** → **Client secrets** → **New client secret**.
2. **Description:** `DR3-Vision production`.
3. **Expires:** *24 months*. (Calendar a renewal task — Entra rotates
   secrets to a maximum of 24 months; longer values are no longer offered.)
4. Click **Add**.
5. Copy the **Value** column (NOT the Secret ID). This appears once; if you
   navigate away you have to delete and recreate.

The value goes into `AUTH_MICROSOFT_ENTRA_ID_SECRET`.

## 4. Restrict access at the tenant via the DR3-Vision Admins group

Production policy (set 2026-05-06): every DR3-Vision SSO user must be a
member of the **DR3-Vision Admins** Entra security group, AND must have
an active (`is_active=true`, `deleted_at IS NULL`) row in the
application database. Both gates apply — the Azure side cuts off the IdP
flow, the app side cuts off post-IdP unauthorized accounts.

**One-time tenant setup:**

1. Microsoft Entra ID → **Groups** → **+ New group**.
   - Group type: *Security* (NOT Microsoft 365)
   - Name: `DR3-Vision Admins`
   - Membership type: *Assigned*
   - Add the initial member(s).
2. **Enterprise applications** → DR3-Vision → **Properties**:
   - Set **Assignment required?** to *Yes*. Save.
3. **Users and groups** → **+ Add user/group** → select
   `DR3-Vision Admins` → **Assign**.

**Onboarding rule (every new SSO user):**

1. Add the person to the `DR3-Vision Admins` Entra group.
2. Ensure their DR3-Vision user row is active. Two paths:
   - If a row already exists (seeded inactive):
     `UPDATE users SET is_active=true WHERE email='<lowercased>';`
     run via `docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision`.
   - If no row exists yet: create via the in-app `/admin/users/new`
     panel (admin-only).

The group name is intentional — managers AND admins both go in the same
group. The application-side `signIn` callback decides which role
applies based on the DB row's `role` column. If you want manager-only
or admin-only IdP-level segregation later, split into a second group
(`DR3-Vision Managers`) and assign both to the enterprise app.

## 5. Drop the values onto CHAD-HQ

SSH to the fleet host and update the secrets file:

```bash
ssh 10.99.0.2
tee -a ~/.dr3-vision-secrets/auth.env <<'EOF'
AUTH_MICROSOFT_ENTRA_ID_ID=<paste application-client-id>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<paste secret value>
AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
EOF
chmod 600 ~/.dr3-vision-secrets/auth.env
```

Then **recreate** the container so it picks up the new env_file. A plain
`restart` will NOT work — Compose bakes env_file values into the
container at create time, so a stop/start cycle keeps the old (empty)
env. Use `up -d --force-recreate` instead:

```bash
cd /home/bbarnard065/DR3-Vision
docker compose up -d --force-recreate --no-deps app
```

## 6. Verify

1. Open <https://dr3-vision.svdp.us/login>.
2. Click **Sign in with Microsoft**.
3. Authenticate with an SVdP work account that has a `manager` or `admin`
   row in DR3-Vision.
4. You should land on `/dashboard`.

If you see **Microsoft sign-in isn't configured yet**, the container hasn't
picked up the env vars — re-check step 5.

If you see **Your Microsoft account isn't authorized for DR3-Vision**, the
IdP authenticated you successfully but no `manager`/`admin` row matches
your email — add yourself via the Settings panel (or seed the row
directly).

If you see a generic **Server error** page on first attempt, check
`docker logs dr3-vision-app` for an `[auth][error]` line. The two known
hits are:

- `"response" body "issuer" does not match "expectedIssuer"` — trailing
  slash in `AUTH_MICROSOFT_ENTRA_ID_ISSUER`. Strip it and recreate the
  container.
- `InvalidCheck: pkceCodeVerifier value could not be parsed` — benign,
  happens when a user back-buttons through a successful callback URL.
  No action needed.

## 7. Rotation

When the client secret expires:

1. Repeat **§3** to mint a new one with the description
   `DR3-Vision production v2` (incrementing).
2. Update `AUTH_MICROSOFT_ENTRA_ID_SECRET` on CHAD-HQ.
3. Recreate the container (per §5 — `up -d --force-recreate --no-deps app`).
4. Delete the old secret in the Azure portal.

There's no overlap window — Entra accepts both old and new during
rotation as long as both rows exist, so this is zero-downtime.
