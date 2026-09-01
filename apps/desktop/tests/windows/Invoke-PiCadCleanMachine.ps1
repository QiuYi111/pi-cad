[CmdletBinding()]
param(
  [string]$Installer,
  [switch]$InstallWsl,
  [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
if (-not $Installer) { $Installer = Join-Path $PSScriptRoot 'Pi-CAD-Setup-x64.exe' }
if (-not $ResultPath) { $ResultPath = Join-Path $PSScriptRoot 'clean-machine-result.json' }
$result = [ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString('o'); checks = [ordered]@{}; manual = [ordered]@{}; next = $null }
$installerPath = [IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $installerPath)) { throw "Installer not found: $installerPath" }

$result.checks.windows = [Environment]::OSVersion.VersionString
$result.checks.virtualization = (Get-CimInstance Win32_Processor | Where-Object VirtualizationFirmwareEnabled).Count -gt 0
$result.checks.wslBefore = @(wsl.exe -l -q 2>$null).Count -gt 0

$install = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
$result.checks.installExitCode = $install.ExitCode
$app = Join-Path $env:LOCALAPPDATA 'Programs\pi-cad-desktop\Pi-CAD.exe'
$result.checks.appPresent = Test-Path -LiteralPath $app

if ($InstallWsl -and -not $result.checks.wslBefore) {
  $wsl = Start-Process -FilePath 'wsl.exe' -ArgumentList @('--install', '--distribution', 'Ubuntu') -Verb RunAs -Wait -PassThru
  $result.checks.wslInstallExitCode = $wsl.ExitCode
  $result.next = 'Restart Windows, initialize Ubuntu, then run this script again without -InstallWsl.'
} else {
  $distributions = @(wsl.exe -l -q 2>$null | ForEach-Object { $_.Replace([char]0, '').Trim() } | Where-Object { $_ })
  $result.checks.ubuntuPresent = $distributions -contains 'Ubuntu'
  $result.checks.wslVersion = (wsl.exe --status 2>&1 | Out-String).Trim()
  $result.manual.chatgptSignIn = 'pending'
  $result.manual.projectCreatedInApp = 'pending'
  $result.manual.streamingAndToolCards = 'pending'
  $result.manual.flowerpotStepVisible = 'pending'
  $result.manual.resumeAfterRestart = 'pending'
  $result.manual.uninstallPreservesProject = 'pending'
  Start-Process -FilePath $app
  $result.next = 'Complete the visible setup, create a project, and ask: Design a simple printable flowerpot with a drainage hole and matching saucer.'
}

$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding utf8
$result | ConvertTo-Json -Depth 6
