@echo off
REM ===========================================================================
REM  Desk Ops - diagnostics
REM
REM  Run this if run-local.bat did not work. It writes one file,
REM  runtime\logs\diagnostics.txt, and opens it in Notepad.
REM
REM  Send me that file. It has no passwords and nothing about the business -
REM  only versions, file sizes, ports and error lines.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops - diagnostics

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\check-local.ps1"

pause
