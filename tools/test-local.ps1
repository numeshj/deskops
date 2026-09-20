#requires -version 5.1
<#
  Desk Ops - run the test suite against your own copy.

  Checks the API end to end: every endpoint, the save path, drafts, open items,
  clustering, promotion, order merging, the admin permissions, and all of
  Phase 2 - the stock check, requests, photos and allocations - and Phase 3,
  the dashboard and the impact page - plus the hardening suite:
  input validation, hostile strings, role-based access and auth integrity. It uses the app
  and database that run-local.bat already started, so start that first.

  The browser tests (tests\ui.spec.mjs) are not run here - they need Playwright,
  which is a large download. The API suite is the one that catches real bugs.

  Nothing is deleted. The suite adds a few dozen test records, all dated today,
  so they are easy to spot and harmless to leave.
#>

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

$Root    = Split-Path -Parent $PSScriptRoot
$NodeExe = Join-Path $Root "runtime\node\node.exe"
$Suites  = @("tests\api.test.mjs", "tests\phase2.test.mjs", "tests\phase3.test.mjs", "tests\hardening.test.mjs")
$Base    = "http://127.0.0.1:4000"

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor White
Write-Host "    Desk Ops  -  tests" -ForegroundColor White
Write-Host "  ===========================================" -ForegroundColor White
Write-Host ""

if (-not (Test-Path $NodeExe)) {
  Write-Host "  Node is not set up yet. Run run-local.bat first." -ForegroundColor Red
  Write-Host ""
  exit 1
}
$missing = $Suites | Where-Object { -not (Test-Path (Join-Path $Root $_)) }
if ($missing) {
  Write-Host "  These test files are missing:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  Write-Host ""
  exit 1
}

try {
  Invoke-WebRequest -Uri "$Base/api/health" -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
  Write-Host "  The app is not answering on $Base." -ForegroundColor Red
  Write-Host "  Run run-local.bat first, then try this again." -ForegroundColor Red
  Write-Host ""
  exit 1
}

Write-Host "  Running against $Base ..." -ForegroundColor Cyan
Write-Host ""

$env:BASE = $Base

# All four suites in one run, so a failure in any of them fails the whole
# thing. This line said $Suite - singular, never defined anywhere - which with
# ErrorActionPreference = Stop killed the script on the Test-Path above before
# a single test ran.
$paths = $Suites | ForEach-Object { Join-Path $Root $_ }
& $NodeExe --test @paths
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
  Write-Host "  ===========================================" -ForegroundColor Green
  Write-Host "    Everything passed." -ForegroundColor Green
  Write-Host "  ===========================================" -ForegroundColor Green
} else {
  Write-Host "  ===========================================" -ForegroundColor Red
  Write-Host "    Something failed. The lines marked" -ForegroundColor Red
  Write-Host "    'not ok' above say what." -ForegroundColor Red
  Write-Host "  ===========================================" -ForegroundColor Red
}
Write-Host ""
exit $code
