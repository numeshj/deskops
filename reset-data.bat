@echo off
REM ===========================================================================
REM  Desk Ops - erase the database and reload only the real workbook data
REM
REM  Testing put around a thousand invented records into your copy. This
REM  throws the whole database away and rebuilds it from the CSVs in
REM  migrated\ - Yashoda's 13 months, and nothing else.
REM
REM  It asks you to type ERASE before it does anything. Everything currently
REM  in the database goes, including anything captured in the app since it
REM  was set up. The migrated\ CSVs are not touched.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops - reload the real data

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\reset-data.ps1"

if errorlevel 1 (
  echo.
  echo   Something stopped it. The reason is above.
  echo.
  echo   If you are stuck, send me everything in this window plus the
  echo   files in:  runtime\logs
  echo.
)

pause
