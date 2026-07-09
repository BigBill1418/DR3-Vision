# 2026-07-09 — IT permissions execution complete + script bugs to fix

**Executed:** 2026-07-09 06:55-07:00 UTC by Bill Barnard (Global Admin, SVDP tenant)
**Outcome:** All three provisioning steps landed cleanly against SVDP tenant.
**Purpose:** Record what actually happened, catalog the three script bugs surfaced during execution, and specify the fixes Claude Code should commit to the repo.

## §1 — Execution outcome

**Tenant:** `72843ea8-e50d-4500-a0d5-d924e9acb4d5` (SVDP)
**App:** dr3-vision, `AppId = 2da92424-7397-435d-96a1-d2a382293a53`, `SpId = 76787659-f9a8-4f48-96c3-d0d77d2719fe`

**Landed successfully:**

- **Shared mailbox** `approvals-dr3@svdp.us` provisioned (RecipientTypeDetails: SharedMailbox)
- **Scoping security group** `dr3-vision-scoped@svdp.us` (DR3-Vision-Scoped-Mailboxes) created with `approvals-dr3@svdp.us` as member
- **ApplicationAccessPolicy** created scoping the app to the scoping group only
- **`Mail.ReadWrite`** app role assignment — RoleId `e2a3a72e-5f79-4c64-b1b1-878b674786c9`, granted 2026-07-09T06:58:59Z, assignment id `WXZ4dqj5SE-Ww9DXfScZ_j3aOH99GORNgYDxvb-Oiyo`
- **`Files.Read.All`** app role assignment — RoleId `01d4889c-1287-42c6-ac1f-5d1e02578ef6`, granted 2026-07-09T06:59:33Z, assignment id `WXZ4dqj5SE-Ww9DXfScZ_v393rocp9VPh8tJ3Je-Fbk`

**Verification:**

- `Test-ApplicationAccessPolicy -Identity approvals-dr3@svdp.us -AppId 2da92424-...` → **Granted** ✓
- `Test-ApplicationAccessPolicy -Identity bill.barnard@svdp.us -AppId 2da92424-...` → **Denied** ✓ (scope narrowing works)
- Three total app role assignments on the dr3-vision SPN (Mail.ReadWrite + Files.Read.All from today; one pre-existing from 2026-06-06 with RoleId `b633e1c5-b582-4048-a93e-9f11b44c7e96` — likely the original User.Read granted at app registration, unrelated, no action)

## §2 — Bugs surfaced in `scripts/setup/graph-permissions-az.ps1`

Three bugs affected the run; all masked failures with green checkmarks and only surfaced during verification. Fixes for each below.

### §2.1 — Bug: `az rest --body` inline JSON is malformed on Windows PowerShell

**Symptom:** every `az rest --method POST` call with `--body $inlineJson` failed with:
```
ERROR: Bad Request({"error":{"code":"BadRequest","message":"Unable to read JSON request payload. Please ensure Content-Type header is set and payload is of valid JSON format."...
```

**Root cause:** on Windows, PowerShell/`az` interaction eats the braces in inline JSON before Graph sees it. Graph receives a mangled payload. The temp-file `--body @path` form works reliably.

**Fix:** every `az rest POST` in the script must write its body to `$env:TEMP\graph-body.json` first and pass `--body "@$env:TEMP\graph-body.json"`:

```powershell
# Instead of this (broken on Windows):
$body = @{ principalId = $dr3SpId; resourceId = $graphSpId; appRoleId = $mailRoleId } | ConvertTo-Json -Compress
az rest --method POST --url "..." --headers "Content-Type=application/json" --body $body

# Use this (works everywhere):
$body = @{ principalId = $dr3SpId; resourceId = $graphSpId; appRoleId = $mailRoleId } | ConvertTo-Json -Compress
Set-Content -Path "$env:TEMP\graph-body.json" -Value $body -Encoding ascii
az rest --method POST --uri "..." --headers "Content-Type=application/json" --body "@$env:TEMP\graph-body.json"
```

Two changes: `--url` → `--uri` (both work, but `--uri` is the documented canonical form), and body-via-tempfile.

### §2.2 — Bug: green checkmark printed regardless of `az rest` success

**Symptom:** the script printed `+ Granted Mail.ReadWrite` and `+ Granted Files.Read.All` even though both actual grants failed with the Bad Request above. The Verification section (which showed only the pre-existing 6/6 assignment) was the only signal that the grants hadn't landed.

**Root cause:** the script didn't check `$LASTEXITCODE` after `az rest`. `az` writes ERROR to stderr but the pipeline continues and the next statement runs regardless.

**Fix:** every `az rest POST` needs an exit-code check that throws on non-zero:

```powershell
az rest --method POST --uri "..." --headers "Content-Type=application/json" --body "@$env:TEMP\graph-body.json"
if ($LASTEXITCODE -ne 0) { throw "Failed to grant Mail.ReadWrite (az rest exit $LASTEXITCODE)" }
Ok "Granted Mail.ReadWrite"
```

Same for the Files.Read.All grant and any other `az rest` operation that mutates state.

### §2.3 — Bug: Verification section's role name lookup returned empty strings

**Symptom:** the final Verification table showed:
```
Permission GrantedAt
---------- ---------
           6/6/2026 6:44:40 AM
```

Empty `Permission` column and only one row despite three assignments actually existing (in the "hypothetical fully-working" case).

**Root cause:** classic PowerShell nested-`$_` scope bug. Inside `foreach ($a in $assignments)` the code wrote:
```powershell
$roleName = ($graphSp.appRoles | Where-Object { $_.id -eq $_.Role }).value
```
Both `$_` references point to the innermost pipeline element (the `appRole` being tested by `Where-Object`), NOT to the outer `$a`. So `$_.Role` is always `$null` and the lookup finds nothing.

**Fix:** capture the outer variable into a local before the nested pipeline:

```powershell
foreach ($a in $assignments) {
    $roleId = $a.appRoleId
    $granted = $a.createdDateTime
    $roleName = ($graphSp.appRoles | Where-Object { $_.id -eq $roleId }).value
    [PSCustomObject]@{ Permission = $roleName; GrantedAt = $granted }
} | Format-Table -AutoSize
```

## §3 — Additional script polish

- Change `az login` line to also print `Ok "Azure CLI connected (tenant: <tenant name>)"` — currently the tenant identity isn't confirmed in green-check output; only in the WARNING lines
- The `Test-ApplicationAccessPolicy` output has an empty `Identity` column in `-AutoSize` mode — not a bug, but worth swapping to `-Format` with explicit column widths for clarity
- Add a `-WhatIf` mode that prints what WOULD be done without executing, for dry-run validation before a fresh tenant install

## §4 — Repository actions for Claude Code

1. Update `scripts/setup/graph-permissions-az.ps1` (from PR #84) to apply all three fixes in §2 and the polish items in §3
2. Update `docs/operator/graph-permissions-setup.md` to note the SVDP tenant execution date (2026-07-09), the confirmed working invocation on PS 7.6 with az CLI 2.88, and the temp-file body pattern as the standard on all platforms
3. Add a `docs/handoffs/2026-07-09-it-permissions-execution-complete.md` (this file) as the historical record of the execution

## §5 — Updated blocker list for Stage 1

Down from four to two blockers:

1. ~~IT permissions grant~~ ✅ **DONE 2026-07-09** — recorded in this handoff
2. `RESTIC_PASSWORD` 1Password confirmation (P1-4) — Claude Code to build 1Password automation into the next handoff per Bill's earlier direction; script pattern: `op read op://Employee/DR3-Vision RESTIC/password` with fallback to `op item create` if not present
3. Three files for ADR-0048 promotion (Woodland `.xlsm`, Terex history, Eugene Jun 24–30 log) — Bill to supply
4. Kelsey walkthrough scheduling — Bill to schedule 7 sessions before 8/1

## §6 — What unblocks downstream

- **ADR-0046 (AP mailbox)** — Vision can now poll `approvals-dr3@svdp.us` via Graph. Blocked only on Vision-side deploy (mailbox poller code needs credentials + mailbox address in env), not on IT
- **ADR-0049 (workbook sync)** — Vision can now read Kelsey's shared Woodland daily-log via `Files.Read.All`. Blocked only on Vision-side deploy of the sync daemon, plus Bill's three files landing

Both permissions are minimally scoped in effect (Mail.ReadWrite via ApplicationAccessPolicy, Files.Read.All narrowed by "only reading a file Kelsey explicitly shares"). Rollback path documented in `graph-permissions-teardown.ps1` — no code changes needed for retirement.
