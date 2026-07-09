# 2026-07-09 — Graph permissions setup automation (supersedes §5.1 IT email)

**Follows:** `docs/handoffs/2026-07-09-planning-session-decisions-rollup-2026-07-08.md` §5.1
**Purpose:** Automated PowerShell scripts + operator runbook for the AP mailbox + `Files.Read.All` provisioning. Bill has Global Admin on the SVdP tenant and will execute directly rather than routing through an IT ticket.

## §1 — What Claude Code should create

Three artifacts:

1. `scripts/setup/graph-permissions.ps1` — idempotent setup script (§3 below)
2. `scripts/setup/graph-permissions-teardown.ps1` — rollback / retirement script (§4 below)
3. `docs/operator/graph-permissions-setup.md` — operator runbook (§5 guidance)

## §2 — Prerequisites (one-time, on Bill's workstation)

PowerShell 7 (`pwsh`), then:

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser -Force
Install-Module -Name Microsoft.Graph -Scope CurrentUser -Force
```

## §3 — `scripts/setup/graph-permissions.ps1`

**Idempotency contract:** every step checks for existing resources before creating. Re-runs report "already in place" in yellow; nothing is disturbed.

**PowerShell scope caveat baked into verification:** `$_` inside nested `ForEach-Object`/`Where-Object` refers to the innermost pipeline element. The outer `$_.AppRoleId` must be captured into a local variable before the inner `Where-Object` runs. The script does this correctly; a naive version silently returns empty role names.

```powershell
<#
.SYNOPSIS
    Automates the Microsoft Graph permission setup for DR3-Vision.

.DESCRIPTION
    Provisions the approvals-dr3@svdp.us shared mailbox, grants scoped
    Mail.ReadWrite to the dr3-vision Graph app via ApplicationAccessPolicy,
    and grants Files.Read.All. Fully idempotent - safe to re-run at any time;
    steps already in place are skipped.

.NOTES
    Requires Global Admin. Modules: ExchangeOnlineManagement, Microsoft.Graph.
    Related: docs/adr/0046-vendor-invoice-approval-mailbox.md, ADR-0049 (workbook sync).
#>

$ErrorActionPreference = "Stop"

# --- Config ------------------------------------------------------------------
$MailboxAddress       = "approvals-dr3@svdp.us"
$MailboxDisplayName   = "DR3 AP Approvals"
$MailboxAlias         = "approvals-dr3"
$ScopingGroupAddress  = "dr3-vision-scoped@svdp.us"
$ScopingGroupName     = "DR3-Vision-Scoped-Mailboxes"
$DR3VisionAppName     = "dr3-vision"

function Info  ($m) { Write-Host "  i  $m" -ForegroundColor Cyan }
function Ok    ($m) { Write-Host "  +  $m" -ForegroundColor Green }
function Skip2 ($m) { Write-Host "  =  $m (already in place)" -ForegroundColor Yellow }
function Step  ($m) { Write-Host "`n-- $m --" -ForegroundColor White -BackgroundColor DarkBlue }

# --- Connect -----------------------------------------------------------------
Step "Connecting to Exchange Online + Microsoft Graph"
Connect-ExchangeOnline -ShowBanner:$false
Connect-MgGraph -Scopes @(
    "Application.ReadWrite.All",
    "AppRoleAssignment.ReadWrite.All",
    "Directory.ReadWrite.All"
) -NoWelcome
Ok "Connected"

# --- Discover the dr3-vision app --------------------------------------------
Step "Discovering the dr3-vision app registration"
$dr3App = Get-MgApplication -Filter "displayName eq '$DR3VisionAppName'"
if (-not $dr3App) {
    throw "Could not find app registration named '$DR3VisionAppName'. Check the display name in Entra ID -> App registrations."
}
$AppId = $dr3App.AppId
Ok "Found: $DR3VisionAppName (AppId: $AppId)"

$dr3Sp = Get-MgServicePrincipal -Filter "AppId eq '$AppId'"
if (-not $dr3Sp) {
    throw "No service principal for AppId $AppId. Add an Enterprise Application entry for this app registration in Entra ID before running."
}

# --- Microsoft Graph service principal + role definitions --------------------
$graphSp = Get-MgServicePrincipal -Filter "AppId eq '00000003-0000-0000-c000-000000000000'"
$mailReadWriteRole = $graphSp.AppRoles | Where-Object {
    $_.Value -eq "Mail.ReadWrite" -and $_.AllowedMemberTypes -contains "Application"
}
$filesReadAllRole  = $graphSp.AppRoles | Where-Object {
    $_.Value -eq "Files.Read.All"  -and $_.AllowedMemberTypes -contains "Application"
}

# --- Task 1.1: Shared mailbox -----------------------------------------------
Step "Task 1.1 - Provisioning shared mailbox $MailboxAddress"
$existingMailbox = Get-Mailbox -Identity $MailboxAddress -ErrorAction SilentlyContinue
if (-not $existingMailbox) {
    New-Mailbox -Shared `
        -Name $MailboxDisplayName `
        -DisplayName $MailboxDisplayName `
        -Alias $MailboxAlias `
        -PrimarySmtpAddress $MailboxAddress | Out-Null
    Ok "Created shared mailbox"
    Info "Waiting 30s for mailbox to propagate..."
    Start-Sleep -Seconds 30
} else {
    Skip2 "Mailbox exists"
}

# --- Task 1.2: Grant Mail.ReadWrite + admin consent -------------------------
Step "Task 1.2 - Granting Mail.ReadWrite (with tenant admin consent)"
$existingMailAssignment = Get-MgServicePrincipalAppRoleAssignment `
    -ServicePrincipalId $dr3Sp.Id |
    Where-Object { $_.AppRoleId -eq $mailReadWriteRole.Id -and $_.ResourceId -eq $graphSp.Id }
if (-not $existingMailAssignment) {
    New-MgServicePrincipalAppRoleAssignment `
        -ServicePrincipalId $dr3Sp.Id `
        -PrincipalId $dr3Sp.Id `
        -ResourceId $graphSp.Id `
        -AppRoleId $mailReadWriteRole.Id | Out-Null
    Ok "Granted Mail.ReadWrite + admin consent"
} else {
    Skip2 "Mail.ReadWrite already granted"
}

# --- Task 1.3: Scope via ApplicationAccessPolicy ----------------------------
Step "Task 1.3 - Scoping to $MailboxAddress only"

# 1.3a: Scoping security group
$existingGroup = Get-DistributionGroup -Identity $ScopingGroupAddress -ErrorAction SilentlyContinue
if (-not $existingGroup) {
    New-DistributionGroup `
        -Name $ScopingGroupName `
        -Type Security `
        -PrimarySmtpAddress $ScopingGroupAddress `
        -Members @($MailboxAddress) | Out-Null
    Ok "Created scoping security group"
    Info "Waiting 60s for group to propagate..."
    Start-Sleep -Seconds 60
} else {
    Skip2 "Scoping group exists"
    $members = Get-DistributionGroupMember -Identity $ScopingGroupAddress
    if ($members.PrimarySmtpAddress -notcontains $MailboxAddress) {
        Add-DistributionGroupMember -Identity $ScopingGroupAddress -Member $MailboxAddress
        Ok "Added $MailboxAddress to scoping group"
    }
}

# 1.3b: ApplicationAccessPolicy
$existingPolicy = Get-ApplicationAccessPolicy | Where-Object {
    $_.AppId -eq $AppId -and $_.ScopeName -eq $ScopingGroupAddress
}
if (-not $existingPolicy) {
    New-ApplicationAccessPolicy `
        -AppId $AppId `
        -PolicyScopeGroupId $ScopingGroupAddress `
        -AccessRight RestrictAccess `
        -Description "DR3-Vision may only access mailboxes in $ScopingGroupName" | Out-Null
    Ok "Created ApplicationAccessPolicy"
} else {
    Skip2 "ApplicationAccessPolicy exists"
}

# --- Task 2: Grant Files.Read.All + admin consent ---------------------------
Step "Task 2 - Granting Files.Read.All (with tenant admin consent)"
$existingFilesAssignment = Get-MgServicePrincipalAppRoleAssignment `
    -ServicePrincipalId $dr3Sp.Id |
    Where-Object { $_.AppRoleId -eq $filesReadAllRole.Id -and $_.ResourceId -eq $graphSp.Id }
if (-not $existingFilesAssignment) {
    New-MgServicePrincipalAppRoleAssignment `
        -ServicePrincipalId $dr3Sp.Id `
        -PrincipalId $dr3Sp.Id `
        -ResourceId $graphSp.Id `
        -AppRoleId $filesReadAllRole.Id | Out-Null
    Ok "Granted Files.Read.All + admin consent"
} else {
    Skip2 "Files.Read.All already granted"
}

# --- Verification -----------------------------------------------------------
Step "Verification"

Info "Mailbox record:"
Get-Mailbox -Identity $MailboxAddress |
    Format-Table DisplayName, PrimarySmtpAddress, RecipientTypeDetails -AutoSize

Info "Scoped access allowed to $MailboxAddress?"
Test-ApplicationAccessPolicy -Identity $MailboxAddress -AppId $AppId |
    Format-Table Identity, AccessCheckResult -AutoSize

Info "Scoped access denied to other mailboxes? (testing signed-in account as control)"
$myUpn = (Get-MgContext).Account
Test-ApplicationAccessPolicy -Identity $myUpn -AppId $AppId |
    Format-Table Identity, AccessCheckResult -AutoSize

Info "Granted Graph app role assignments:"
Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $dr3Sp.Id |
    Where-Object { $_.ResourceId -eq $graphSp.Id } |
    ForEach-Object {
        $roleId  = $_.AppRoleId
        $granted = $_.CreatedDateTime
        $roleObj = $graphSp.AppRoles | Where-Object { $_.Id -eq $roleId }
        [PSCustomObject]@{
            Permission = $roleObj.Value
            GrantedAt  = $granted
        }
    } | Format-Table -AutoSize

Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host "  Mailbox:       $MailboxAddress" -ForegroundColor White
Write-Host "  Scoping group: $ScopingGroupAddress" -ForegroundColor White
Write-Host "  App:           $DR3VisionAppName ($AppId)" -ForegroundColor White
Write-Host "  Permissions:   Mail.ReadWrite (scoped) + Files.Read.All" -ForegroundColor White
```

## §4 — `scripts/setup/graph-permissions-teardown.ps1`

Removes `Files.Read.All` only. The AP mailbox and its scoped `Mail.ReadWrite` stay intact — those support the ongoing AP workflow post-cutover. If the AP module ever gets retired, uncomment the block at the bottom.

```powershell
<#
.SYNOPSIS
    Removes Files.Read.All from the dr3-vision Graph app (workbook sync retirement).

.DESCRIPTION
    Run this after ADR-0049 workbook sync is retired at cutover. Idempotent.
    Does NOT remove the AP mailbox or its scoped Mail.ReadWrite permission -
    those remain in production use.

.NOTES
    Requires Global Admin. Module: Microsoft.Graph.
#>

$ErrorActionPreference = "Stop"

$DR3VisionAppName = "dr3-vision"

Write-Host "Connecting to Microsoft Graph..." -ForegroundColor Cyan
Connect-MgGraph -Scopes @(
    "Application.ReadWrite.All",
    "AppRoleAssignment.ReadWrite.All"
) -NoWelcome

$dr3App = Get-MgApplication -Filter "displayName eq '$DR3VisionAppName'"
if (-not $dr3App) { throw "App '$DR3VisionAppName' not found." }

$dr3Sp   = Get-MgServicePrincipal -Filter "AppId eq '$($dr3App.AppId)'"
$graphSp = Get-MgServicePrincipal -Filter "AppId eq '00000003-0000-0000-c000-000000000000'"
$filesRole = $graphSp.AppRoles | Where-Object {
    $_.Value -eq "Files.Read.All" -and $_.AllowedMemberTypes -contains "Application"
}

$assignment = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $dr3Sp.Id |
    Where-Object { $_.AppRoleId -eq $filesRole.Id -and $_.ResourceId -eq $graphSp.Id }

if ($assignment) {
    Remove-MgServicePrincipalAppRoleAssignment `
        -ServicePrincipalId $dr3Sp.Id `
        -AppRoleAssignmentId $assignment.Id
    Write-Host "Files.Read.All removed from $DR3VisionAppName" -ForegroundColor Green
} else {
    Write-Host "Files.Read.All was not assigned. Nothing to do." -ForegroundColor Yellow
}

# --- Optional: full AP module teardown (uncomment if retiring AP workflow) ---
# Connect-ExchangeOnline -ShowBanner:$false
# $policy = Get-ApplicationAccessPolicy | Where-Object { $_.AppId -eq $dr3App.AppId }
# if ($policy) { Remove-ApplicationAccessPolicy -Identity $policy.Identity -Confirm:$false }
# Remove-DistributionGroup -Identity "dr3-vision-scoped@svdp.us" -Confirm:$false
# Remove-Mailbox -Identity "approvals-dr3@svdp.us" -Confirm:$false
# $mailRole = $graphSp.AppRoles | Where-Object { $_.Value -eq "Mail.ReadWrite" }
# $mailAssign = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $dr3Sp.Id |
#     Where-Object { $_.AppRoleId -eq $mailRole.Id -and $_.ResourceId -eq $graphSp.Id }
# if ($mailAssign) { Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $dr3Sp.Id -AppRoleAssignmentId $mailAssign.Id }
```

## §5 — `docs/operator/graph-permissions-setup.md` (guidance for Claude Code)

Adapt into an operator runbook with these sections:

1. **Overview** — what the two grants do and why (ADR-0046 AP mailbox + ADR-0049 workbook sync)
2. **Fast path (Global Admin)** — module prerequisites; `pwsh -File ./scripts/setup/graph-permissions.ps1`; expected output; verification checks the script runs
3. **Manual path (portal-based)** — Entra ID + Exchange PowerShell steps for admins who prefer not to run the script. Content matches the instructional doc drafted in this session — Prerequisites, Task 1 (mailbox + Mail.ReadWrite + ApplicationAccessPolicy) with three sub-steps, Task 2 (Files.Read.All), Rollback pointer
4. **Rollback** — pointer to `scripts/setup/graph-permissions-teardown.ps1` + note that the AP module stays intact by default
5. **Related** — links to ADR-0046 and ADR-0049 (proposed)

## §6 — Impact on the parent handoff's §5.1 email

The batched-asks IT email in `2026-07-09-planning-session-decisions-rollup-2026-07-08.md` §5.1 becomes **optional** — an FYI/audit-trail note rather than a service request. If Bill sends it, it can be a one-liner: "Ran this against the tenant myself as global admin; artifacts committed at `scripts/setup/graph-permissions.ps1` for the record."

The two Graph permission asks (`Mail.ReadWrite` scoped + `Files.Read.All`) are no longer gated on IT lead time. Bill can execute the same day.

## §7 — Updated blocker list for Stage 1

Removing "IT permissions grant" from the parent handoff's §6 next-actions blocker list. Remaining pre-Stage-1 blockers:

1. `RESTIC_PASSWORD` 1Password confirmation (P1-4) — Claude Code to build 1P automation into a future handoff (Bill's earlier direction)
2. Three files for ADR-0048 promotion (Woodland `.xlsm`, Terex history, Eugene Jun 24–30)
3. Kelsey walkthrough scheduling

Stage 1 pre-flight can proceed as soon as those three land.

## §8 — Execution note for Claude Code

The three artifacts in §1 can build in one small PR — no test suite implications, no schema changes, no ADR amendments. `git add scripts/setup/graph-permissions.ps1 scripts/setup/graph-permissions-teardown.ps1 docs/operator/graph-permissions-setup.md`, PR title `chore: add Graph permissions setup automation for global admin`, done. Should take ~10 minutes end-to-end.
