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

echo.
echo ------------------------------------------------------------
echo The app just stopped. If that was an automatic update, it
echo restarts itself below in a few seconds. If something actually
echo crashed, read the error above -- closing this window stops
echo the restart loop.
echo ------------------------------------------------------------
timeout /t 5 >nul
goto run
