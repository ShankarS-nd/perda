#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# aws-sso-refresh.sh — Refresh AWS SSO tokens and sync to DTA server.
# Runs via cron every 4 hours on weekdays.
# If a token is expired, triggers `aws sso login` (opens browser tab
# that auto-completes), waits 60s, then closes the SSO browser tab.
# ──────────────────────────────────────────────────────────────────────

PROFILES=("s3view")
LOG="$HOME/.aws/sso-refresh.log"
DTA_SERVER="dta_server@172.16.23.15"
DTA_PASS="DeviceAutomation@123"

# Ensure cron can open GUI apps (browser) on the user's display
export DISPLAY="${DISPLAY:-:0}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# ── Close browser tabs matching AWS SSO URL ───────────────────────────
close_sso_tabs() {
    sleep 60  # wait for SSO login to auto-complete
    # Method 1: xdotool (if available)
    if command -v xdotool &>/dev/null; then
        # Find Firefox windows with AWS SSO in the title and close them
        for wid in $(xdotool search --name "AWS" 2>/dev/null); do
            xdotool windowactivate "$wid" 2>/dev/null
            xdotool key --window "$wid" ctrl+w 2>/dev/null
            log "  Closed SSO browser tab (xdotool, window $wid)"
        done
        return
    fi
    # Method 2: wmctrl (if available)
    if command -v wmctrl &>/dev/null; then
        wmctrl -c "AWS" 2>/dev/null && log "  Closed SSO browser tab (wmctrl)"
        return
    fi
    # Method 3: Use python3 + xdg keyboard simulation
    if command -v python3 &>/dev/null; then
        python3 -c "
import subprocess, time
# Find windows with AWS/SSO in title via xprop
try:
    result = subprocess.run(['bash', '-c', '''
        for wid in \$(xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -oP \"0x[0-9a-fA-F]+\" ); do
            name=\$(xprop -id \$wid _NET_WM_NAME 2>/dev/null | grep -i 'aws\\|sso' || true)
            if [ -n \"\$name\" ]; then
                echo \$wid
            fi
        done
    '''], capture_output=True, text=True, timeout=10)
    for wid in result.stdout.strip().split():
        if wid:
            subprocess.run(['xprop', '-id', wid, '-f', '_NET_CLOSE_WINDOW', '32c', '-set', '_NET_CLOSE_WINDOW', '0'], timeout=5, capture_output=True)
except Exception:
    pass
" 2>/dev/null && log "  Attempted to close SSO browser tab (python3/xprop)"
        return
    fi
    log "  ⚠ No method available to close browser tab (install xdotool: sudo apt install xdotool)"
}

LOGIN_HAPPENED=false

for PROFILE in "${PROFILES[@]}"; do
    if aws sts get-caller-identity --profile "$PROFILE" &>/dev/null; then
        log "✓ SSO token for profile '$PROFILE' is still valid."
    else
        log "✗ SSO token expired for profile '$PROFILE'. Triggering login..."
        aws sso login --profile "$PROFILE" 2>&1 | tee -a "$LOG"
        RC=$?
        if [ $RC -eq 0 ]; then
            log "✓ SSO login successful for '$PROFILE'."
            LOGIN_HAPPENED=true
        else
            log "✗ SSO login failed for '$PROFILE' (exit code $RC)."
            command -v notify-send &>/dev/null && \
                notify-send -u critical "AWS SSO Login Failed" \
                "Profile '$PROFILE' token expired and auto-login failed."
        fi
    fi
done

# ── Close any SSO browser tabs that were opened ──────────────────────
if [ "$LOGIN_HAPPENED" = true ]; then
    log "Waiting 60s then closing SSO browser tab..."
    close_sso_tabs &
fi

# ── Sync SSO tokens to DTA server so Perda scripts work ──────────────
if command -v sshpass &>/dev/null; then
    log "Syncing SSO tokens to DTA server..."
    sshpass -p "$DTA_PASS" scp -o StrictHostKeyChecking=no \
        "$HOME/.aws/sso/cache/"*.json \
        "$DTA_SERVER:~/.aws/sso/cache/" 2>&1 | tee -a "$LOG"
    if [ $? -eq 0 ]; then
        log "✓ SSO tokens synced to DTA server."
    else
        log "✗ Failed to sync tokens to DTA server."
    fi
else
    log "⚠ sshpass not installed — skipping DTA server token sync."
fi
