#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

echo "============================================"
echo "  Etsy Command Center"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo
  echo "1. Go to https://nodejs.org"
  echo "2. Download the LTS version and install it"
  echo "3. Close this window and double-click this file again"
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

echo "Please wait. The browser opens BY ITSELF once the app is ready."
echo "Do not open it yourself - too early and it will say"
echo "\"site cannot be reached\"."
echo
echo "The first run downloads what the app needs (a minute or two)."
echo "Leave this window OPEN while you use the app -- closing it is"
echo "the only way to stop it. It restarts itself on its own after"
echo "installing an automatic update, and keeps this same window."
echo

while true; do
  npm start
  echo
  echo "------------------------------------------------------------"
  echo "The app just stopped. If that was an automatic update, it"
  echo "restarts itself below in a few seconds. If something actually"
  echo "crashed, read the error above -- closing this window stops"
  echo "the restart loop."
  echo "------------------------------------------------------------"
  sleep 5
done
