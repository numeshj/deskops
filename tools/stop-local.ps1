#requires -version 5.1
<#
  Desk Ops - stop the local (no-Docker) run.

  Only touches processes started from this project's runtime folder, so it can
  never take down a Node or MariaDB that belongs to something else on the
  machine. The database is asked to shut down properly rather than killed,
  which is what keeps the data clean.
#>

$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

$Root    = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root "runtime"
$MariaAdmin = Join-Path $Runtime "mariadb\bin\mariadb-admin.exe"
$PidFile = Join-Path $Runtime "pids.txt"
$DbPort  = 3307
$DbPass  = "deskops"

Write-Host ""
Write-Host "  Stopping Desk Ops..." -ForegroundColor Cyan
Write-Host ""

# --- the app ---------------------------------------------------------------
$nodeExe = (Join-Path $Runtime "node\node.exe")
$stopped = 0
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    if ($_.Path -and ($_.Path -eq $nodeExe)) {
      Stop-Process -Id $_.Id -Force
      $stopped++
    }
  } catch { }
}
if ($stopped) { Write-Host "      App stopped." -ForegroundColor Green }
else          { Write-Host "      App was not running." -ForegroundColor DarkGray }

# --- the database ----------------------------------------------------------
# Ask nicely first: a clean shutdown flushes InnoDB instead of leaving a
# crash-recovery log for the next start to chew through.
$dbDown = $false
if (Test-Path $MariaAdmin) {
  # Same reason as in run-local.ps1: which root account carries the password
  # varies by MariaDB build, so try both rather than assume.
  foreach ($cand in @($DbPass, "")) {
    $a = @("-h","127.0.0.1","-P","$DbPort","-u","root")
    if ($cand) { $a += "-p$cand" }
    & $MariaAdmin @a shutdown 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
  }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $c.Connect("127.0.0.1", $DbPort); $c.Close()
    } catch { $dbDown = $true; break }
  }
}

if (-not $dbDown) {
  $mariad = Join-Path $Runtime "mariadb\bin\mariadbd.exe"
  Get-Process mariadbd -ErrorAction SilentlyContinue | ForEach-Object {
    try { if ($_.Path -and ($_.Path -eq $mariad)) { Stop-Process -Id $_.Id -Force; $dbDown = $true } } catch { }
  }
}

if ($dbDown) { Write-Host "      Database stopped." -ForegroundColor Green }
else         { Write-Host "      Database was not running." -ForegroundColor DarkGray }

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "      Your data is safe. run-local.bat brings it back." -ForegroundColor Green
Write-Host ""
