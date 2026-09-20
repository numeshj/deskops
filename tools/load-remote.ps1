#requires -version 5.1
<#
  Desk Ops - load the schema, the accounts and her history into a HOSTED
  database.

  Why this exists: free hosts give you no shell. There is no way to run the
  importer on the server, so it runs here, against the hosted database, over
  the internet. That is the whole job of this script.

  It uses the portable Node in runtime\node, so nothing needs installing. It
  never writes your passwords to a file, and the two app passwords are typed
  blind and passed to the seeder as environment variables, so they do not end
  up in your PowerShell history.

  Safe to run twice. Every row's id is a hash of its source identity, so a
  second run updates rather than duplicates. If it fails halfway, run it again.
#>

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$Root     = Split-Path -Parent $PSScriptRoot
$NodeExe  = Join-Path $Root "runtime\node\node.exe"
$Server   = Join-Path $Root "server"
$Migrated = Join-Path $Root "migrated"

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

# Read a secret without echoing it, and hand back plain text for the child
# process. PowerShell 5.1 has no -AsPlainText on ConvertFrom-SecureString, so
# this is the supported route.
function Read-Secret ($prompt) {
  $s = Read-Host -Prompt "      $prompt" -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Read-SecretTwice ($what) {
  while ($true) {
    $a = Read-Secret "$what"
    if ($a.Length -lt 12) { Warn "That is $($a.Length) characters. The seeder needs at least 12."; continue }
    $b = Read-Secret "$what (again)"
    if ($a -ne $b) { Warn "Those did not match. Try again."; continue }
    return $a
  }
}

function Ask ($prompt, $default) {
  $suffix = if ($default) { " [$default]" } else { "" }
  $v = Read-Host "      $prompt$suffix"
  if (-not $v -and $default) { return $default }
  return $v
}

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor White
Write-Host "    Desk Ops  -  load into a hosted database" -ForegroundColor White
Write-Host "  ===========================================" -ForegroundColor White

# =============================================================================
Step 1 "Checking what is here"

if (-not (Test-Path $NodeExe)) { Die "Node is not set up yet.`nRun run-local.bat once first - it downloads the portable Node this uses." }
if (-not (Test-Path (Join-Path $Migrated "activities.csv"))) {
  Die "The migrated\ folder has no activities.csv in it, so there is nothing to load.`nExpected:`n  $Migrated\activities.csv"
}
Ok "Node and the workbook CSVs are here."

# =============================================================================
Step 2 "Where the hosted database is"

Write-Host ""
Say "Paste these from your database provider's connect dialog."
Say "On TiDB Cloud Starter the port is 4000 and the user looks like 'xxxx.root'."
Write-Host ""

$dbHost = Ask "Host" $null
if (-not $dbHost) { Die "A host is required." }
$dbPort = Ask "Port" "4000"
$dbUser = Ask "User" $null
if (-not $dbUser) { Die "A user is required." }
$dbPass = Read-Secret "Password (typed blind)"
$dbName = Ask "Database name" "deskops"

$isTidb = $dbHost -match "tidbcloud\.com"
if ($isTidb) {
  Ok "That looks like TiDB, so the foreign keys will be dropped (db\002_tidb_compat.sql)."
} else {
  Say ""
  $a = Ask "Is this TiDB? Answer no for MySQL or MariaDB" "no"
  $isTidb = $a -match "^y"
}

# Aiven signs with its own per-project CA, which is not in Node's default
# trust store — connecting fails as "self-signed certificate in certificate
# chain" without it. pool.js (used by every step below) picks up
# server\certs\aiven-ca.pem automatically when it exists; the probe below
# needs the same CA to test the connection honestly instead of just
# disabling verification.
$isAiven = $dbHost -match "aivencloud\.com"
$caPath = Join-Path $Server "certs\aiven-ca.pem"
if ($isAiven -and -not (Test-Path $caPath)) {
  Say "Fetching Aiven's project CA certificate so the connection can be verified properly..."
  $fetcher = Join-Path $Server "deskops-fetch-ca.mjs"
  @'
import mysql from "mysql2/promise";
import fs from "node:fs";
import path from "node:path";

const c = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { minVersion: "TLSv1.2", rejectUnauthorized: false },
  connectTimeout: 20000,
});
let cert = c.connection.stream.getPeerCertificate(true);
let chain = [];
const seen = new Set();
while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
  seen.add(cert.fingerprint256);
  chain.push(cert);
  if (cert.issuerCertificate && cert.issuerCertificate.fingerprint256 !== cert.fingerprint256) {
    cert = cert.issuerCertificate;
  } else break;
}
const root = chain[chain.length - 1];
const pem = "-----BEGIN CERTIFICATE-----\n" +
  root.raw.toString("base64").match(/.{1,64}/g).join("\n") +
  "\n-----END CERTIFICATE-----\n";
// Run with cwd = server\ (the caller Push-Location's there), so this lands
// at server\certs\aiven-ca.pem, matching where pool.js looks for it.
const outDir = path.resolve("certs");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "aiven-ca.pem"), pem);
console.log("OK");
await c.end();
'@ | Set-Content -Path $fetcher -Encoding ASCII

  Push-Location $Server
  & $NodeExe $fetcher 2>&1 | Out-Null
  $fetchOk = $LASTEXITCODE -eq 0 -and (Test-Path $caPath)
  Pop-Location
  Remove-Item $fetcher -Force -ErrorAction SilentlyContinue

  if ($fetchOk) { Ok "Saved server\certs\aiven-ca.pem." }
  else { Warn "Could not fetch it automatically; the connection test below will explain why." }
}

# Everything below inherits these.
$env:DB_HOST     = $dbHost
$env:DB_PORT     = $dbPort
$env:DB_USER     = $dbUser
$env:DB_PASSWORD = $dbPass
$env:DB_NAME     = $dbName
$env:DB_SSL      = "1"          # every hosted free database refuses plaintext
$env:DB_POOL     = "3"          # free tiers cap connections hard
$env:NODE_ENV    = "production"
if ($isTidb) { $env:MIGRATE_INCLUDE = "tidb_compat" }

# =============================================================================
Step 3 "Testing the connection before changing anything"

# A failed connection here is a typo or a firewall, and finding that out now is
# far better than finding it out halfway through 13,000 inserts.
# The probe file goes in server\, NOT in TEMP. An ESM relative import resolves
# against the importing FILE's location, not the working directory, so
# "./src/db/pool.js" from a file in TEMP would not resolve at all.
$probe = Join-Path $Server "deskops-probe.mjs"
# A literal here-string (@'...'@): no PowerShell interpolation, so the
# backticks and ${...} below reach Node exactly as written.
@'
import mysql from "mysql2/promise";
import fs from "node:fs";
import path from "node:path";

const name = process.env.DB_NAME || "";
if (!/^[A-Za-z0-9_]+$/.test(name)) {
  console.log("FAIL|BAD_NAME|A database name may only contain letters, numbers and underscores.");
  process.exit(0);
}

// Same pinned-CA logic as server/src/db/pool.js: use the committed Aiven
// project CA when present, otherwise fall back to the default trust store
// (which is correct for TiDB and most other hosts).
function sslConfig() {
  if (process.env.DB_SSL !== "1") return undefined;
  const caPath = path.resolve("certs/aiven-ca.pem");
  const ca = fs.existsSync(caPath) ? fs.readFileSync(caPath, "utf8") : undefined;
  return { minVersion: "TLSv1.2", ca };
}

// Connect with NO database selected. A database that does not exist yet is
// then something this can fix in one statement, instead of an error message
// sending someone back to a provider console mid-deploy.
const cfg = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: sslConfig(),
  connectTimeout: 20000,
};

let c;
try {
  c = await mysql.createConnection(cfg);
} catch (e) {
  console.log("FAIL|" + (e.code || "") + "|" + e.message);
  process.exit(0);
}

let created = "";
try {
  const [rows] = await c.query("SHOW DATABASES LIKE ?", [name]);
  if (!rows.length) {
    await c.query("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    created = "created";
  }
  await c.query("USE `" + name + "`");
  const [v] = await c.query("SELECT VERSION() AS v");
  console.log("OK|" + v[0].v + "|" + created);
} catch (e) {
  console.log("FAIL|" + (e.code || "") + "|" + e.message);
} finally {
  await c.end();
}
'@ | Set-Content -Path $probe -Encoding ASCII

Push-Location $Server
$result = & $NodeExe $probe 2>&1 | Select-Object -Last 1
Pop-Location
Remove-Item $probe -Force -ErrorAction SilentlyContinue

$parts = "$result" -split "\|"
if ($parts[0] -ne "OK") {
  $code = $parts[1]
  $hint = switch -Regex ($code) {
    "ENOTFOUND"      { "The host name did not resolve. Check it for a typo." }
    "ETIMEDOUT"      { "No answer on that port. Check the port, and whether the provider needs your IP allowing." }
    "ECONNREFUSED"   { "The host answered but refused the port. Check the port number." }
    "ER_ACCESS_DENIED_ERROR" { "The user or password was rejected. On TiDB the user looks like 'xxxxxxx.root', with the prefix." }
    "DBACCESS|BAD_DB" { "The user cannot create or open that database. Create it in the provider's console, then use that name here." }
    "HANDSHAKE|EPROTO|CERT" { "A TLS problem. Check the provider is expecting a TLS connection on that port." }
    "BAD_NAME"       { "" }
    default          { "" }
  }
  Die (@("Could not connect.", "", "  $($parts[2])", "") + $(if ($hint) { @($hint) } else { @() }) -join "`n")
}
if ($parts[2] -eq "created") { Ok "Created the '$dbName' database." }
Ok "Connected to $($parts[1])."

# =============================================================================
Step 4 "Applying the schema"

Push-Location $Server
& $NodeExe "src\db\migrate.js"
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Die "The schema did not apply. The error is just above." }
Ok "Schema applied."

# =============================================================================
Step 5 "The two sign-in accounts"

Write-Host ""
Say "This database will be reachable from the internet, so the seeder refuses"
Say "the development passwords. Pick real ones - at least 12 characters, and"
Say "different from each other. They are not shown as you type and are not"
Say "saved anywhere."
Write-Host ""

$env:SEED_USER_PASSWORD  = Read-SecretTwice "Password for Yashoda"
$env:SEED_ADMIN_PASSWORD = Read-SecretTwice "Password for the supervisor account"

Push-Location $Server
& $NodeExe "src\db\seedUsers.js"
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Die "Could not create the accounts. The reason is just above." }
Ok "Accounts created."

# =============================================================================
Step 6 "Loading 13 months of the workbook"

Say "About 13,000 rows over the internet. A couple of minutes."
Write-Host ""
Push-Location $Server
& $NodeExe "src\import.js" $Migrated
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) {
  Die "The import failed. The error is just above.`nIt is safe to run this script again - the import updates rather than duplicates."
}

# Clear the secrets out of this session rather than leaving them in the
# environment for whatever runs next in this window.
foreach ($v in "DB_PASSWORD","SEED_USER_PASSWORD","SEED_ADMIN_PASSWORD") {
  Remove-Item "env:$v" -ErrorAction SilentlyContinue
}

# =============================================================================
Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host "    Loaded." -ForegroundColor Green
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host ""
Say "Set the same DB_ values on the web host, deploy, and sign in with the"
Say "passwords you just chose. MIGRATE_ON_BOOT is already on, so the app"
Say "applies the schema itself if it ever meets an empty database."
Write-Host ""
if ($isTidb) {
  Say "TiDB note: the foreign keys were dropped on purpose. The importer and"
  Say "the API both resolve references themselves, so nothing relied on them."
  Write-Host ""
}
