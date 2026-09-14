@echo off
title Etsy Command Center
cd /d "%~dp0"

echo ============================================
echo   Etsy Command Center
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo.
  echo 1. Go to https://nodejs.org
  echo 2. Download the LTS version and install it
  echo 3. Close this window and double-click this file again
  echo.
  pause
  exit /b 1
)

echo Please wait. The browser opens BY ITSELF once the app is ready.
echo Do not open it yourself - too early and it will say
echo "site cannot be reached".
echo.
echo The first run downloads what the app needs (a minute or two).
echo Leave this window OPEN while you use the app -- closing it is
echo the only way to stop it. It restarts itself on its own after
echo installing an automatic update, and keeps this same window.
echo.

:run
call npm start
set EXITCODE=%errorlevel%

if "%EXITCODE%"=="0" (
  echo.
  echo Installed an automatic update -- restarting in a few seconds...
  timeout /t 5 >nul
  goto run
)

echo.
echo ------------------------------------------------------------
echo The app stopped with an error (code %EXITCODE%) instead of a
echo planned restart -- read the message above. A common one is
echo "port already in use": either this app is already running (try
echo opening the address it printed before), or something else on
echo this computer is using that port -- set PORT=4400 (or any other
echo number) in .env and run this again.
echo ------------------------------------------------------------
pause
