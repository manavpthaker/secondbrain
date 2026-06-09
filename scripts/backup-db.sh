#!/usr/bin/env bash
# Nightly backup of brownbot.db using SQLite's online backup API.
# Safe against concurrent writes from a KeepAlive'd brownbot process.
# Driven by launchd/com.brownbot.backup.plist at 03:00 local time.

set -euo pipefail

REPO_DIR="/Users/YOUR_USERNAME/Documents/GitHub/brownbot"
DB="${REPO_DIR}/brownbot.db"
BACKUP_DIR="${HOME}/brownbot-backups"
RETAIN_DAYS=14

mkdir -p "${BACKUP_DIR}"

if [[ ! -f "${DB}" ]]; then
  echo "[backup] brownbot.db not found at ${DB}" >&2
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
TARGET="${BACKUP_DIR}/brownbot.db.${STAMP}"

# .backup uses SQLite's online backup API — torn-write safe.
/usr/bin/sqlite3 "${DB}" ".backup '${TARGET}'"

# Prune backups older than RETAIN_DAYS.
/usr/bin/find "${BACKUP_DIR}" -name 'brownbot.db.*' -type f -mtime "+${RETAIN_DAYS}" -delete

echo "[backup] $(date -Iseconds) wrote ${TARGET}"
