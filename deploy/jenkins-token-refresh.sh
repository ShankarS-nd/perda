#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# jenkins-token-refresh.sh — Keep the Jenkins API token alive by
# visiting the security page with Basic Auth (user + token).
# Schedule via cron to run daily.
# ──────────────────────────────────────────────────────────────────────

JENKINS_URL="https://build-device.netradyne.info"
SECURITY_PATH="/user/s.shankar@netradyne.com/security/"
ENV_FILE="$(dirname "$0")/../backend/.env"
LOG="$HOME/.jenkins-token-refresh.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Read credentials from .env
if [ -f "$ENV_FILE" ]; then
    JENKINS_USER=$(grep '^JENKINS_USER=' "$ENV_FILE" | cut -d= -f2-)
    JENKINS_TOKEN=$(grep '^JENKINS_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
fi

if [ -z "$JENKINS_USER" ] || [ -z "$JENKINS_TOKEN" ]; then
    log "✗ JENKINS_USER or JENKINS_TOKEN not found in $ENV_FILE"
    exit 1
fi

# Hit the security page with Basic Auth to keep the session alive
HTTP_CODE=$(curl -sk -o /dev/null -w '%{http_code}' \
    -u "${JENKINS_USER}:${JENKINS_TOKEN}" \
    "${JENKINS_URL}${SECURITY_PATH}")

if [ "$HTTP_CODE" = "200" ]; then
    log "✓ Jenkins token refreshed (HTTP $HTTP_CODE)"
elif [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "401" ]; then
    log "✗ Jenkins token may have expired (HTTP $HTTP_CODE). Visit: ${JENKINS_URL}${SECURITY_PATH}"
    command -v notify-send &>/dev/null && \
        notify-send -u critical "Jenkins Token Expired" \
        "HTTP $HTTP_CODE — visit ${JENKINS_URL}${SECURITY_PATH} to refresh."
else
    log "⚠ Jenkins security page returned HTTP $HTTP_CODE"
fi
