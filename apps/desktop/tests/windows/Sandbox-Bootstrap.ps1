$ErrorActionPreference = 'Stop'
$result = [ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString('o'); passed = $false; checks = [ordered]@{}; error = $null }
try {
  $installer = 'C:\PiCadRelease\Pi-CAD-Setup-x64.exe'
  $result.checks.installerPresent = Test-Path -LiteralPath $installer
  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  $result.checks.installExitCode = $process.ExitCode
  $app = Join-Path $env:LOCALAPPDATA 'Programs\pi-cad-desktop\Pi-CAD.exe'
  $result.checks.appPresent = Test-Path -LiteralPath $app
  $result.checks.startMenuShortcut = Test-Path -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Pi-CAD.lnk')
  $result.checks.uninstallEntry = $null -ne (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'Pi-CAD*' | Select-Object -First 1)
  $appProcess = Start-Process -FilePath $app -ArgumentList '--pi-cad-e2e' -PassThru
  Start-Sleep -Seconds 8
  $result.checks.launch = -not $appProcess.HasExited
  $result.checks.processResponding = (Get-Process -Id $appProcess.Id).Responding
  $result.passed = @($result.checks.Values) -notcontains $false -and $process.ExitCode -eq 0
} catch {
  $result.error = $_.Exception.ToString()
} finally {
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath 'C:\PiCadResults\sandbox-result.json' -Encoding utf8
}
