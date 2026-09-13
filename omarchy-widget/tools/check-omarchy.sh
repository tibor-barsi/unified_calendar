#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/center-anchor.sh"

PLUGIN_ID="unified.clock"
STOCK_ID="omarchy.clock"
GLYPH="󰃭"

WIDGET_DIR="${UNIFIED_WIDGET_WIDGET_DIR:-$script_dir/..}"
STATE_DIR="${UNIFIED_WIDGET_STATE_DIR:-$HOME/.local/state/unified-calendar-widget}"
CLOCK_DIR="${UNIFIED_WIDGET_OMARCHY_CLOCK_DIR:-/usr/share/omarchy/shell/plugins/panels/clock}"
SHELL_JSON="${UNIFIED_WIDGET_SHELL_JSON:-$HOME/.config/omarchy/shell.json}"
OMARCHY_SHELL_CONFIG="${OMARCHY_SHELL_CONFIG:-/usr/share/omarchy/shell}"
HEALTH_WAIT="${UNIFIED_WIDGET_HEALTH_WAIT_SECONDS:-60}"
POLL_SECONDS="${UNIFIED_WIDGET_POLL_SECONDS:-2}"
AGENT_PROMPT_CMD="${UNIFIED_WIDGET_AGENT_PROMPT_CMD:-omarchy-agent-prompt}"

SUMS="$WIDGET_DIR/upstream/SHA256SUMS"
UPDATING="$WIDGET_DIR/UPDATING.md"
LOG_FILE="$STATE_DIR/check.log"
PAUSED="$STATE_DIR/paused"
LOG_MAX_BYTES=262144
LOG_KEEP_LINES=500
PROMPT="The unified calendar widget is paused. Read $UPDATING and update the widget for Omarchy's current clock."

TRIGGER="manual"
MODE="check"
CLOCK_STATE=""
FINGERPRINT=""
REASON=""

usage() {
  printf 'Usage: check-omarchy.sh [--trigger post-update|post-boot|manual] [--status] [--resume]\n'
}

log() {
  printf '%s %s\n' "$(date -Is)" "$*" 2>/dev/null || true
}

trim_log() {
  local size tmp
  [[ -f "$LOG_FILE" ]] || return 0
  size="$(stat -c %s -- "$LOG_FILE" 2>/dev/null || printf '0')"
  [[ "$size" =~ ^[0-9]+$ ]] && (( size > LOG_MAX_BYTES )) || return 0
  tmp="$LOG_FILE.trim.$$"
  # truncate in place: the hook wrapper appends through an fd already open on this file
  if tail -n "$LOG_KEEP_LINES" -- "$LOG_FILE" > "$tmp" 2>/dev/null; then
    cat -- "$tmp" > "$LOG_FILE" 2>/dev/null || true
  fi
  rm -f -- "$tmp" 2>/dev/null || true
}

layout_state() {
  local out
  [[ -f "$SHELL_JSON" ]] || { printf 'unreadable\n'; return 0; }
  out="$(jq -r --arg id "$PLUGIN_ID" '
    [(.bar.layout? // {}) | objects | (.left?, .center?, .right?) | arrays | .[]
      | if type == "object" then .id else . end]
    | if index($id) == null then "absent" else "present" end
  ' "$SHELL_JSON" 2>/dev/null)" || out=""
  case "$out" in
    present|absent) printf '%s\n' "$out" ;;
    *) printf 'unreadable\n' ;;
  esac
}

fingerprint_lines() {
  LC_ALL=C sort | sha256sum | cut -d ' ' -f 1
}

clock_fingerprint() {
  local name
  (
    cd "$CLOCK_DIR" || exit 1
    find . -maxdepth 1 -type f -printf '%P\n' | LC_ALL=C sort | while IFS= read -r name; do
      sha256sum -- "$name"
    done
  ) | fingerprint_lines
}

read_clock() {
  local recorded=""
  CLOCK_STATE="changed"
  if [[ ! -d "$CLOCK_DIR" ]]; then
    FINGERPRINT="no-clock-directory"
    REASON="Omarchy's clock directory is missing"
  elif ! FINGERPRINT="$(clock_fingerprint)" || [[ -z "$FINGERPRINT" ]]; then
    FINGERPRINT="unreadable-clock-directory"
    REASON="Omarchy's clock directory could not be read"
  elif [[ ! -f "$CLOCK_DIR/manifest.json" ]]; then
    REASON="Omarchy's clock has no manifest.json"
  else
    [[ -f "$SUMS" ]] && recorded="$(fingerprint_lines < "$SUMS" || true)"
    if [[ -z "$recorded" ]]; then
      REASON="the recorded checksums of Omarchy's clock are missing"
    elif [[ "$FINGERPRINT" != "$recorded" ]]; then
      REASON="Omarchy changed its clock"
    else
      CLOCK_STATE="unchanged"
      REASON=""
    fi
  fi
}

plugin_state() {
  local json state
  json="$(omarchy-shell shell listPlugins 2>/dev/null || true)"
  state="$(jq -r --arg id "$PLUGIN_ID" '
    map(select(.id == $id))
    | if length == 0 then "unknown" elif .[0].enabled then "enabled" else "disabled" end
  ' <<<"$json" 2>/dev/null || true)"
  case "$state" in
    enabled|disabled) printf '%s\n' "$state" ;;
    *) printf 'unknown\n' ;;
  esac
}

notify() {
  omarchy-notification-send "$@" >/dev/null 2>&1 || true
}

line_has_both() {
  awk -v a="$2" -v b="$3" 'index($0, a) && index($0, b) { found = 1; exit } END { exit !found }' <<<"$1"
}

log_has_failure() {
  local text
  text="$(qs log -p "$OMARCHY_SHELL_CONFIG" 2>/dev/null || true)"
  [[ -n "$text" ]] || return 1
  grep -qF "Plugin widget $PLUGIN_ID failed" <<<"$text" && return 0
  line_has_both "$text" "plugin $PLUGIN_ID" ') threw:' && return 0
  line_has_both "$text" "plugins/$PLUGIN_ID/" 'Error' && return 0
  return 1
}

poll_health() {
  local deadline out
  [[ "$HEALTH_WAIT" =~ ^[0-9]+$ ]] || HEALTH_WAIT=60
  deadline=$(( SECONDS + HEALTH_WAIT ))
  while true; do
    out="$(omarchy-shell "$STOCK_ID" calendarHealth 2>/dev/null || true)"
    if jq -e '.ok == true' >/dev/null 2>&1 <<<"$out"; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep "$POLL_SECONDS" || true
  done
}

write_paused() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  { printf '%s\n%s\n' "$1" "$2" > "$PAUSED"; } 2>/dev/null || log "the paused marker could not be written"
}

clear_paused() {
  [[ -e "$PAUSED" ]] || return 0
  rm -f -- "$PAUSED" 2>/dev/null || true
  log "cleared the paused marker"
}

set_anchor() {
  center_anchor_set "$1" || log "the bar centre anchor could not be moved to $1"
}

pause_widget() {
  local fingerprint="$1" reason="$2" body="$3" previous=""
  if [[ -f "$PAUSED" ]]; then
    previous="$(head -n 1 -- "$PAUSED" 2>/dev/null || true)"
  fi

  if [[ "$(plugin_state)" == enabled ]]; then
    log "switching the widget off: $reason"
    if ! omarchy-plugin-disable "$PLUGIN_ID" >/dev/null 2>&1; then
      log "omarchy-plugin-disable failed; the widget is still running"
      notify -u critical -g "$GLYPH" "Calendar widget still running" \
        "$reason, but the widget could not be switched off. Run: omarchy-plugin-disable $PLUGIN_ID"
      return 0
    fi
  else
    log "the widget is already switched off"
  fi

  set_anchor "$STOCK_ID"
  write_paused "$fingerprint" "$reason"

  if [[ "$previous" == "$fingerprint" && "$TRIGGER" != manual ]]; then
    log "already reported; no notification"
    return 0
  fi
  log "notifying: $reason"
  notify -u critical -g "$GLYPH" "Calendar widget paused" "$body" --exec "$AGENT_PROMPT_CMD" "$PROMPT"
}

run_check() {
  local layout plugin
  layout="$(layout_state)"
  if [[ "$layout" != present ]]; then
    log "$PLUGIN_ID is $layout in the bar layout of shell.json; nothing to check"
    return 0
  fi

  read_clock
  if [[ "$CLOCK_STATE" == changed ]]; then
    log "Omarchy's clock changed: $REASON"
    pause_widget "$FINGERPRINT" "$REASON" "Omarchy updated its clock. Click to update the widget."
    return 0
  fi
  log "Omarchy's clock is unchanged"

  if [[ "$TRIGGER" == post-update ]]; then
    log "the shell restarts at the end of the update; the next boot checks the widget"
    return 0
  fi

  plugin="$(plugin_state)"
  if [[ "$plugin" != enabled ]]; then
    log "$PLUGIN_ID is $plugin, so a health answer would not be its own; no health check"
    return 0
  fi

  if poll_health && ! log_has_failure; then
    log "the widget is healthy"
    clear_paused
    return 0
  fi
  log "the widget is not healthy"
  pause_widget "$FINGERPRINT" "the widget did not load" \
    "The calendar widget failed to load. Click to look into it."
}

resume() {
  log "switching the widget back on"
  if ! omarchy-plugin-enable "$PLUGIN_ID" >/dev/null; then
    log "omarchy-plugin-enable failed; the widget is still switched off"
    return 1
  fi
  set_anchor "$PLUGIN_ID"
  clear_paused
  if poll_health; then
    log "the widget is back and healthy"
    return 0
  fi
  log "the widget is back but not healthy; see $UPDATING"
  return 1
}

print_status() {
  local anchor="none" match="no" paused="no"
  read_clock
  [[ "$CLOCK_STATE" == unchanged ]] && match="yes"
  [[ -f "$SHELL_JSON" ]] && anchor="$(jq -r '.bar.centerAnchor // "none"' "$SHELL_JSON" 2>/dev/null || printf 'unreadable')"
  [[ -f "$PAUSED" ]] && paused="yes ($(sed -n '2p' -- "$PAUSED" 2>/dev/null || true))"
  printf 'clock: %s\n' "$CLOCK_DIR"
  printf 'clock fingerprint match: %s\n' "$match"
  [[ "$match" == yes ]] || printf 'clock fingerprint: %s (%s)\n' "$FINGERPRINT" "$REASON"
  printf 'widget: %s\n' "$(plugin_state)"
  printf 'anchor: %s\n' "$anchor"
  printf 'paused: %s\n' "$paused"
  printf 'last log lines:\n'
  tail -n 5 -- "$LOG_FILE" 2>/dev/null || true
}

while (( $# > 0 )); do
  case "$1" in
    --trigger)
      TRIGGER="${2:-}"
      case "$TRIGGER" in
        post-update|post-boot|manual) ;;
        *) usage >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --status) MODE="status"; shift ;;
    --resume) MODE="resume"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done

mkdir -p "$STATE_DIR" 2>/dev/null || true
trim_log

case "$MODE" in
  status) print_status ;;
  resume) resume ;;
  *) run_check ;;
esac
