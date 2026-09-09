param(
  [string]$VMName = "Reify-E2E",
  [string]$GuestUser = "ReifyTest",
  [Parameter(Mandatory)] [string]$GuestPassword,
  [Parameter(Mandatory)] [string]$WinAppZip,
  [string]$AgentScript = "$PSScriptRoot\guest-ui-agent.ps1"
)

$ErrorActionPreference = "Stop"
$credential = [pscredential]::new($GuestUser, (ConvertTo-SecureString $GuestPassword -AsPlainText -Force))
$deadline = (Get-Date).AddMinutes(2)
$session = $null
do {
  try { $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop }
  catch { Start-Sleep -Seconds 3 }
} until ($session -or (Get-Date) -ge $deadline)
if (-not $session) { throw "PowerShell Direct unavailable for $VMName after two minutes" }
try {
  Invoke-Command -Session $session -ArgumentList $GuestUser -ScriptBlock {
    param($GuestUser)
    New-Item -ItemType Directory -Force -Path "C:\ReifyE2E", "C:\ReifyE2E\winapp" | Out-Null
  }
  Copy-Item -ToSession $session -LiteralPath $WinAppZip -Destination "C:\ReifyE2E\winapp.zip" -Force
  Copy-Item -ToSession $session -LiteralPath $AgentScript -Destination "C:\ReifyE2E\guest-ui-agent.ps1" -Force
  Invoke-Command -Session $session -ArgumentList $GuestUser -ScriptBlock {
    param($GuestUser)
    Expand-Archive -LiteralPath "C:\ReifyE2E\winapp.zip" -DestinationPath "C:\ReifyE2E\winapp" -Force
    $exe = Get-ChildItem "C:\ReifyE2E\winapp" -Filter winapp.exe -Recurse | Select-Object -First 1
    if (-not $exe) { throw "winapp.exe not found after extraction" }
    if ($exe.DirectoryName -ne "C:\ReifyE2E\winapp") {
      Copy-Item -Path (Join-Path $exe.DirectoryName "*") -Destination "C:\ReifyE2E\winapp" -Recurse -Force
    }
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ReifyE2E\guest-ui-agent.ps1"'
    $principal = New-ScheduledTaskPrincipal -UserId $GuestUser -LogonType Interactive -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $GuestUser
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName "Reify E2E UI Agent" -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName "Reify E2E UI Agent"
    Start-Sleep -Seconds 2
    [ordered]@{
      winapp = (& "C:\ReifyE2E\winapp\winapp.exe" --version 2>&1 | Out-String).Trim()
      taskState = (Get-ScheduledTask -TaskName "Reify E2E UI Agent").State.ToString()
      agentLog = Get-Content -Tail 5 "C:\ReifyE2E\logs\agent.log" -ErrorAction SilentlyContinue
    }
  }
} finally {
  Remove-PSSession $session
}
