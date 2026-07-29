# ─────────────────────────────────────────────────────────────────────────────
# DR3-Vision — authorize docs-dr3@svdp.us for document ingestion (ADR-0067)
#
# WHY: the DR3-Vision enterprise app has appRoleAssignmentRequired = $true, so
# Entra refuses ANY sign-in from an identity that is not assigned to it. That is
# what produced "Your Microsoft account isn't authorized for DR3-Vision. Ask an
# admin to add you." — a Microsoft page that names the app, not a Vision error.
#
# This script is IDEMPOTENT and READ-BEFORE-WRITE. It changes nothing that is
# already correct, and it prints what it actually did rather than what it
# intended to do. Safe to re-run.
#
# NOTE: the failed sign-in already tells us docs-dr3 is NOT a member of
# "DR3-Vision Admin Access" — group assignment would have satisfied the
# requirement for its members. Step 3 is therefore expected to be a no-op; it
# exists because you asked for it and because it costs nothing to be sure.
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Stop'

# --- Constants (verified live via Graph on 2026-07-29) -----------------------
$ServicePrincipalId = '76787659-f9a8-4f48-96c3-d0d77d2719fe'   # DR3-Vision SP
$ServiceUpn         = 'docs-dr3@svdp.us'
$AdminGroupName     = 'DR3-Vision Admin Access'
# Entra's "default access" role — the role an app exposes when it declares no
# custom app roles. This is the correct value to satisfy assignment-required.
$DefaultAccessRole  = '00000000-0000-0000-0000-000000000000'

Connect-MgGraph -Scopes @(
  'AppRoleAssignment.ReadWrite.All',   # write the assignment
  'Application.Read.All',              # read the service principal
  'User.Read.All',                     # resolve docs-dr3
  'GroupMember.ReadWrite.All',         # remove from the group if present
  'Group.Read.All'                     # find the group
)

# --- 0. Resolve the service account ------------------------------------------
$user = Get-MgUser -UserId $ServiceUpn -Property Id, DisplayName, AccountEnabled
Write-Host "Service account : $($user.DisplayName) <$ServiceUpn>"
Write-Host "  object id     : $($user.Id)"
Write-Host "  enabled       : $($user.AccountEnabled)"
if (-not $user.AccountEnabled) {
  Write-Warning 'Account is DISABLED — assignment will not make sign-in work until it is enabled.'
}

# --- 1. Confirm the app really does require assignment ------------------------
$sp = Get-MgServicePrincipal -ServicePrincipalId $ServicePrincipalId `
        -Property Id, DisplayName, AppRoleAssignmentRequired
Write-Host ""
Write-Host "App             : $($sp.DisplayName)"
Write-Host "  assignment required : $($sp.AppRoleAssignmentRequired)"
if (-not $sp.AppRoleAssignmentRequired) {
  Write-Host "  NOTE: assignment is NOT required on this app — the sign-in failure has a different cause." -ForegroundColor Yellow
}

# --- 2. Assign the service account (skip if already assigned) -----------------
$existing = Get-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $ServicePrincipalId -All |
            Where-Object { $_.PrincipalId -eq $user.Id }

Write-Host ""
if ($existing) {
  Write-Host "[skip]  Already assigned to $($sp.DisplayName) — nothing to do." -ForegroundColor Green
} else {
  New-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $ServicePrincipalId `
    -PrincipalId $user.Id `
    -ResourceId  $ServicePrincipalId `
    -AppRoleId   $DefaultAccessRole | Out-Null
  Write-Host "[done]  Assigned $ServiceUpn to $($sp.DisplayName)." -ForegroundColor Green
}

# --- 3. Remove from the admin group, ONLY if it is actually a member ----------
# Rationale for removing: a service account in a group named "Admin Access"
# implies privileges it should not have, and in six months nobody will recall it
# was only there to satisfy an assignment check. The direct assignment above
# says exactly what it is.
Write-Host ""
$group = Get-MgGroup -Filter "displayName eq '$AdminGroupName'" -Property Id, DisplayName |
         Select-Object -First 1

if (-not $group) {
  Write-Host "[skip]  Group '$AdminGroupName' not found — nothing to remove." -ForegroundColor Yellow
} else {
  $isMember = Get-MgGroupMember -GroupId $group.Id -All |
              Where-Object { $_.Id -eq $user.Id }
  if ($isMember) {
    Remove-MgGroupMemberByRef -GroupId $group.Id -DirectoryObjectId $user.Id
    Write-Host "[done]  Removed $ServiceUpn from '$AdminGroupName'." -ForegroundColor Green
    Write-Host "        (Direct app assignment above keeps sign-in working.)"
  } else {
    Write-Host "[skip]  $ServiceUpn is NOT a member of '$AdminGroupName' — nothing to remove." -ForegroundColor Green
    Write-Host "        Expected: the sign-in failure implied this already."
  }
}

# --- 4. Verify the end state -------------------------------------------------
Write-Host ""
Write-Host "── Final assignments on $($sp.DisplayName) ──"
Get-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $ServicePrincipalId -All |
  Select-Object PrincipalType, PrincipalDisplayName |
  Sort-Object PrincipalType, PrincipalDisplayName |
  Format-Table -AutoSize

Write-Host "Next: open https://dr3-vision.svdp.us/admin/doc-ingest/connect and click"
Write-Host "Connect, signing in as $ServiceUpn (NOT as yourself — the surface asserts"
Write-Host "the UPN and will refuse a different account rather than silently connecting"
Write-Host "your own OneDrive)."
