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
https://login.microsoftonline.com/<tenant-id>/v2.0/
```

Use the tenant-specific issuer, not `/common/v2.0/`. The tenant-specific
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

## 4. (Optional) Restrict access at the tenant

By default any user in the tenant can attempt to sign in. The DR3-Vision
sign-in gate filters out users who don't have a `manager` or `admin` row
in the application database, so unauthorized people get a clean
"not authorized" screen rather than a session.

If you want a hard lock at the IdP level:

1. **Enterprise applications** → DR3-Vision → **Properties**.
2. Set **Assignment required?** to *Yes*.
3. **Users and groups** → **Add user/group** → assign the people who
   should be allowed to attempt sign-in.

This is belt-and-suspenders; the application-level gate is the canonical
check.

## 5. Drop the values onto CHAD-HQ

SSH to the fleet host and update the secrets file:

```bash
ssh 10.99.0.2
sudo -u dr3-vision tee -a ~/.dr3-vision-secrets/auth.env <<'EOF'
AUTH_MICROSOFT_ENTRA_ID_ID=<paste application-client-id>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<paste secret value>
AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0/
EOF
sudo chmod 600 ~/.dr3-vision-secrets/auth.env
```

Then restart the container so it picks up the new env:

```bash
docker compose -f /home/dr3-vision/docker-compose.yml restart web
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

## 7. Rotation

When the client secret expires:

1. Repeat **§3** to mint a new one with the description
   `DR3-Vision production v2` (incrementing).
2. Update `AUTH_MICROSOFT_ENTRA_ID_SECRET` on CHAD-HQ.
3. Restart the container.
4. Delete the old secret in the Azure portal.

There's no overlap window — Entra accepts both old and new during
rotation as long as both rows exist, so this is zero-downtime.
