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

echo Starting... the first run installs things and takes a few minutes.
echo Leave this window OPEN while you use the app.
echo.

start "" http://127.0.0.1:4317
call npm start

echo.
echo The app stopped. Read any error above.
pause
