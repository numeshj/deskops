@echo off
REM ===========================================================================
REM  Desk Ops - stop
REM
REM  Stops the app and the database. Your data is kept: start.bat brings it
REM  all back exactly as it was.
REM
REM  To wipe the data and start from scratch, run:  docker compose down -v
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops - stopping

echo.
echo   Stopping Desk Ops...
echo.

docker compose down

echo.
echo   Stopped. Your data is safe - start.bat will bring it back.
echo.
pause
