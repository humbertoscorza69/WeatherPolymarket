$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pidFiles = @(
  (Join-Path $root "data/bot.pid"),
  (Join-Path $root "data/live.pid")
)

foreach ($pidFile in $pidFiles) {
  if (Test-Path $pidFile) {
    $rawPid = Get-Content -Path $pidFile -Raw
    $parsedPid = 0
    if ([int]::TryParse($rawPid.Trim(), [ref]$parsedPid)) {
      $process = Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
      if ($null -ne $process) {
        Stop-Process -Id $parsedPid -Force
        Write-Output "Stopped process $parsedPid from $pidFile"
      } else {
        Write-Output "No running process for pid $parsedPid from $pidFile"
      }
    }
    Remove-Item -Path $pidFile -Force
    Write-Output "Removed $pidFile"
  } else {
    Write-Output "No pid file at $pidFile"
  }
}

Write-Output "Open-order confirmation requires Polymarket credentials; no exchange mutation attempted by this helper."
