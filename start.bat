@echo off
REM ===========================================================================
REM  Desk Ops - start everything
REM
REM  Double-click this file. It needs Docker Desktop running and nothing else:
REM  no MySQL, no Node.
REM
REM  First run takes a couple of minutes while the images build.
REM  Later runs take a few seconds.
REM ===========================================================================

setlocal
cd /d "%~dp0"
title Desk Ops

echo.
echo   ============================================
echo     Desk Ops
echo   ============================================
echo.

REM --- is Docker installed and running? ----------------------------------
where docker >nul 2>&1
if errorlevel 1 (
  echo   [X] Docker is not installed.
  echo.
  echo       Install Docker Desktop from:
  echo       https://www.docker.com/products/docker-desktop/
  echo.
  echo       Then run this file again.
  echo.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo   [X] Docker is installed but not running.
  echo.
  echo       Start Docker Desktop, wait for the whale icon in the system
  echo       tray to stop animating, then run this file again.
  echo.
  pause
  exit /b 1
)

echo   [1/4] Docker is running.
echo.

REM --- build and start ----------------------------------------------------
echo   [2/4] Building and starting. First run takes a few minutes...
echo.
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo   [X] Something went wrong starting the containers.
  echo       Scroll up for the error.
  echo.
  pause
  exit /b 1
)

REM --- wait for the app to answer -----------------------------------------
echo.
echo   [3/4] Waiting for the app to come up...
set /a tries=0
:wait
set /a tries+=1
timeout /t 2 /nobreak >nul
curl -fsS http://localhost:4000/api/health >nul 2>&1
if not errorlevel 1 goto ready
if %tries% GEQ 45 (
  echo.
  echo   [X] The app did not come up within 90 seconds.
  echo       Run this to see why:   docker compose logs app
  echo.
  pause
  exit /b 1
)
goto wait

:ready
echo       App is up.
echo.

REM --- load data the first time -------------------------------------------
echo   [4/4] Checking data...
docker compose exec -T app node -e "import('./server/src/db/pool.js').then(async m=>{const r=await m.query('SELECT COUNT(*) n FROM app_user');process.exit(r[0].n>0?0:1)}).catch(()=>process.exit(1))" >nul 2>&1
if errorlevel 1 (
  echo       First run - creating accounts and loading the workbook data...
  docker compose --profile tools run --rm seed
  echo.
) else (
  echo       Data already loaded.
  echo.
)

echo   ============================================
echo     Ready:  http://localhost:4000
echo.
echo     Sign in with
echo       yashoda@example.com  /  desk1234
echo       admin@example.com    /  admin1234
echo   ============================================
echo.
echo   Opening your browser...
start "" http://localhost:4000

echo.
echo   The app keeps running in the background.
echo   Double-click stop.bat when you are finished.
echo.
pause
