@echo off
REM ===========================================================================
REM  Desk Ops - put this project on GitHub.
REM
REM  Double-click this file. That is the whole instruction.
REM
REM  It sets your git identity if it is missing, stages everything, refuses to
REM  continue if anything private has been staged, commits, and pushes to
REM  https://github.com/numeshj/deskops
REM
REM  Safe to run again. It will not re-commit when there is nothing new.
REM
REM  The repository must exist on GitHub first - create an EMPTY PRIVATE one
REM  at https://github.com/new called deskops, with nothing ticked.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops - push to GitHub

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\push-to-github.ps1"

if errorlevel 1 (
  echo.
  echo   Something stopped it. The reason is above.
  echo.
)

pause
