[CmdletBinding()]
param(
  [string]$Installer,
  [switch]$Install,
  [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
if (-not $Installer) { $Installer = Join-Path $PSScriptRoot '..\..\release\Pi-CAD-Setup-x64.exe' }
if (-not $ResultPath) { $ResultPath = Join-Path $PSScriptRoot '..\..\release\windows-host-result.json' }
$installerPath = [IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "Installer not found: $installerPath"
}

$item = Get-Item -LiteralPath $installerPath
$signatureCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
$signature = if ($signatureCommand) { Get-AuthenticodeSignature -LiteralPath $installerPath } else { [pscustomobject]@{ Status = 'NotSupported' } }
$hashCommand = Get-Command Get-FileHash -ErrorAction SilentlyContinue
$sha256 = if ($hashCommand) {
  (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
} else {
  $hashLine = certutil.exe -hashfile $installerPath SHA256 | Select-String -Pattern '^[0-9A-Fa-f]{64}$' | Select-Object -First 1
  if ($hashLine) { $hashLine.ToString().Trim() } else { 'unavailable' }
}
$result = [ordered]@{
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  installer = $installerPath
  size = $item.Length
  sha256 = $sha256
  product = $item.VersionInfo.ProductName
  version = $item.VersionInfo.FileVersion
  signature = [string]$signature.Status
  installed = $false
  launched = $false
  shortcuts = $false
  uninstallEntry = $false
  notes = @()
}

if ($item.Length -lt 50MB) { throw 'Installer is unexpectedly small; the bundled runtime is missing.' }
if ($item.VersionInfo.ProductName -ne 'Pi-CAD') { throw 'Installer product metadata is invalid.' }
if ($signature.Status -ne 'Valid') { $result.notes += 'Unsigned development build. Sign before public release.' }

if ($Install) {
  $stage = Join-Path $env:TEMP ("pi-cad-installer-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $localInstaller = Join-Path $stage 'Pi-CAD-Setup-x64.exe'
  try {
    Copy-Item -LiteralPath $installerPath -Destination $localInstaller
    Unblock-File -LiteralPath $localInstaller
    $process = Start-Process -FilePath $localInstaller -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)." }
    $app = Join-Path $env:LOCALAPPDATA 'Programs\pi-cad-desktop\Pi-CAD.exe'
    if (-not (Test-Path -LiteralPath $app)) { throw "Installed app not found: $app" }
    $result.installed = $true
    $result.shortcuts = (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Pi-CAD.lnk')) -or
      (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pi-CAD.lnk'))
    $uninstall = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
      Where-Object DisplayName -like 'Pi-CAD*' | Select-Object -First 1
    $result.uninstallEntry = $null -ne $uninstall
    $started = Start-Process -FilePath $app -ArgumentList '--pi-cad-e2e' -PassThru
    Start-Sleep -Seconds 4
    $result.launched = -not $started.HasExited
    if (-not $started.HasExited) { Stop-Process -Id $started.Id -Force }
  } finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$resultDirectory = Split-Path -Parent $ResultPath
New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ResultPath -Encoding utf8
$result | ConvertTo-Json -Depth 5
