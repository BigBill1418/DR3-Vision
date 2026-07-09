<#
.SYNOPSIS
    DR3-Vision Microsoft Graph permission setup (Azure CLI + Exchange Online PS).

.DESCRIPTION
    Provisions approvals-dr3@svdp.us, grants Mail.ReadWrite scoped via
    ApplicationAccessPolicy, grants Files.Read.All. Idempotent. Uses az CLI for
    Graph operations because Microsoft.Graph PS SDK 2.38.0 (latest as of 2026-07)
    is incompatible with PowerShell 7.6.

    Executed successfully against the SVDP tenant 2026-07-09 (PS 7.6, az 2.88).
    Post-execution hardening (docs/handoffs/2026-07-09-it-permissions-execution-complete.md):
      - az rest bodies go via temp file (inline JSON is mangled on Windows)  [§2.1]
      - $LASTEXITCODE checked after every mutating az rest                   [§2.2]
      - verification role lookup captures the outer loop var                 [§2.3]
      - -WhatIf dry-run mode; tenant identity in the login green-check       [§3]

.PARAMETER WhatIf
    Print every action the script WOULD take, without connecting to Exchange
    Online or mutating anything. az login still runs (read-only discovery).

.NOTES
    Requires Global Admin. Prerequisites: az (Azure CLI), ExchangeOnlineManagement.
#>
param(
    [switch]$WhatIf
)

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
function Plan  ($m) { Write-Host "  ?  WhatIf: would $m" -ForegroundColor Magenta }
function Step  ($m) { Write-Host "`n-- $m --" -ForegroundColor White -BackgroundColor DarkBlue }

# az rest --body with inline JSON is mangled by PowerShell/az on Windows before
# Graph sees it (Bad Request "Unable to read JSON request payload"). The
# temp-file @path form works on every platform and is the house standard.
$BodyFile = Join-Path ([System.IO.Path]::GetTempPath()) "graph-body.json"
function Invoke-GraphPost ($Uri, $BodyObject, $FailureLabel) {
    $json = $BodyObject | ConvertTo-Json -Compress
    Set-Content -Path $BodyFile -Value $json -Encoding ascii
    az rest --method POST --uri $Uri --headers "Content-Type=application/json" --body "@$BodyFile" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed: $FailureLabel (az rest exit $LASTEXITCODE)" }
}

if (-not $WhatIf) {
    Step "Connecting to Exchange Online"
    Connect-ExchangeOnline -ShowBanner:$false
    Ok "Exchange Online connected"
} else {
    Step "WhatIf mode - no Exchange Online connection, no mutations"
}

Step "Connecting to Azure (device code)"
az login --use-device-code --allow-no-subscriptions | Out-Null
if ($LASTEXITCODE -ne 0) { throw "az login failed" }
$account = az account show -o json | ConvertFrom-Json
Ok "Azure CLI connected (tenant: $($account.tenantDefaultDomain ?? $account.tenantId))"

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

$mailRoleId  = ($graphSp.appRoles | Where-Object { $_.value -eq "Mail.ReadWrite" -and $_.allowedMemberTypes -contains "Application" }).id
$filesRoleId = ($graphSp.appRoles | Where-Object { $_.value -eq "Files.Read.All"  -and $_.allowedMemberTypes -contains "Application" }).id
Ok "Discovered app + role ids"

Step "Task 1.1 - Shared mailbox $MailboxAddress"
if ($WhatIf) {
    Plan "create shared mailbox $MailboxAddress ('$MailboxDisplayName') if absent"
} else {
    $existingMailbox = Get-Mailbox -Identity $MailboxAddress -ErrorAction SilentlyContinue
    if (-not $existingMailbox) {
        New-Mailbox -Shared -Name $MailboxDisplayName -DisplayName $MailboxDisplayName -Alias $MailboxAlias -PrimarySmtpAddress $MailboxAddress | Out-Null
        Ok "Created shared mailbox"
        Info "Waiting 30s for propagation..."
        Start-Sleep -Seconds 30
    } else {
        Skip2 "Mailbox exists"
    }
}

Step "Task 1.2 - Grant Mail.ReadWrite"
$existing = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" --query "value[?appRoleId=='$mailRoleId' && resourceId=='$graphSpId']" -o json | ConvertFrom-Json
if (-not $existing) {
    if ($WhatIf) {
        Plan "grant Mail.ReadWrite (appRoleId $mailRoleId) to SPN $dr3SpId"
    } else {
        Invoke-GraphPost `
            -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" `
            -BodyObject @{ principalId = $dr3SpId; resourceId = $graphSpId; appRoleId = $mailRoleId } `
            -FailureLabel "grant Mail.ReadWrite"
        Ok "Granted Mail.ReadWrite"
    }
} else {
    Skip2 "Mail.ReadWrite already granted"
}

Step "Task 1.3 - Scope Mail.ReadWrite to $MailboxAddress only"
if ($WhatIf) {
    Plan "create security group $ScopingGroupAddress with member $MailboxAddress if absent"
    Plan "create ApplicationAccessPolicy (RestrictAccess) for app $AppId scoped to $ScopingGroupAddress if absent"
} else {
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
}

Step "Task 2 - Grant Files.Read.All"
$existing = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" --query "value[?appRoleId=='$filesRoleId' && resourceId=='$graphSpId']" -o json | ConvertFrom-Json
if (-not $existing) {
    if ($WhatIf) {
        Plan "grant Files.Read.All (appRoleId $filesRoleId) to SPN $dr3SpId"
    } else {
        Invoke-GraphPost `
            -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" `
            -BodyObject @{ principalId = $dr3SpId; resourceId = $graphSpId; appRoleId = $filesRoleId } `
            -FailureLabel "grant Files.Read.All"
        Ok "Granted Files.Read.All"
    }
} else {
    Skip2 "Files.Read.All already granted"
}

if ($WhatIf) {
    Write-Host "`n=== WhatIf complete - nothing was changed ===" -ForegroundColor Magenta
    return
}

Step "Verification"
Info "Mailbox record:"
Get-Mailbox -Identity $MailboxAddress | Format-Table DisplayName, PrimarySmtpAddress, RecipientTypeDetails -AutoSize

Info "Scoped access allowed?"
Test-ApplicationAccessPolicy -Identity $MailboxAddress -AppId $AppId |
    Format-Table @{ Label = 'Identity'; Expression = { $_.Identity }; Width = 44 },
                 @{ Label = 'AccessCheckResult'; Expression = { $_.AccessCheckResult }; Width = 20 }

Info "Granted assignments:"
$assignments = az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$dr3SpId/appRoleAssignments" --query "value[?resourceId=='$graphSpId']" -o json | ConvertFrom-Json
$rows = foreach ($a in $assignments) {
    # Capture the outer loop's values BEFORE the nested Where-Object: inside the
    # inner pipeline, $_ is the appRole being tested, not $a. A naive $_.appRoleId
    # here silently yields empty role names (bit us on the 2026-07-09 run).
    $roleId  = $a.appRoleId
    $granted = $a.createdDateTime
    $roleName = ($graphSp.appRoles | Where-Object { $_.id -eq $roleId }).value
    [PSCustomObject]@{ Permission = $roleName; GrantedAt = $granted }
}
$rows | Format-Table -AutoSize

Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host "  Mailbox:       $MailboxAddress" -ForegroundColor White
Write-Host "  App:           $DR3VisionAppName ($AppId)" -ForegroundColor White
Write-Host "  Permissions:   Mail.ReadWrite (scoped) + Files.Read.All" -ForegroundColor White
