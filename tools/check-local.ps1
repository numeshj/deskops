#requires -version 5.1
<#
  Desk Ops - diagnostics.

  Run this when something did not work and you want me to look at it. It writes
  runtime\logs\diagnostics.txt and opens it. Send me that one file: it has
  everything I would otherwise have to ask you for, one question at a time.

  It contains no passwords and nothing about the business - only versions,
  file sizes, ports and error lines.
#>

$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

$Root    = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root "runtime"
$LogDir  = Join-Path $Runtime "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Out = Join-Path $LogDir "diagnostics.txt"

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line($s) { $lines.Add([string]$s) }
function Add-Head($s) { Add-Line ""; Add-Line ("== " + $s + " " + ("=" * [Math]::Max(0, 60 - $s.Length))) }

Add-Line "Desk Ops diagnostics"
Add-Line (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz")

Add-Head "Windows"
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Line ("{0}  build {1}  {2}" -f $os.Caption, $os.BuildNumber, $os.OSArchitecture)
} catch { Add-Line "could not read OS info: $($_.Exception.Message)" }
Add-Line ("PowerShell " + $PSVersionTable.PSVersion)
Add-Line ("tar.exe    " + $(if (Get-Command tar.exe -ErrorAction SilentlyContinue) { "present" } else { "MISSING - Windows 10 1803 or newer is needed" }))
Add-Line ("curl.exe   " + $(if (Get-Command curl.exe -ErrorAction SilentlyContinue) { "present" } else { "missing (not fatal)" }))

Add-Head "Project files"
foreach ($f in @("server\src\index.js","db\001_schema.sql","web\dist\index.html",
                 "server\node_modules\express\package.json","server\.env",
                 "migrated\activities.csv","deskops-offline-deps.zip")) {
  $p = Join-Path $Root $f
  if (Test-Path $p) {
    $i = Get-Item $p
    Add-Line ("  OK      {0,-46} {1,10:N0} bytes  {2}" -f $f, $i.Length, $i.LastWriteTime.ToString("yyyy-MM-dd"))
  } else {
    Add-Line ("  MISSING {0}" -f $f)
  }
}
$mig = Join-Path $Root "migrated"
if (Test-Path $mig) { Add-Line ("  migrated\ contains " + (Get-ChildItem $mig -File).Count + " files") }

Add-Head "Runtime"
foreach ($f in @("runtime\node\node.exe","runtime\mariadb\bin\mariadbd.exe",
                 "runtime\mariadb\bin\mariadb.exe","runtime\data\mysql",
                 "runtime\my.ini","runtime\.seeded","runtime\node.zip","runtime\mariadb.zip")) {
  $p = Join-Path $Root $f
  Add-Line ("  {0,-8} {1}" -f $(if (Test-Path $p) { "OK" } else { "MISSING" }), $f)
}
$n = Join-Path $Runtime "node\node.exe"
if (Test-Path $n) { Add-Line ("  node version: " + (& $n -v 2>&1)) }

Add-Head "Processes"
foreach ($name in @("node","mariadbd","com.docker.backend")) {
  $ps = Get-Process $name -ErrorAction SilentlyContinue
  if ($ps) { $ps | ForEach-Object { Add-Line ("  {0,-10} pid {1,-8} {2}" -f $name, $_.Id, $_.Path) } }
  else     { Add-Line ("  {0,-10} not running" -f $name) }
}

Add-Head "Ports"
foreach ($port in @(3307, 4000)) {
  $open = $false
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $port); $c.Close(); $open = $true } catch { }
  Add-Line ("  127.0.0.1:{0}  {1}" -f $port, $(if ($open) { "OPEN" } else { "closed" }))
}

Add-Head "Health endpoint"
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:4000/api/health" -UseBasicParsing -TimeoutSec 5
  Add-Line ("  HTTP " + $r.StatusCode)
  Add-Line ("  " + $r.Content)
} catch { Add-Line ("  no answer: " + $_.Exception.Message) }

Add-Head "Can this machine reach the download servers?"
foreach ($u in @("https://nodejs.org/dist/index.json","https://archive.mariadb.org/")) {
  try {
    $wp = [System.Net.WebRequest]::GetSystemWebProxy()
    $wp.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
    [System.Net.WebRequest]::DefaultWebProxy = $wp
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 20 -Method Head
    Add-Line ("  OK       {0}  (HTTP {1})" -f $u, $r.StatusCode)
  } catch { Add-Line ("  BLOCKED  {0}  -  {1}" -f $u, $_.Exception.Message) }
}

Add-Head "server\.env  (password and secret removed)"
$envFile = Join-Path $Root "server\.env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^(DB_PASSWORD|JWT_SECRET)=") { Add-Line ("  " + ($_ -replace "=.*", "=<hidden>")) }
    elseif ($_.Trim()) { Add-Line ("  " + $_) }
  }
} else { Add-Line "  not written yet" }

foreach ($log in @("app.err.log","app.log","mariadb.log","mariadb-install.log")) {
  $p = Join-Path $LogDir $log
  if (Test-Path $p) {
    Add-Head ("Last 40 lines of " + $log)
    Get-Content $p -Tail 40 | ForEach-Object { Add-Line ("  " + $_) }
  }
}

Add-Line ""
Add-Line "-- end --"

$lines | Set-Content -Path $Out -Encoding UTF8
Write-Host ""
Write-Host "  Wrote:" -ForegroundColor Cyan
Write-Host "    $Out"
Write-Host ""
Write-Host "  Send me that file and I can see what went wrong." -ForegroundColor Cyan
Write-Host ""
try { Start-Process notepad.exe $Out } catch { }
