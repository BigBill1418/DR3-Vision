# 2026-07-09 — Working az-pivoted setup script (PS 7.6 compatibility fix)

**Context:** the original `graph-permissions.ps1` in PR #82 uses the `Microsoft.Graph` PowerShell SDK, which as of 2026-07 ships version 2.38.0 as its latest and is incompatible with PowerShell 7.6 (`Method not found` on `Microsoft.Identity.Client.BaseAbstractApplicationBuilder`.`WithLogging`). PSGallery has no newer version. This handoff provides a drop-in replacement that uses Azure CLI (`az`) for the Graph portion — same result, different transport, works on PS 7.6.

**Prerequisite:** Azure CLI installed (`winget install --id Microsoft.AzureCLI`).

## §1 — Save as `dr3-vision-graph-setup.ps1` on Desktop

Direct-download command Bill can run from PowerShell 7:

```powershell
$url = "https://raw.githubusercontent.com/BigBill1418/DR3-Vision/main/scripts/setup/graph-permissions-az.ps1"
Invoke-WebRequest -Uri $url -OutFile "$env:USERPROFILE\Desktop\dr3-vision-graph-setup.ps1"
```

Requires the file to exist at `scripts/setup/graph-permissions-az.ps1` on `main` first (Claude Code splits this out as part of executing the handoff).

## §2 — The working script

```powershell
<#
.SYNOPSIS
    DR3-Vision Microsoft Graph permission setup (Azure CLI + Exchange Online PS).

.DESCRIPTION
    Provisions approvals-dr3@svdp.us, grants Mail.ReadWrite scoped via
    ApplicationAccessPolicy, grants Files.Read.All. Idempotent. Uses az CLI for
    Graph operations because Microsoft.Graph PS SDK 2.38.0 (latest as of 2026-07)
    is incompatible with PowerShell 7.6.

.NOTES
    Requires Global Admin. Prerequisites: az (Azure CLI), ExchangeOnlineManagement.
#>

$ErrorActionPreference = "Stop"

$MailboxAddress       = "approvals-dr3@svdp.us"
$MailboxDisplayName   = "DR3 AP Approvals"
$MailboxAlias         = "approvals-dr3"
$ScopingGroupAddress  = "dr3-vision-scoped@svdp.us"
$ScopingGroupName     = "DR3-Vision-Scoped-Mailboxes"
$DR3VisionAppName     = "dr3-vision"
$GraphAppId           = "00000003-0000-0000-c000-000000000000"

function Info  ($m) { Write-Host "  i  $m" -ForegroundColor Cyan }
function Ok    ($m) { Write-Host "  +  $m" -ForegroundColor Green }
function Skip2 ($m) { Write-Host "  =  $m (already in place)" -ForegroundColor Yellow }
function Step  ($m) { Write-Host "`n-- $m --" -ForegroundColor White -BackgroundColor DarkBlue }

Step "Connecting to Exchange Online"
Connect-ExchangeOnline -ShowBanner:$false
Ok "Exchange Online connected"

Step "Connecting to Azure (device code)"
az login --use-device-code --allow-no-subscriptions | Out-Null
if ($LASTEXITCODE -ne 0) { throw "az login failed" }
Ok "Azure CLI connected"

Step "Discovering dr3-vision app + Graph SPN"
$dr3App = az ad app list --display-name $DR3VisionAppName --query "[0]" -o json | ConvertFrom-Json
if (-not $dr3App) { throw "App '$DR3VisionAppName' not found." }
$AppId = $dr3App.appId
Ok "Found app '$DR3VisionAppName' AppId=$AppId"

$dr3Sp = az ad sp list --filter "appId eq '$AppId'" --query "[0]" -o json | ConvertFrom-Json
if (-not $dr3Sp) { throw "Service principal for app $AppId not found." }
$dr3SpId = $dr3Sp.id

$graphSp = az ad sp list --filter "appId eq '$GraphAppId'" --query "[0]" -o json | ConvertFrom-Json
$graphSpId = $graphSp.id

$mailRoleId = ($graphSp.appRoles | Where-Object { $_.value -eq "Mail.ReadWrite" -and $_.allowedMemberTypes -contains "Application" }).id
$filesRoleId = ($graphSp.appRoles | Where-Object { $_.value -eq "Files.Read.All"  -and $_.allowedMemberTypes -contains "Application" }).id
Ok "Discovered app + role ids"

Step "Task 1.1 - Shared mailbox $MailboxAddress"
$existingMailbox = Get-Mailbox -Identity $MailboxAddress -ErrorAction SilentlyContinue
if (-not $existingMailbox) {
    New-Mailbox -Shared -Name $MailboxDisplayName -DisplayName $MailboxDisplayName -Alias $MailboxAlias -PrimarySmtpAddress $MailboxAddress | Out-Null
    Ok "Created shared mailbox"
    Info "Waiting 30s for propagation..."
    Start-Sleep -Seconds 30
} else {
    Skip2 "Mailbox exists"
}

Step "Task 1.2 - Grant Mail.ReadWrite"
$existing = az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" --query "value[?appRoleId=='$mailRoleId' && resourceId=='$graphSpId']" -o json | ConvertFrom-Json
if (-not $existing) {
    $body = @{ principalId = $dr3SpId; resourceId = $graphSpId; appRoleId = $mailRoleId } | ConvertTo-Json -Compress
    az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" --headers "Content-Type=application/json" --body $body | Out-Null
    Ok "Granted Mail.ReadWrite"
} else {
    Skip2 "Mail.ReadWrite already granted"
}

Step "Task 1.3 - Scope Mail.ReadWrite to $MailboxAddress only"
$existingGroup = Get-DistributionGroup -Identity $ScopingGroupAddress -ErrorAction SilentlyContinue
if (-not $existingGroup) {
    New-DistributionGroup -Name $ScopingGroupName -Type Security -PrimarySmtpAddress $ScopingGroupAddress -Members @($MailboxAddress) | Out-Null
    Ok "Created scoping security group"
    Info "Waiting 60s for group propagation..."
    Start-Sleep -Seconds 60
} else {
    Skip2 "Scoping group exists"
    $members = Get-DistributionGroupMember -Identity $ScopingGroupAddress
    if ($members.PrimarySmtpAddress -notcontains $MailboxAddress) {
        Add-DistributionGroupMember -Identity $ScopingGroupAddress -Member $MailboxAddress
        Ok "Added $MailboxAddress to scoping group"
    }
}

$existingPolicy = Get-ApplicationAccessPolicy | Where-Object { $_.AppId -eq $AppId -and $_.ScopeName -eq $ScopingGroupAddress }
if (-not $existingPolicy) {
    New-ApplicationAccessPolicy -AppId $AppId -PolicyScopeGroupId $ScopingGroupAddress -AccessRight RestrictAccess -Description "DR3-Vision may only access mailboxes in $ScopingGroupName" | Out-Null
    Ok "Created ApplicationAccessPolicy"
} else {
    Skip2 "ApplicationAccessPolicy exists"
}

Step "Task 2 - Grant Files.Read.All"
$existing = az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" --query "value[?appRoleId=='$filesRoleId' && resourceId=='$graphSpId']" -o json | ConvertFrom-Json
if (-not $existing) {
    $body = @{ principalId = $dr3SpId; resourceId = $graphSpId; appRoleId = $filesRoleId } | ConvertTo-Json -Compress
    az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" --headers "Content-Type=application/json" --body $body | Out-Null
    Ok "Granted Files.Read.All"
} else {
    Skip2 "Files.Read.All already granted"
}

Step "Verification"
Info "Mailbox record:"
Get-Mailbox -Identity $MailboxAddress | Format-Table DisplayName, PrimarySmtpAddress, RecipientTypeDetails -AutoSize

Info "Scoped access allowed?"
Test-ApplicationAccessPolicy -Identity $MailboxAddress -AppId $AppId | Format-Table Identity, AccessCheckResult -AutoSize

Info "Granted assignments:"
$assignments = az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" --query "value[?resourceId=='$graphSpId']" -o json | ConvertFrom-Json
foreach ($a in $assignments) {
    $rid = $a.appRoleId
    $roleName = ($graphSp.appRoles | Where-Object { $_.id -eq $rid }).value
    [PSCustomObject]@{ Permission = $roleName; GrantedAt = $a.createdDateTime }
} | Format-Table -AutoSize

Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host "  Mailbox:       $MailboxAddress" -ForegroundColor White
Write-Host "  App:           $DR3VisionAppName ($AppId)" -ForegroundColor White
Write-Host "  Permissions:   Mail.ReadWrite (scoped) + Files.Read.All" -ForegroundColor White
```

## §3 — Claude Code should

Save this content as `scripts/setup/graph-permissions-az.ps1` on main so Bill can download directly via `Invoke-WebRequest`. Also update `docs/operator/graph-permissions-setup.md` (from PR #82 §5) to note the az-pivoted version is the recommended path for Windows/PS 7.6+ workstations, with the original SDK-based version kept as an alternative for environments where az isn't available.

## §4 — Impact on PR #82

Supersedes PR #82's `graph-permissions.ps1` for the PS 7.6+ / az-available case. PR #82's script stays valid for environments where az isn't available AND the Graph SDK is compatible (older PS versions or if MS ships a newer Graph SDK). Both scripts live in the repo; runbook explains which to use.
