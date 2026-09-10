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
echo "Leave this window OPEN while you use the app."
echo

npm start

echo
echo "The app stopped. Read any error above."
read -r -p "Press Enter to close..."
