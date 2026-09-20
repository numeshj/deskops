#requires -version 5.1
<#
  Desk Ops - run locally with no Docker, no installers, no admin rights.

  Why this file exists: Docker Desktop needs hardware virtualisation, and on a
  locked-down corporate machine that is usually switched off in the BIOS and
  not something you are allowed to change. Nothing here needs it.

  What it does, all inside this project folder:

      runtime\node\       portable Node.js   (a zip, extracted - not installed)
      runtime\mariadb\    portable MariaDB   (a zip, extracted - not installed)
      runtime\data\       the database files
      runtime\logs\       server + database logs

  Nothing is written outside this folder. No service is registered, no registry
  key is touched, no PATH is changed. Deleting runtime\ undoes everything.
#>

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"   # Invoke-WebRequest is ~10x faster without the progress bar

# --- where everything lives --------------------------------------------------
$Root    = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root "runtime"
$NodeDir = Join-Path $Runtime "node"
$MariaDir= Join-Path $Runtime "mariadb"
$DataDir = Join-Path $Runtime "data"
$LogDir  = Join-Path $Runtime "logs"
$IniFile = Join-Path $Runtime "my.ini"
$PidFile = Join-Path $Runtime "pids.txt"

$DbPort   = 3307        # not 3306, so it cannot clash with anything already installed
$AppPort  = 4000
$DbPass   = "deskops"

# Pinned versions. If a download 404s, these are the two lines to bump.
$NodeVersion  = "v22.23.2"
$MariaVersion = "11.4.13"
$NodeUrl  = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
$MariaUrl = "https://archive.mariadb.org/mariadb-$MariaVersion/winx64-packages/mariadb-$MariaVersion-winx64.zip"

function Say   ($m) { Write-Host "  $m" }
function Step  ($n,$m) { Write-Host ""; Write-Host "  [$n] $m" -ForegroundColor Cyan }
function Ok    ($m) { Write-Host "      $m" -ForegroundColor Green }
function Warn  ($m) { Write-Host "      $m" -ForegroundColor Yellow }
function Die   ($m) {
  Write-Host ""
  Write-Host "  ---------------------------------------------------------" -ForegroundColor Red
  Write-Host "   STOPPED" -ForegroundColor Red
  Write-Host "  ---------------------------------------------------------" -ForegroundColor Red
  Write-Host ""
  $m -split "`n" | ForEach-Object { Write-Host "  $_" }
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor White
Write-Host "    Desk Ops  -  local run, no Docker" -ForegroundColor White
Write-Host "  ===========================================" -ForegroundColor White

New-Item -ItemType Directory -Force -Path $Runtime,$LogDir | Out-Null

# Corporate networks almost always sit behind a proxy. Borrowing the one the
# system browser already uses is what makes the downloads work on a work laptop.
try {
  $wp = [System.Net.WebRequest]::GetSystemWebProxy()
  $wp.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
  [System.Net.WebRequest]::DefaultWebProxy = $wp
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
} catch { }

# -----------------------------------------------------------------------------
function Get-Zip {
  param([string]$Url, [string]$ZipPath, [string]$Label)

  if (Test-Path $ZipPath) { Ok "$Label zip already downloaded."; return }

  Say "Downloading $Label ..."
  Say "  $Url"
  try {
    Invoke-WebRequest -Uri $Url -OutFile "$ZipPath.part" -UseBasicParsing -TimeoutSec 900
    Move-Item "$ZipPath.part" $ZipPath -Force
  } catch {
    Remove-Item "$ZipPath.part" -Force -ErrorAction SilentlyContinue
    Die @"
Could not download $Label.

  $($_.Exception.Message)

This is nearly always the office network blocking the download, not a
problem with the app. You can do it by hand instead:

  1. Open this link in your browser:
       $Url
  2. Save the file as:
       $ZipPath
  3. Run this script again. It will find the file and carry on.
"@
  }
  Ok "Downloaded."
}

function Expand-Into {
  param([string]$ZipPath, [string]$Target, [string]$Label)

  $tmp = Join-Path $Runtime ("_x_" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  Say "Extracting $Label ..."
  # tar.exe ships with Windows 10 1803+ and is several times faster than
  # Expand-Archive on an archive this size. Fall back if it is missing.
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    & tar.exe -xf $ZipPath -C $tmp
    if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $ZipPath -DestinationPath $tmp -Force }
  } else {
    Expand-Archive -Path $ZipPath -DestinationPath $tmp -Force
  }

  # A half-extracted folder from an interrupted run would make Move-Item nest
  # the new copy inside the old one, which is a confusing failure. Clear it.
  if (Test-Path $Target) { Remove-Item $Target -Recurse -Force -ErrorAction SilentlyContinue }

  # Both zips contain a single versioned top-level folder; lift its contents up.
  $inner = Get-ChildItem $tmp -Directory
  if ($inner.Count -eq 1) {
    Move-Item $inner[0].FullName $Target -Force
  } else {
    Move-Item $tmp $Target -Force
    $tmp = $null
  }
  if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  Ok "Extracted."
}

function Wait-ForPort {
  param([int]$Port, [int]$Seconds, [string]$Label)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $c.Connect("127.0.0.1", $Port)
      $c.Close()
      return $true
    } catch { Start-Sleep -Milliseconds 700 }
  }
  return $false
}

# =============================================================================
Step 1 "Checking the project folder"

foreach ($need in @("server\src\index.js", "db\001_schema.sql")) {
  if (-not (Test-Path (Join-Path $Root $need))) {
    Die "This script is not sitting in the Desk Ops folder - '$need' is missing.`nIt must stay in the same folder as server\ and db\."
  }
}
Ok "Found the app."

# Dependencies and the built web app ship as one zip so that npm never has to
# run here - npm is the step most likely to be blocked on a work network.
$depsZip = Join-Path $Root "deskops-offline-deps.zip"
$haveDeps = (Test-Path (Join-Path $Root "server\node_modules\express")) -and (Test-Path (Join-Path $Root "web\dist\index.html"))
if (-not $haveDeps) {
  if (Test-Path $depsZip) {
    Say "Unpacking the bundled dependencies ..."
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) { & tar.exe -xf $depsZip -C $Root } else { Expand-Archive -Path $depsZip -DestinationPath $Root -Force }
    Ok "Unpacked."
  } else {
    Die "server\node_modules or web\dist is missing, and deskops-offline-deps.zip is not here either.`nAsk for deskops-offline-deps.zip and drop it in:`n  $Root"
  }
}
Ok "Dependencies and web build are in place."

# =============================================================================
Step 2 "Node.js (portable - nothing is installed)"

$NodeExe = Join-Path $NodeDir "node.exe"
if (-not (Test-Path $NodeExe)) {
  $z = Join-Path $Runtime "node.zip"
  Get-Zip  -Url $NodeUrl -ZipPath $z -Label "Node.js $NodeVersion (~36 MB)"
  Expand-Into -ZipPath $z -Target $NodeDir -Label "Node.js"
}
if (-not (Test-Path $NodeExe)) { Die "Node did not extract properly. Delete the runtime folder and run this again." }
Ok ("Node " + (& $NodeExe -v))

# =============================================================================
Step 3 "MariaDB (portable - nothing is installed, no Windows service)"

$MariaD    = Join-Path $MariaDir "bin\mariadbd.exe"
$MariaCli  = Join-Path $MariaDir "bin\mariadb.exe"
$MariaInit = Join-Path $MariaDir "bin\mariadb-install-db.exe"

if (-not (Test-Path $MariaD)) {
  $z = Join-Path $Runtime "mariadb.zip"
  Get-Zip -Url $MariaUrl -ZipPath $z -Label "MariaDB $MariaVersion (~110 MB - this is the slow one)"
  Expand-Into -ZipPath $z -Target $MariaDir -Label "MariaDB"
}
if (-not (Test-Path $MariaD)) { Die "MariaDB did not extract properly. Delete the runtime folder and run this again." }
Ok "MariaDB is here."

# my.ini - bound to this machine only, on a port nothing else uses.
@"
[mysqld]
datadir=$($DataDir -replace '\\','/')
port=$DbPort
bind-address=127.0.0.1
skip-name-resolve
log-error=$(($LogDir -replace '\\','/'))/mariadb.log
innodb_buffer_pool_size=128M
max_connections=30
"@ | Set-Content -Path $IniFile -Encoding ASCII

if (-not (Test-Path (Join-Path $DataDir "mysql"))) {
  Say "First run - creating the database files ..."
  $initLog = Join-Path $LogDir "mariadb-install.log"
  & $MariaInit --datadir="$DataDir" --port=$DbPort --password=$DbPass -R 2>&1 |
    Tee-Object -FilePath $initLog | Out-Null
  if (-not (Test-Path (Join-Path $DataDir "mysql"))) {
    Write-Host ""
    Get-Content $initLog -Tail 20 -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    Die "Could not create the database files. The last lines of the attempt are above.`nFull log: $initLog"
  }
  Ok "Database created."
} else {
  Ok "Database already exists - keeping your data."
}

# =============================================================================
Step 4 "Starting the database"

if (Wait-ForPort -Port $DbPort -Seconds 1) {
  Ok "Already running on port $DbPort."
} else {
  $p = Start-Process -FilePath $MariaD -ArgumentList "--defaults-file=`"$IniFile`"" `
        -WorkingDirectory $MariaDir -WindowStyle Hidden -PassThru
  "mariadb=$($p.Id)" | Set-Content $PidFile
  if (-not (Wait-ForPort -Port $DbPort -Seconds 60)) {
    Die "The database did not start within 60 seconds.`nThe reason will be at the bottom of:`n  $LogDir\mariadb.log"
  }
  Ok "Running on port $DbPort."
}

# Find a working admin login. Exactly which root accounts mariadb-install-db
# creates, and whether they carry the password we asked for, varies between
# MariaDB builds - and a host-specific row like root@127.0.0.1 silently wins
# over root@'%'. Rather than depend on that, try the two possibilities.
$adminArgs = $null
foreach ($cand in @(@("root", $DbPass), @("root", ""))) {
  $a = @("-h","127.0.0.1","-P","$DbPort","-u",$cand[0])
  if ($cand[1]) { $a += "-p$($cand[1])" }
  & $MariaCli @a -e "SELECT 1" 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $adminArgs = $a; break }
}
if (-not $adminArgs) {
  Die @"
The database is running but would not accept an administrator login.

The fix is to rebuild the local database from scratch:

  1. Run stop-local.bat
  2. Delete this folder:  $DataDir
  3. Run run-local.bat again

That wipes the local database only. The CSVs in migrated\ are untouched, so
everything reloads automatically.
"@
}

# The app gets its own account rather than using root - it only ever needs the
# one schema, and it keeps the running app off an administrator login.
$sql = "CREATE DATABASE IF NOT EXISTS deskops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" +
       "CREATE USER IF NOT EXISTS 'deskops'@'%' IDENTIFIED BY '$DbPass';" +
       "GRANT ALL PRIVILEGES ON deskops.* TO 'deskops'@'%';" +
       "FLUSH PRIVILEGES;"
& $MariaCli @adminArgs -e $sql 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die "Could not create the 'deskops' schema and user. See $LogDir\mariadb.log" }

& $MariaCli -h 127.0.0.1 -P $DbPort -u deskops "-p$DbPass" -e "SELECT 1" deskops 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die "Created the 'deskops' account but could not log in with it. See $LogDir\mariadb.log" }
Ok "Schema and app account ready."

# =============================================================================
Step 5 "Settings"

$envFile = Join-Path $Root "server\.env"
if (-not (Test-Path $envFile)) {
  $secret = -join ((48..57)+(97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
  @"
NODE_ENV=development
PORT=$AppPort
DB_HOST=127.0.0.1
DB_PORT=$DbPort
DB_USER=deskops
DB_PASSWORD=$DbPass
DB_NAME=deskops
DB_POOL=5
JWT_SECRET=$secret
SERVE_WEB=1
MIGRATE_ON_BOOT=1
"@ | Set-Content -Path $envFile -Encoding ASCII
  Ok "Wrote server\.env"
} else {
  Ok "server\.env already exists - leaving it alone."
}

# =============================================================================
Step 6 "Loading her history (first run only)"

$marker = Join-Path $Runtime ".seeded"
if (Test-Path $marker) {
  Ok "Already loaded."
} else {
  $mig = Join-Path $Root "migrated"
  if (-not (Test-Path (Join-Path $mig "activities.csv"))) {
    Warn "The migrated\ folder is missing, so the app will start empty."
    Warn "That is fine for a first look - the capture screen works either way."
  }

  Say "Applying the schema ..."
  & $NodeExe (Join-Path $Root "server\src\db\migrate.js")
  if ($LASTEXITCODE -ne 0) { Die "The schema did not apply. The error is just above." }

  # Exit code 0 is not proof on its own - a script that does nothing at all also
  # exits 0, and that is exactly how this failed once. Check a real table.
  & $MariaCli -h 127.0.0.1 -P $DbPort -u deskops "-p$DbPass" -e "SELECT 1 FROM app_user LIMIT 0" deskops 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Die "The schema step reported success but the tables are not there.`nSend me runtime\logs\mariadb.log and I will look."
  }

  Say "Creating the two sign-in accounts ..."
  & $NodeExe (Join-Path $Root "server\src\db\seedUsers.js")
  if ($LASTEXITCODE -ne 0) { Die "Could not create the accounts. The error is just above." }

  if (Test-Path (Join-Path $mig "activities.csv")) {
    Say "Loading 13 months of the workbook ..."
    & $NodeExe (Join-Path $Root "server\src\import.js") $mig
    if ($LASTEXITCODE -ne 0) { Die "The import failed. The error is just above.`nIt is safe to run this script again - the import updates rather than duplicates." }
  }

  Set-Content $marker (Get-Date -Format s)
  Ok "Loaded."
}

# =============================================================================
Step 7 "Starting the app"

$health = "http://127.0.0.1:$AppPort/api/health"
$alreadyUp = $false
try { Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2 | Out-Null; $alreadyUp = $true } catch { }

if ($alreadyUp) {
  Ok "Already running."
} else {
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
}

# =============================================================================
Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host "    Ready:  http://localhost:$AppPort" -ForegroundColor Green
Write-Host ""
Write-Host "    yashoda@example.com  /  desk1234"
Write-Host "    admin@example.com    /  admin1234"
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host ""
Say "Both the app and the database keep running in the background."
Say "Double-click stop-local.bat when you are finished."
Write-Host ""

Start-Process "http://localhost:$AppPort"
