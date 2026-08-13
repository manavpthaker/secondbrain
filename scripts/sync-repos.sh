#!/usr/bin/env bash
# Secondbrain freshness sync — pulls source repos on the Mac mini every 5 min.
# Content repos are read live by secondbrain's tools (no restart needed).
# Service repos run as launchd agents and get kickstarted on change.
set -uo pipefail

GH_DIR="${SECONDBRAIN_GH_ROOT:-$HOME/GitHub}"
LOG="$HOME/Library/Logs/secondbrain-sync.log"
DB="$GH_DIR/secondbrain/secondbrain.db"

# Repos read live by the bot's tools (no restart needed when they change). Add
# your own sibling repos here, or leave empty.
CONTENT_REPOS=(
)

# Repos that run as launchd agents and get kickstarted on change.
SERVICE_REPOS=(
  "secondbrain"
)

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(stamp)] $*" >> "$LOG"; }

# Stamp a sync-status key into secondbrain's `memory` table (group_id='system', same
# convention as the daemon `*_last_tick` keys in src/lib/daemon.ts) so the doctor
# health check — and therefore the 09:00 alive-ping DM — can flag a stuck deploy
# instead of it only showing up as "why am I still getting nagged". Best-effort:
# WAL mode lets this write alongside the running bot, and a failure here must
# never abort the sync. updated_at carries the time; value carries the reason.
stamp_memory() {
  local key="$1" value="$2"
  [[ -f "$DB" ]] || return 0
  value=${value//\'/\'\'}  # SQL-escape single quotes
  # updated_at as UTC ISO-8601 with a 'Z' (strftime, not datetime('now')) so JS
  # Date.parse in the doctor reads it as UTC — a zone-less "YYYY-MM-DD HH:MM:SS"
  # is parsed as LOCAL time there, yielding a wrong (negative) age.
  sqlite3 "$DB" \
    "PRAGMA busy_timeout=3000; INSERT OR REPLACE INTO memory (group_id, key, value, updated_at) VALUES ('system', '$key', '$value', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));" \
    >> "$LOG" 2>&1 || log "memory stamp failed: $key"
}

# Sets globals: PULL_BEFORE, PULL_AFTER
# Returns: 0 = pulled & changed, 1 = pulled & unchanged, 2 = error
pull_repo() {
  local repo="$1"
  local dir="$GH_DIR/$repo"
  PULL_BEFORE=""; PULL_AFTER=""
  if [[ ! -d "$dir/.git" ]]; then
    log "skip $repo (not a repo)"
    return 2
  fi
  PULL_BEFORE=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)
  if ! git -C "$dir" pull --ff-only --quiet 2>>"$LOG"; then
    log "pull failed: $repo (uncommitted changes? non-ff?)"
    return 2
  fi
  PULL_AFTER=$(git -C "$dir" rev-parse HEAD)
  [[ "$PULL_BEFORE" != "$PULL_AFTER" ]]
}

package_files_changed() {
  local dir="$1" before="$2" after="$3"
  git -C "$dir" diff --name-only "$before" "$after" 2>/dev/null \
    | grep -qE '(^|/)package(-lock)?\.json$'
}

# True when the committed fact seed (JSON or seeder script) changed between two
# revisions, so we only re-seed when there's something new to seed. The seed
# itself is idempotent, so running it more often would be harmless — this just
# keeps each sync minimal.
seed_files_changed() {
  local dir="$1" before="$2" after="$3"
  git -C "$dir" diff --name-only "$before" "$after" 2>/dev/null \
    | grep -qE '(^|/)(context/seeds/facts\.json|scripts/seed-facts\.ts)$'
}

log "--- sync run start ---"

# Repos whose pull failed this run (uncommitted edits on a deploy target, or a
# non-ff divergence). Drives the sync_last_error stamp below. Kept 3.2-safe:
# never expanded while empty (only inside the >0 branch).
FAILED=()

for r in "${CONTENT_REPOS[@]}"; do
  pull_repo "$r"
  case $? in
    0) log "content updated: $r ($PULL_BEFORE -> $PULL_AFTER)" ;;
    1) ;; # unchanged, silent
    *) FAILED+=("$r") ;; # error already logged
  esac
done

for r in "${SERVICE_REPOS[@]}"; do
  pull_repo "$r"
  case $? in
    1) continue ;;  # unchanged
    2) FAILED+=("$r"); continue ;;  # error already logged
  esac
  log "service updated: $r ($PULL_BEFORE -> $PULL_AFTER) — restarting"
  case "$r" in
    secondbrain)
      cd "$GH_DIR/secondbrain"
      if package_files_changed "$GH_DIR/secondbrain" "$PULL_BEFORE" "$PULL_AFTER"; then
        log "  secondbrain: package*.json changed, running npm install"
        npm install --silent >> "$LOG" 2>&1 || log "  secondbrain: npm install FAILED"
      fi
      log "  secondbrain: building"
      npm run build >> "$LOG" 2>&1 || log "  secondbrain: build FAILED"
      if seed_files_changed "$GH_DIR/secondbrain" "$PULL_BEFORE" "$PULL_AFTER"; then
        log "  secondbrain: fact seed changed, running npm run seed:facts"
        npm run seed:facts >> "$LOG" 2>&1 || log "  secondbrain: seed:facts FAILED"
      fi
      launchctl kickstart -k "gui/$UID/com.secondbrain.agent" >> "$LOG" 2>&1 \
        || log "  secondbrain: kickstart failed"
      ;;
  esac
done

# Record this run's outcome for the doctor / alive-ping. Only stamp success on a
# fully clean run, so sync_last_success goes stale if every run keeps failing
# (which also catches the sync agent itself dying). On failure, name the repos so
# the DM says what to fix.
if [[ ${#FAILED[@]} -gt 0 ]]; then
  stamp_memory sync_last_error "pull failed: ${FAILED[*]}"
  log "sync completed with errors: ${FAILED[*]}"
else
  stamp_memory sync_last_success "ok"
fi
