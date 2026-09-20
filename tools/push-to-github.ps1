#requires -version 5.1
<#
  Desk Ops - put this project on GitHub.

  Why a script rather than commands to paste: pasting a block into cmd.exe
  joins lines when the console is busy, and a joined line turns
  "git push -u origin main" plus the next command into one nonsense
  invocation. That happened three times in a row. A script cannot be
  mis-pasted.

  It is safe to run more than once. Everything it does is checked first:
  it will not re-initialise a repository, will not commit when there is
  nothing to commit, and will not push anything it has not first inspected.

  The one thing it will NOT do is carry on if something private has been
  staged. That check is a hard stop, because a file pushed once stays in the
  history even after it is deleted.
#>

# Continue, NOT Stop, and this is deliberate.
#
# With Stop, anything a native command writes to stderr becomes a terminating
# PowerShell error. Git uses stderr for ordinary conversation: "fatal: Needed a
# single revision" is how `rev-parse --verify HEAD` says "there are no commits
# yet", which is a question this script asks on purpose, and `git push` writes
# its entire progress display there. Under Stop, all of that reads as a crash.
#
# Git's actual verdict is its exit code, so every git call below is checked on
# $LASTEXITCODE and nothing is inferred from stderr.
$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

$Root      = Split-Path -Parent $PSScriptRoot
$RepoUrl   = "https://github.com/numeshj/deskops.git"
$GitName   = "numeshj"
$GitEmail  = "numeshjayamanne@gmail.com"

# Anything matching these must never be committed. migrated\ is the real
# workbook - 579 named shops, 286 contact names and their phone numbers - and
# server\.env holds the JWT signing key, which is enough on its own to mint a
# token for any account including an admin one.
$Forbidden = @("^migrated/", "^runtime/", "node_modules/", "^web/dist/", "\.zip$", "^server/\.env$")

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

<#
  Run git and hand back its exit code and its output together, with stderr
  folded into the output rather than thrown. Used for the questions this
  script asks git - "are there commits?", "is there a remote?" - where a
  non-zero answer is information, not a failure.
#>
function Git-Ask {
  # Out-String returns nothing at all when the command printed nothing, and
  # calling .Trim() on that is a null-reference error dressed up as a crash.
  # `git config --global user.name` on a fresh machine does exactly that.
  $out = (& git @args 2>&1 | Out-String)
  if ($null -eq $out) { $out = "" }
  [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out.Trim() }
}

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor White
Write-Host "    Desk Ops  -  push to GitHub" -ForegroundColor White
Write-Host "  ===========================================" -ForegroundColor White

Set-Location $Root

# =============================================================================
Step 1 "Git"

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { Die "Git is not on the PATH.`nOpen 'Git Bash' from the Start menu and run this from there, or reinstall Git for Windows with the 'Add to PATH' option." }
Ok (& git --version)

# =============================================================================
Step 2 "Who the commits belong to"

# git config exits non-zero when a key is unset, which is not an error here.
$name  = (Git-Ask config --global user.name).Out
$email = (Git-Ask config --global user.email).Out

if (-not $name)  { Git-Ask config --global user.name  $GitName  | Out-Null }
if (-not $email) { Git-Ask config --global user.email $GitEmail | Out-Null }

# Read them back rather than trusting that the set worked. The last attempt at
# this failed precisely because a config command looked like it had run and
# had not.
$name  = (Git-Ask config --global user.name).Out
$email = (Git-Ask config --global user.email).Out
if (-not $name -or -not $email) {
  Die "Git still has no identity set.`nRun these two lines yourself, one at a time:`n`n  git config --global user.name `"$GitName`"`n  git config --global user.email `"$GitEmail`""
}
Ok "$name <$email>"

# =============================================================================
Step 3 "The repository"

if (Test-Path (Join-Path $Root ".git")) {
  Ok "Already a git repository here."
} else {
  Git-Ask init -q | Out-Null
  Ok "Initialised."
}
Git-Ask symbolic-ref HEAD refs/heads/main | Out-Null

# =============================================================================
Step 4 "Staging"

& git add -A
if ($LASTEXITCODE -ne 0) { Die "git add failed. The reason is above." }

$staged = @(& git ls-files)
Ok "$($staged.Count) files staged."

# =============================================================================
Step 5 "Checking nothing private is in there"

$leaks = @()
foreach ($f in $staged) {
  foreach ($pat in $Forbidden) {
    if ($f -match $pat) { $leaks += $f; break }
  }
}

if ($leaks.Count) {
  Die (@(
    "These files are staged and must not be:",
    ""
  ) + ($leaks | Select-Object -First 30 | ForEach-Object { "  $_" }) + @(
    $(if ($leaks.Count -gt 30) { "  ... and $($leaks.Count - 30) more" } else { "" }),
    "",
    "Nothing has been committed or pushed. Check .gitignore, then run this",
    "again. Do not work around this - a file pushed once stays in the git",
    "history even after it is deleted."
  ) -join "`n")
}
Ok "Clean - no workbook data, no secrets, no build output."

# =============================================================================
Step 6 "Committing"

# --quiet: exit 0 means no differences, 1 means there are some.
$hasChanges = ((Git-Ask diff --cached --quiet).Code -ne 0)

# On a repository with no commits this prints "fatal: Needed a single
# revision" to stderr and exits non-zero. That is the answer, not a failure.
$hasCommits = ((Git-Ask rev-parse --verify HEAD).Code -eq 0)

if (-not $hasChanges -and $hasCommits) {
  Ok "Nothing new to commit."
} else {
  $subject = if ($hasCommits) {
    "Update - " + (Get-Date -Format "d MMMM yyyy")
  } else {
    "Desk Ops - order desk capture, dashboard and impact page"
  }
  $body = if ($hasCommits) {
    "Changes made on this machine since the last push."
  } else {
    "Replaces a 12-sheet workbook for the order desk. Express and React served from one process, MySQL-compatible schema, offline capture queue, 310 tests."
  }

  & git commit -m $subject -m $body `
    -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" `
    -m "Claude-Session: https://claude.ai/code/session_01X3LyrSQXNn1wbNtcrM7464"
  if ($LASTEXITCODE -ne 0) { Die "The commit failed. The reason is just above." }
  Ok "Committed."
}

# =============================================================================
Step 7 "The remote"

$remote = Git-Ask remote get-url origin
if ($remote.Code -eq 0 -and $remote.Out) {
  if ($remote.Out -ne $RepoUrl) {
    Warn "origin currently points at $($remote.Out)"
    Git-Ask remote set-url origin $RepoUrl | Out-Null
    Ok "Repointed at $RepoUrl"
  } else {
    Ok "origin is $RepoUrl"
  }
} else {
  Git-Ask remote add origin $RepoUrl | Out-Null
  Ok "Added origin $RepoUrl"
}

# =============================================================================
Step 8 "Pushing"

Write-Host ""
Say "A browser window may open so GitHub can check it is you. That sign-in is"
Say "yours - nothing here handles your password."
Write-Host ""

& git push -u origin main
if ($LASTEXITCODE -ne 0) {
  Die @"
The push did not go through. The usual reasons, in order of likelihood:

  1. The repository does not exist yet.
     Create an EMPTY PRIVATE one at https://github.com/new
     Name it  deskops , owner  numeshj , and tick nothing - no README,
     no .gitignore, no licence. Then run this again.

  2. The sign-in was cancelled or timed out. Run this again.

  3. The repository exists but already has commits in it (that is what
     'rejected - fetch first' means). Tell me and I will sort it out;
     do not force-push over it without looking.

The exact message is just above.
"@
}

# =============================================================================
Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host "    Pushed." -ForegroundColor Green
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host ""
Say "https://github.com/numeshj/deskops"
Write-Host ""
Say "Check on GitHub that there is no 'migrated' folder in the file list."
Say "There should not be - the check above would have stopped this - but it"
Say "costs ten seconds and it is her customers' phone numbers."
Write-Host ""
