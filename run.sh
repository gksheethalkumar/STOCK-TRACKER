#!/usr/bin/env bash
# Start the Stock Tracker server and print the exact URL to open on your iPhone.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

# Best-effort LAN IP detection (macOS).
IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
[ -z "$IP" ] && IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
[ -z "$IP" ] && IP="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127' | head -1 || true)"

echo "======================================================"
echo "  Net Worth · Stock Tracker"
echo "------------------------------------------------------"
echo "  On this Mac:   http://localhost:${PORT}"
if [ -n "$IP" ]; then
  echo "  On your iPhone: http://${IP}:${PORT}"
  echo "  (iPhone must be on the SAME Wi-Fi as this Mac)"
else
  echo "  iPhone: find this Mac's IP in System Settings > Wi-Fi > Details"
fi
echo "======================================================"
echo

PORT="$PORT" exec python3 server.py
