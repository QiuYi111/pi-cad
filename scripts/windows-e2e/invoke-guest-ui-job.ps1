param(
  [string]$VMName = "Reify-E2E",
  [string]$GuestUser = "ReifyTest",
  [Parameter(Mandatory)] [string]$GuestPassword,
  [Parameter(Mandatory)] [string[]]$Arguments,
  [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
$id = "job-" + [guid]::NewGuid().ToString("N")
$credential = [pscredential]::new($GuestUser, (ConvertTo-SecureString $GuestPassword -AsPlainText -Force))
$deadline = (Get-Date).AddMinutes(2)
$session = $null
do {
  try { $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop }
  catch { Start-Sleep -Seconds 3 }
} until ($session -or (Get-Date) -ge $deadline)
if (-not $session) { throw "PowerShell Direct unavailable for $VMName after two minutes" }
try {
  $payload = @{ id = $id; arguments = $Arguments; timeoutSeconds = $TimeoutSeconds } | ConvertTo-Json -Depth 4
  Invoke-Command -Session $session -ArgumentList $id, $payload -ScriptBlock {
    param($id, $payload)
    $queue = "C:\ReifyE2E\queue"
    New-Item -ItemType Directory -Force -Path $queue | Out-Null
    Set-Content -LiteralPath (Join-Path $queue "$id.json") -Value $payload -Encoding UTF8
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $result = Invoke-Command -Session $session -ArgumentList $id -ScriptBlock {
      param($id)
      $path = "C:\ReifyE2E\results\$id.result.json"
      if (Test-Path -LiteralPath $path) {
        try { Get-Content -Raw -LiteralPath $path -ErrorAction Stop } catch { $null }
      }
    }
  } until ($result -or (Get-Date) -ge $deadline)
  if (-not $result) { throw "Timed out waiting for UI job $id" }

  $record = $result | ConvertFrom-Json
  $output = Invoke-Command -Session $session -ArgumentList $record.stdout, $record.stderr -ScriptBlock {
    param($stdout, $stderr)
    [ordered]@{
      stdout = if ($stdout -and (Test-Path -LiteralPath $stdout)) { Get-Content -Raw -LiteralPath $stdout } else { "" }
      stderr = if ($stderr -and (Test-Path -LiteralPath $stderr)) { Get-Content -Raw -LiteralPath $stderr } else { "" }
    }
  }
  [ordered]@{ result = $record; output = $output } | ConvertTo-Json -Depth 6
} finally {
  Remove-PSSession $session
}
