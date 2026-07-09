# Graph permissions setup — operator runbook

Provisions everything DR3-Vision needs from the Microsoft 365 tenant beyond the
original `Mail.Send` grant: the `approvals-dr3@svdp.us` shared mailbox,
`Mail.ReadWrite` scoped to that mailbox only (ApplicationAccessPolicy), and
tenant-wide `Files.Read.All` (ADR-0049 workbook sync).

## Execution record

**Executed against the SVDP tenant 2026-07-09** (06:55–07:00 UTC) by Bill
Barnard (Global Admin) — all three provisioning steps landed and verified
(`Test-ApplicationAccessPolicy`: mailbox → Granted, arbitrary user → Denied).
Confirmed working invocation: **PowerShell 7.6 + Azure CLI 2.88** on Windows.
Full record: `docs/handoffs/2026-07-09-it-permissions-execution-complete.md`.

## Prerequisites (one-time, operator workstation)

- PowerShell 7 (`pwsh`) — the script targets 7.6+
- Azure CLI (`az`) — 2.88 confirmed; the Microsoft.Graph PS SDK is NOT used
  (SDK 2.38.0 is incompatible with PS 7.6, which is why the script is az-pivoted)
- `Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force`
- Global Admin on the target tenant

## Running it

```powershell
# Dry-run first — prints every action, mutates nothing (Exchange not contacted):
./scripts/setup/graph-permissions-az.ps1 -WhatIf

# Real run (idempotent — re-runs report "already in place" and disturb nothing):
./scripts/setup/graph-permissions-az.ps1
```

The final Verification section must show the mailbox record, `AccessCheckResult:
Granted` for the mailbox, and BOTH `Mail.ReadWrite` and `Files.Read.All` rows
with grant timestamps. A green checkmark earlier in the run is NOT sufficient —
the 2026-07-09 execution surfaced grants that printed green but never landed
(fixed since; see below).

## House standards baked into the script (learned 2026-07-09)

1. **`az rest` bodies go via temp file on ALL platforms** (`--body "@file"`).
   Inline JSON bodies are mangled by the PowerShell/az interaction on Windows
   before Graph sees them (Bad Request). The temp-file form works everywhere —
   use it in any future script that POSTs to Graph via az.
2. **`$LASTEXITCODE` is checked after every mutating `az rest`** — az writes
   ERROR to stderr but the pipeline continues, so an unchecked call paints a
   green checkmark over a failed grant.
3. **Nested-pipeline `$_` capture** — inside `Where-Object`, `$_` is the inner
   element; outer loop values must be captured into locals first, or lookups
   silently return empty.

## Retirement

Reverse order: remove the ApplicationAccessPolicy, delete the scoping group,
remove the two app role assignments (`az rest --method DELETE` on the
assignment ids in the execution record), and delete the shared mailbox last
(30-day soft-delete window applies).
