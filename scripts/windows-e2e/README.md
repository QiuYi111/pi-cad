# Reify Windows E2E

This harness drives Reify inside the logged-in Hyper-V guest. It avoids host-side
VMConnect coordinates, DPI scaling, and nested RDP input translation.

## Components

- `guest-ui-agent.ps1`: runs in the guest user's interactive session and executes
  queued `winapp ui` commands.
- `install-guest-ui-agent.ps1`: copies the standalone Microsoft `winapp` CLI and
  registers the interactive agent.
- `invoke-guest-ui-job.ps1`: queues one command through PowerShell Direct and
  returns its exit code, stdout, and stderr.

The host may use PowerShell Direct for orchestration and evidence collection.
Product actions must go through `winapp ui` in the interactive guest session.

## Install

Download the x64 standalone archive from the official Microsoft `winappCli`
release, then run from an elevated host PowerShell:

```powershell
.\install-guest-ui-agent.ps1 `
  -VMName Reify-E2E `
  -GuestUser ReifyTest `
  -GuestPassword '<test password>' `
  -WinAppZip 'D:\Reify-VM\tooling\winappcli-x64.zip'
```

Launch Electron with renderer accessibility enabled so its web controls appear
in UI Automation:

```text
Reify.exe --force-renderer-accessibility
```

## Examples

```powershell
.\invoke-guest-ui-job.ps1 `
  -GuestPassword '<test password>' `
  -Arguments @('ui', 'inspect', '-a', 'Reify', '--interactive', '--depth', '12')

.\invoke-guest-ui-job.ps1 `
  -GuestPassword '<test password>' `
  -Arguments @('ui', 'invoke', 'Install WSL and Ubuntu', '-a', 'Reify')
```

Prefer `invoke`, `set-value`, and `wait-for`. Use screenshot-based coordinates
only when Reify does not expose an accessible control.
