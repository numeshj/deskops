@echo off
REM ===========================================================================
REM  Desk Ops - load the schema, the accounts and her history into a HOSTED
REM  database (TiDB Cloud, or any MySQL you are given a connection to).
REM
REM  Free hosts give you no shell, so the import cannot run on the server.
REM  It runs here instead, from this machine, over the internet.
REM
REM  Have the provider's connect details to hand: host, port, user, password.
REM  Nothing is saved to disk and no password is shown as you type.
REM
REM  Safe to run twice - the import updates rather than duplicates.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops - load into a hosted database

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\load-remote.ps1"

if errorlevel 1 (
  echo.
  echo   Something stopped it. The reason is above.
  echo.
)

pause
