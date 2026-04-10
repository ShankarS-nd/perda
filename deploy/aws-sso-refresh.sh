#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# aws-sso-refresh.sh — Check AWS SSO tokens for ALL profiles.
# If any are expired, automatically triggers `aws sso login` (opens browser).
# Designed to run via cron / systemd timer at start of each workday.
# ──────────────────────────────────────────────────────────────────────

PROFILES=("s3view" "AWS-Device-Developers-Production-362972578037")
LOG="$HOME/.aws/sso-refresh.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

for PROFILE in "${PROFILES[@]}"; do
    if aws sts get-caller-identity --profile "$PROFILE" &>/dev/null; then
        log "✓ SSO token for profile '$PROFILE' is still valid."
    else
        log "✗ SSO token expired for profile '$PROFILE'. Triggering login..."
        aws sso login --profile "$PROFILE" 2>&1 | tee -a "$LOG"
        RC=$?
        if [ $RC -eq 0 ]; then
            log "✓ SSO login successful for '$PROFILE'."
        else
            log "✗ SSO login failed for '$PROFILE' (exit code $RC)."
            command -v notify-send &>/dev/null && \
                notify-send -u critical "AWS SSO Login Failed" \
                "Profile '$PROFILE' token expired and auto-login failed."
        fi
    fi
done
