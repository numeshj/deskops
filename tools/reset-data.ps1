#requires -version 5.1
<#
  Desk Ops - erase the database and reload only the real workbook data.

  Why this exists: testing put roughly a thousand invented records into your
  copy - test stores, test calls, a "Playwright allocation", stock ticks from
  the browser suite. None of it is Yashoda's. This throws the whole database
  away and rebuilds it from the CSVs in migrated\, which are the 13 months of
  her workbook and nothing else.

  What is erased:  everything currently in the database, including anything
                   captured in the app since it was loaded.
  What is kept:    the migrated\ CSVs, the runtime folder, server\.env, and
                   the two sign-in accounts (they are recreated).

  Nothing outside this project folder is touched.
#>

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$Root     = Split-Path -Parent $PSScriptRoot
$Runtime  = Join-Path $Root "runtime"
$NodeExe  = Join-Path $Runtime "node\node.exe"
$MariaDir = Join-Path $Runtime "mariadb"
$MariaD   = Join-Path $MariaDir "bin\mariadbd.exe"
$MariaCli = Join-Path $MariaDir "bin\mariadb.exe"
$IniFile  = Join-Path $Runtime "my.ini"
$LogDir   = Join-Path $Runtime "logs"
$PidFile  = Join-Path $Runtime "pids.txt"
$Migrated = Join-Path $Root "migrated"

$DbPort  = 3307
$AppPort = 4000
$DbPass  = "deskops"

function Say  ($m) { Write-Host "  $m" }
function Step ($n,$m) { Write-Host ""; Write-Host "  [$n] $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "      $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "      $m" -ForegroundColor Yellow }
function Die  ($m) {
  Write-Host ""
  Write-Host "  ---------------------------------------------------------" -ForegroundColor Red
  Write-Host "   STOPPED" -ForegroundColor Red
  Write-Host "  ---------------------------------------------------------" -ForegroundColor Red
  Write-Host ""
  $m -split "`n" | ForEach-Object { Write-Host "  $_" }
  Write-Host ""
  exit 1
}

function Wait-ForPort {
  param([int]$Port, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $c.Connect("127.0.0.1", $Port); $c.Close(); return $true
    } catch { Start-Sleep -Milliseconds 700 }
  }
  return $false
}

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor White
Write-Host "    Desk Ops  -  reload the real data" -ForegroundColor White
Write-Host "  ===========================================" -ForegroundColor White

# =============================================================================
Step 1 "Checking what is here"

if (-not (Test-Path $NodeExe))  { Die "Node is not set up yet.`nRun run-local.bat once first, then come back to this." }
if (-not (Test-Path $MariaCli)) { Die "MariaDB is not set up yet.`nRun run-local.bat once first, then come back to this." }
if (-not (Test-Path (Join-Path $Migrated "activities.csv"))) {
  Die @"
The migrated\ folder has no activities.csv in it, so there would be nothing
to reload and this would leave you with an empty database.

Expected:
  $Migrated\activities.csv
"@
}
$csvCount = (Get-ChildItem $Migrated -Filter *.csv -ErrorAction SilentlyContinue).Count
Ok "Found $csvCount CSV files in migrated\."

# =============================================================================
Step 2 "This erases the database"

Write-Host ""
Write-Host "      Everything currently in the database goes, including" -ForegroundColor Yellow
Write-Host "      anything captured in the app since it was set up." -ForegroundColor Yellow
Write-Host "      It is rebuilt from migrated\ - her workbook, nothing else." -ForegroundColor Yellow
Write-Host ""
$answer = Read-Host "      Type  ERASE  to go ahead (anything else cancels)"
if ($answer -ne "ERASE") {
  Write-Host ""
  Ok "Cancelled. Nothing was changed."
  Write-Host ""
  exit 0
}

# =============================================================================
Step 3 "Stopping the app"

# The app only, not the database - we need the database up to do the work.
# Matching on Path keeps this to Node processes from this project's runtime
# folder, so a Node belonging to something else on the machine is left alone.
$stopped = 0
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    if ($_.Path -and ($_.Path -eq $NodeExe)) { Stop-Process -Id $_.Id -Force; $stopped++ }
  } catch { }
}
if ($stopped) { Ok "App stopped." } else { Ok "App was not running." }
Start-Sleep -Milliseconds 600

# =============================================================================
Step 4 "Making sure the database is running"

if (Wait-ForPort -Port $DbPort -Seconds 1) {
  Ok "Already running on port $DbPort."
} else {
  if (-not (Test-Path $IniFile)) { Die "runtime\my.ini is missing. Run run-local.bat once first." }
  $p = Start-Process -FilePath $MariaD -ArgumentList "--defaults-file=`"$IniFile`"" `
        -WorkingDirectory $MariaDir -WindowStyle Hidden -PassThru
  "mariadb=$($p.Id)" | Set-Content $PidFile
  if (-not (Wait-ForPort -Port $DbPort -Seconds 60)) {
    Die "The database did not start within 60 seconds.`nThe reason will be at the bottom of:`n  $LogDir\mariadb.log"
  }
  Ok "Started on port $DbPort."
}

# Same reason as in run-local.ps1: which root account carries the password
# varies between MariaDB builds, and a host-specific row like root@127.0.0.1
# silently wins over root@'%'. Try both rather than assume.
$adminArgs = $null
foreach ($cand in @($DbPass, "")) {
  $a = @("-h","127.0.0.1","-P","$DbPort","-u","root")
  if ($cand) { $a += "-p$cand" }
  & $MariaCli @a -e "SELECT 1" 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $adminArgs = $a; break }
}
if (-not $adminArgs) {
  Die @"
The database is running but would not accept an administrator login, so the
old data cannot be dropped.

The fix is to rebuild the local database from scratch:

  1. Run stop-local.bat
  2. Delete this folder:  $Runtime\data
  3. Run run-local.bat again

That reloads migrated\ automatically, which is the same end result as this
script - it just takes a little longer.
"@
}

# =============================================================================
Step 5 "Erasing"

# DROP DATABASE rather than DELETE FROM: it takes the tables, the indexes and
# every AUTO_INCREMENT counter with it. Deleting rows one table at a time
# leaves ids continuing from 4586, which makes the reloaded data look like it
# has a history it does not have.
$sql = "DROP DATABASE IF EXISTS deskops;" +
       "CREATE DATABASE deskops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" +
       "CREATE USER IF NOT EXISTS 'deskops'@'%' IDENTIFIED BY '$DbPass';" +
       "GRANT ALL PRIVILEGES ON deskops.* TO 'deskops'@'%';" +
       "FLUSH PRIVILEGES;"
& $MariaCli @adminArgs -e $sql 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die "Could not drop and recreate the database. See $LogDir\mariadb.log" }
Ok "Database is empty."

# =============================================================================
Step 6 "Rebuilding"

Say "Applying the schema ..."
& $NodeExe (Join-Path $Root "server\src\db\migrate.js")
if ($LASTEXITCODE -ne 0) { Die "The schema did not apply. The error is just above." }

# Exit code 0 is not proof on its own - a script that does nothing at all also
# exits 0, and that is exactly how this failed once. Check a real table.
& $MariaCli -h 127.0.0.1 -P $DbPort -u deskops "-p$DbPass" -e "SELECT 1 FROM app_user LIMIT 0" deskops 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Die "The schema step reported success but the tables are not there.`nSend me runtime\logs\mariadb.log and I will look."
}
Ok "Schema applied."

Say "Creating the two sign-in accounts ..."
& $NodeExe (Join-Path $Root "server\src\db\seedUsers.js")
if ($LASTEXITCODE -ne 0) { Die "Could not create the accounts. The error is just above." }
Ok "Accounts created."

Say "Loading 13 months of the workbook ..."
& $NodeExe (Join-Path $Root "server\src\import.js") $Migrated
if ($LASTEXITCODE -ne 0) { Die "The import failed. The error is just above." }

Set-Content (Join-Path $Runtime ".seeded") (Get-Date -Format s)

# =============================================================================
Step 7 "Counting what is in there now"

# Deliberately one line. PowerShell hands a native .exe a single command-line
# string, and an argument with newlines inside it is the sort of thing that
# works on one Windows build and not the next.
$check = "SELECT 'store' t, COUNT(*) n FROM store" +
  " UNION ALL SELECT 'store_contact', COUNT(*) FROM store_contact" +
  " UNION ALL SELECT 'product', COUNT(*) FROM product" +
  " UNION ALL SELECT 'order_ref', COUNT(*) FROM order_ref" +
  " UNION ALL SELECT 'reason', COUNT(*) FROM reason" +
  " UNION ALL SELECT 'activity', COUNT(*) FROM activity" +
  " UNION ALL SELECT 'activity_line', COUNT(*) FROM activity_line" +
  " UNION ALL SELECT 'stock_oos', COUNT(*) FROM stock_oos" +
  " UNION ALL SELECT 'campaign_line', COUNT(*) FROM campaign_line" +
  " UNION ALL SELECT 'unlisted_cluster', COUNT(*) FROM unlisted_cluster" +
  " UNION ALL SELECT 'not from the workbook', COUNT(*) FROM activity WHERE source_sheet IS NULL OR source_sheet = ''"
Write-Host ""
& $MariaCli -h 127.0.0.1 -P $DbPort -u deskops "-p$DbPass" -t -e $check deskops 2>&1 |
  ForEach-Object { Write-Host "      $_" }

Say ""
Say "Every row the import writes carries the workbook sheet it came from, and"
Say "nothing else does. So 'not from the workbook' must read 0. Once you start"
Say "using the app it will climb, and that is your own work, which is the point."

# =============================================================================
Step 8 "Starting the app again"

$health = "http://127.0.0.1:$AppPort/api/health"
$out = Join-Path $LogDir "app.log"
$err = Join-Path $LogDir "app.err.log"
$p = Start-Process -FilePath $NodeExe -ArgumentList "`"$(Join-Path $Root 'server\src\index.js')`"" `
      -WorkingDirectory (Join-Path $Root "server") -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $out -RedirectStandardError $err
Add-Content $PidFile "app=$($p.Id)"

$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 750
  try { Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break } catch { }
}
if (-not $up) {
  Write-Host ""
  Get-Content $err -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
  Die "The app did not answer within 30 seconds. The last lines of its log are above.`nFull log: $err"
}
Ok "Running."

# =============================================================================
Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host "    Clean:  http://localhost:$AppPort" -ForegroundColor Green
Write-Host ""
Write-Host "    yashoda@example.com  /  desk1234"
Write-Host "    admin@example.com    /  admin1234"
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host ""
Say "Her 13 months are in. The test records are gone."
Write-Host ""

Start-Process "http://localhost:$AppPort"
