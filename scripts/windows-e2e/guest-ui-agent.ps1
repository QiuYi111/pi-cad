param(
  [string]$Root = "C:\ReifyE2E"
)

$ErrorActionPreference = "Continue"
$queue = Join-Path $Root "queue"
$running = Join-Path $Root "running"
$results = Join-Path $Root "results"
$logs = Join-Path $Root "logs"
$winapp = Join-Path $Root "winapp\winapp.exe"

New-Item -ItemType Directory -Force -Path $queue, $running, $results, $logs | Out-Null
"$(Get-Date -Format o) guest UI agent started in session $([Diagnostics.Process]::GetCurrentProcess().SessionId)" |
  Add-Content (Join-Path $logs "agent.log")

while ($true) {
  Get-ChildItem -LiteralPath $queue -Filter "*.json" -ErrorAction SilentlyContinue |
    Sort-Object Name |
    ForEach-Object {
      $job = $_
      $active = Join-Path $running $job.Name
      try {
        Move-Item -LiteralPath $job.FullName -Destination $active -Force
        $request = Get-Content -Raw -LiteralPath $active | ConvertFrom-Json
        if (-not $request.id -or -not $request.arguments) {
          throw "Job must contain id and arguments"
        }

        $stdout = Join-Path $results "$($request.id).stdout.txt"
        $stderr = Join-Path $results "$($request.id).stderr.txt"
        $started = Get-Date
        if ([string]$request.arguments[0] -eq "read-window-text") {
          if (-not ("ReifyE2E.WinText" -as [type])) {
            Add-Type @'
namespace ReifyE2E {
  using System;
  using System.Text;
  using System.Runtime.InteropServices;
  public static class WinText {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  }
}
'@
          }
          $requestedPid = if ($request.arguments.Count -gt 1) { [uint32]$request.arguments[1] } else { 0 }
          $rows = [Collections.Generic.List[object]]::new()
          $collect = {
            param([IntPtr]$windowHandle)
            $textBuffer = [Text.StringBuilder]::new(2048)
            [void][ReifyE2E.WinText]::GetWindowText($windowHandle, $textBuffer, $textBuffer.Capacity)
            [uint32]$processId = 0
            [void][ReifyE2E.WinText]::GetWindowThreadProcessId($windowHandle, [ref]$processId)
            if (-not $requestedPid -or $processId -eq $requestedPid) {
              $rows.Add([ordered]@{ hwnd=$windowHandle.ToInt64(); processId=$processId; text=$textBuffer.ToString() })
            }
            return $true
          }
          [void][ReifyE2E.WinText]::EnumWindows($collect, [IntPtr]::Zero)
          foreach ($top in @($rows)) { [void][ReifyE2E.WinText]::EnumChildWindows([IntPtr]$top.hwnd, $collect, [IntPtr]::Zero) }
          $rows | Where-Object { $_.text } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stdout -Encoding UTF8
          "" | Set-Content -LiteralPath $stderr -Encoding UTF8
          [ordered]@{ id=$request.id; startedAt=$started.ToString("o"); finishedAt=(Get-Date).ToString("o"); exitCode=0; stdout=$stdout; stderr=$stderr; sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $results "$($request.id).result.json") -Encoding UTF8
          continue
        }
        if ([string]$request.arguments[0] -eq "launch-exe") {
          $executable = [string]$request.arguments[1]
          if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
            throw "Executable does not exist: $executable"
          }
          $launchArguments = @($request.arguments | Select-Object -Skip 2 | ForEach-Object { [string]$_ })
          $startInfo = [Diagnostics.ProcessStartInfo]::new()
          $startInfo.FileName = $executable
          $startInfo.UseShellExecute = $true
          if ($launchArguments.Count) { $startInfo.Arguments = ($launchArguments -join " ") }
          $launched = [Diagnostics.Process]::Start($startInfo)
          [ordered]@{
            executable = $executable
            processId = $launched.Id
            sessionId = $launched.SessionId
          } | ConvertTo-Json | Set-Content -LiteralPath $stdout -Encoding UTF8
          "" | Set-Content -LiteralPath $stderr -Encoding UTF8
          [ordered]@{
            id = $request.id
            startedAt = $started.ToString("o")
            finishedAt = (Get-Date).ToString("o")
            exitCode = 0
            stdout = $stdout
            stderr = $stderr
            sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
          } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $results "$($request.id).result.json") -Encoding UTF8
          continue
        }
        $argumentLine = (($request.arguments | ForEach-Object {
          $argument = [string]$_
          if ($argument -match '[\s"]') {
            '"' + ($argument -replace '"', '\"') + '"'
          } else {
            $argument
          }
        }) -join ' ')
        $process = Start-Process -FilePath $winapp `
          -ArgumentList $argumentLine `
          -WorkingDirectory $Root `
          -PassThru -NoNewWindow `
          -RedirectStandardOutput $stdout `
          -RedirectStandardError $stderr

        $timeoutSeconds = if ($request.timeoutSeconds) { [int]$request.timeoutSeconds } else { 60 }
        if (-not $process.WaitForExit($timeoutSeconds * 1000)) {
          $process.Kill()
          $process.WaitForExit()
          throw "winapp command timed out after $timeoutSeconds seconds: $argumentLine"
        }

        [ordered]@{
          id = $request.id
          startedAt = $started.ToString("o")
          finishedAt = (Get-Date).ToString("o")
          exitCode = $process.ExitCode
          stdout = $stdout
          stderr = $stderr
          sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $results "$($request.id).result.json") -Encoding UTF8
      } catch {
        [ordered]@{
          id = $request.id
          finishedAt = (Get-Date).ToString("o")
          error = ($_ | Out-String)
          sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $results "$($request.id).result.json") -Encoding UTF8
      } finally {
        Remove-Item -LiteralPath $active -Force -ErrorAction SilentlyContinue
      }
    }
  Start-Sleep -Milliseconds 500
}
