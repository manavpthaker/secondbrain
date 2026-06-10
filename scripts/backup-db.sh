#!/usr/bin/env bash
# Nightly backup of secondbrain.db using SQLite's online backup API.
# Safe against concurrent writes from a KeepAlive'd secondbrain process.
# Driven by launchd/com.secondbrain.backup.plist at 03:00 local time.

set -euo pipefail

REPO_DIR="/Users/YOUR_USERNAME/Documents/GitHub/secondbrain"
DB="${REPO_DIR}/secondbrain.db"
BACKUP_DIR="${HOME}/secondbrain-backups"
RETAIN_DAYS=14

mkdir -p "${BACKUP_DIR}"

if [[ ! -f "${DB}" ]]; then
  echo "[backup] secondbrain.db not found at ${DB}" >&2
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
TARGET="${BACKUP_DIR}/secondbrain.db.${STAMP}"

# .backup uses SQLite's online backup API — torn-write safe.
/usr/bin/sqlite3 "${DB}" ".backup '${TARGET}'"

# Prune backups older than RETAIN_DAYS.
/usr/bin/find "${BACKUP_DIR}" -name 'secondbrain.db.*' -type f -mtime "+${RETAIN_DAYS}" -delete

echo "[backup] $(date -Iseconds) wrote ${TARGET}"
