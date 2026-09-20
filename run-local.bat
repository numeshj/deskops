@echo off
REM ===========================================================================
REM  Desk Ops - start, WITHOUT Docker
REM
REM  Double-click this file. That is the whole instruction.
REM
REM  It needs nothing installed: no Docker, no Node, no MySQL, no admin
REM  rights, and no hardware virtualisation. The first run downloads about
REM  150 MB and takes five to ten minutes. Every run after that takes about
REM  fifteen seconds.
REM
REM  Everything it downloads goes in the "runtime" folder next to this file.
REM  Nothing is installed on Windows. Deleting that folder undoes all of it.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\run-local.ps1"

if errorlevel 1 (
  echo.
  echo   Something stopped it. The reason is above.
  echo.
  echo   If you are stuck, send me everything in this window plus the
  echo   files in:  runtime\logs
  echo.
)

pause
