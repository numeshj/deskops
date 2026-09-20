@echo off
REM ===========================================================================
REM  Desk Ops - stop (the no-Docker version)
REM
REM  Stops the app and the database. Your data is kept exactly as it is -
REM  run-local.bat brings it all back in about fifteen seconds.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops - stopping

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-local.ps1"

pause
