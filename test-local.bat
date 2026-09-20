@echo off
REM ===========================================================================
REM  Desk Ops - run the tests
REM
REM  Start the app with run-local.bat first, then double-click this.
REM
REM  It checks every part of the API against your own database and prints a
REM  pass/fail line for each one. Takes a few seconds.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops - tests

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\test-local.ps1"

pause
