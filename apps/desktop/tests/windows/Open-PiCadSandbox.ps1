[CmdletBinding()]
param(
  [string]$ReleaseDirectory,
  [string]$ResultDirectory
)

$ErrorActionPreference = 'Stop'
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $PSScriptRoot '..\..\release' }
if (-not $ResultDirectory) { $ResultDirectory = Join-Path $env:LOCALAPPDATA 'Pi-CAD\sandbox-results' }
$releasePath = [IO.Path]::GetFullPath($ReleaseDirectory)
$installer = Join-Path $releasePath 'Pi-CAD-Setup-x64.exe'
if (-not (Test-Path -LiteralPath $installer)) { throw "Build the installer first: $installer" }
if (-not (Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue)) {
  throw 'Windows Sandbox is not enabled. Enable Containers-DisposableClientVM, restart Windows, then retry.'
}

$resultPath = [IO.Path]::GetFullPath($ResultDirectory)
New-Item -ItemType Directory -Path $resultPath -Force | Out-Null
$escapedRelease = [Security.SecurityElement]::Escape($releasePath)
$escapedResults = [Security.SecurityElement]::Escape($resultPath)
$bootstrap = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\PiCadRelease\sandbox\Sandbox-Bootstrap.ps1'
$configuration = @"
<Configuration>
  <MappedFolders>
    <MappedFolder><HostFolder>$escapedRelease</HostFolder><SandboxFolder>C:\PiCadRelease</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$escapedResults</HostFolder><SandboxFolder>C:\PiCadResults</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>$bootstrap</Command></LogonCommand>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <VideoInput>Disable</VideoInput>
  <AudioInput>Disable</AudioInput>
  <ProtectedClient>Enable</ProtectedClient>
  <MemoryInMB>8192</MemoryInMB>
</Configuration>
"@
$sandboxDirectory = Join-Path $releasePath 'sandbox'
New-Item -ItemType Directory -Path $sandboxDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Sandbox-Bootstrap.ps1') -Destination $sandboxDirectory -Force
$wsb = Join-Path $releasePath 'Pi-CAD-Test.wsb'
$configuration | Set-Content -LiteralPath $wsb -Encoding utf8
Start-Process -FilePath $wsb
Write-Host "Sandbox started. Results: $resultPath"
