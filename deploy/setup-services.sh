#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-services.sh  —  Install Perda as systemd services on the dta server
#
# Run this script ONCE on the dta server from inside the project root:
#   cd /path/to/perda
#   bash deploy/setup-services.sh
#
# What it does:
#   1. Detects the project directory and current user
#   2. Rebuilds the Python venv if needed (installs requirements.txt)
#   3. Builds the Next.js frontend (npm run build)
#   4. Writes two systemd service files to /etc/systemd/system/
#   5. Enables & starts both services so they survive reboots
# ─────────────────────────────────────────────────────────────────────────────
set -e

# ── 0. Resolve paths ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERDA_DIR="$(dirname "$SCRIPT_DIR")"          # one level above deploy/
SERVER_USER="$(whoami)"
BACKEND_DIR="$PERDA_DIR/backend"
FRONTEND_DIR="$PERDA_DIR/frontend"
VENV="$BACKEND_DIR/venv"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Perda service installer"
echo "  Project : $PERDA_DIR"
echo "  User    : $SERVER_USER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Python venv ────────────────────────────────────────────────────────────
echo ""
echo "▶ [1/4] Checking Python virtualenv…"
if [ ! -f "$VENV/bin/uvicorn" ]; then
    echo "  Creating / refreshing venv…"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --upgrade pip -q
    "$VENV/bin/pip" install -r "$BACKEND_DIR/requirements.txt" -q
    echo "  Dependencies installed."
else
    echo "  venv OK — skipping (re-run 'pip install -r requirements.txt' manually if you updated deps)"
fi

# ── 2. Next.js production build ───────────────────────────────────────────────
echo ""
echo "▶ [2/4] Building Next.js frontend (npm run build)…"
cd "$FRONTEND_DIR"
npm install --legacy-peer-deps -q
npm run build
cd "$PERDA_DIR"

# ── 3. Write systemd service files ────────────────────────────────────────────
echo ""
echo "▶ [3/4] Installing systemd service files…"

# Detect npm binary location
NPM_PATH="$(command -v npm)"
echo "  npm found at: $NPM_PATH"

# Resolve the real npm path if it's a symlink (needed in ExecStart)
NPM_REAL="$(realpath "$NPM_PATH")"

for SVC in perda-backend perda-frontend; do
    SRC="$SCRIPT_DIR/${SVC}.service"
    DST="/etc/systemd/system/${SVC}.service"

    # Replace placeholders
    sed \
        -e "s|__PERDA_DIR__|$PERDA_DIR|g" \
        -e "s|__SERVER_USER__|$SERVER_USER|g" \
        -e "s|/usr/bin/npm|$NPM_REAL|g" \
        "$SRC" | sudo tee "$DST" > /dev/null

    echo "  Wrote $DST"
done

# ── 4. Enable and start services ─────────────────────────────────────────────
echo ""
echo "▶ [4/4] Enabling and starting services…"
sudo systemctl daemon-reload

for SVC in perda-backend perda-frontend; do
    sudo systemctl enable "$SVC"
    sudo systemctl restart "$SVC"
    sleep 1
    STATUS="$(systemctl is-active "$SVC")"
    echo "  $SVC → $STATUS"
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓  Both services are running!"
echo ""
echo "  Backend  → http://$(hostname -I | awk '{print $1}'):8000"
echo "  Frontend → http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "  Useful commands:"
echo "    journalctl -u perda-backend  -f   # live backend logs"
echo "    journalctl -u perda-frontend -f   # live frontend logs"
echo "    sudo systemctl status perda-backend perda-frontend"
echo "    sudo systemctl restart perda-backend perda-frontend"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
