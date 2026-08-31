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

echo "Starting... the first run installs things and takes a few minutes."
echo "Leave this window OPEN while you use the app."
echo

( sleep 6; command -v open >/dev/null && open http://127.0.0.1:4317 \
  || (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:4317) ) >/dev/null 2>&1 &

npm start

echo
echo "The app stopped. Read any error above."
read -r -p "Press Enter to close..."
