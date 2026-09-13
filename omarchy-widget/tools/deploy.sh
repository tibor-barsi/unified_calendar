#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
widget_dir="$(cd "$script_dir/.." && pwd)"
source "$script_dir/center-anchor.sh"

PLUGIN_ID="unified.clock"
STOCK_ID="omarchy.clock"
UPSTREAM="${UNIFIED_WIDGET_UPSTREAM_DIR:-$widget_dir/upstream}"
OMARCHY_CLOCK_DIR="${UNIFIED_WIDGET_OMARCHY_CLOCK_DIR:-/usr/share/omarchy/shell/plugins/panels/clock}"
UPDATING="$widget_dir/UPDATING.md"
PLUGINS="${UNIFIED_WIDGET_PLUGINS_DIR:-$HOME/.config/omarchy/plugins}"
SRC="${UNIFIED_WIDGET_SRC:-$script_dir/../plugin}"
QMLLINT="${QMLLINT:-/usr/lib/qt6/bin/qmllint}"
OMARCHY_SHELL_CONFIG="${OMARCHY_SHELL_CONFIG:-/usr/share/omarchy/shell}"
HEALTH_TIMEOUT="${UNIFIED_WIDGET_HEALTH_TIMEOUT:-15}"
UNLOCK_TIMEOUT="${UNIFIED_WIDGET_UNLOCK_TIMEOUT:-600}"

# EX_TEMPFAIL: the session was locked, nothing is left half-done, run again later
EXIT_RETRY_LATER=75

CUR="$PLUGINS/$PLUGIN_ID"
PREV="$PLUGINS/.$PLUGIN_ID.prev"
FAILED="$PLUGINS/.$PLUGIN_ID.failed"

LAST_FAILURE_REASON=""
RESTART_LOCKED=0
SWAP_MS=0

rollback=0
no_enable=0
for arg in "$@"; do
  case "$arg" in
    --rollback) rollback=1 ;;
    --no-enable) no_enable=1 ;;
    *)
      echo "deploy.sh: unknown argument: $arg" >&2
      echo "Usage: deploy.sh [--rollback] [--no-enable]" >&2
      exit 1
      ;;
  esac
done

now_ms() {
  date +%s%3N
}

line_has_both() {
  awk -v a="$2" -v b="$3" 'index($0, a) && index($0, b) { found = 1; exit } END { exit !found }' <<<"$1"
}

log_has_failure() {
  local log
  log="$(qs log -p "$OMARCHY_SHELL_CONFIG" 2>/dev/null || true)"
  [[ -n "$log" ]] || return 1
  grep -qF "Plugin widget $PLUGIN_ID failed" <<<"$log" && return 0
  line_has_both "$log" "plugin $PLUGIN_ID" ') threw:' && return 0
  line_has_both "$log" "plugins/$PLUGIN_ID/" 'Error' && return 0
  return 1
}

wait_for_health() {
  local attempts=$HEALTH_TIMEOUT
  (( attempts >= 1 )) || attempts=1
  local i out loaded
  for (( i = 0; i < attempts; i++ )); do
    out="$(omarchy-shell omarchy.clock calendarHealth 2>/dev/null || true)"
    if [[ "$out" == *'"ok":true'* ]]; then
      loaded="$(jq -r '.loadedAt // empty' <<<"$out" 2>/dev/null || true)"
      # A copy loaded before the files moved must not count as the new version
      if [[ ! "$loaded" =~ ^[0-9]+$ ]] || (( loaded >= SWAP_MS )); then
        return 0
      fi
    fi
    (( i < attempts - 1 )) && sleep 1
  done
  return 1
}

wait_for_plugin_known() {
  local attempts=$HEALTH_TIMEOUT
  (( attempts >= 1 )) || attempts=1
  local i json
  for (( i = 0; i < attempts; i++ )); do
    json="$(omarchy-shell shell listPlugins 2>/dev/null || echo '[]')"
    jq -e --arg id "$PLUGIN_ID" 'any(.[]?; .id == $id)' >/dev/null 2>&1 <<<"$json" && return 0
    (( i < attempts - 1 )) && sleep 1
  done
  return 1
}

plugin_listed_enabled() {
  local json
  json="$(omarchy-shell shell listPlugins 2>/dev/null || echo '[]')"
  jq -e --arg id "$PLUGIN_ID" 'any(.[]?; .id == $id and .enabled == true)' >/dev/null 2>&1 <<<"$json"
}

# Exit 2 ("undetermined") counts as unlocked, as omarchy-hyprland-session-locked itself documents
session_locked() {
  omarchy-hyprland-session-locked >/dev/null 2>&1
}

wait_for_unlock() {
  local attempts=$UNLOCK_TIMEOUT
  (( attempts >= 1 )) || attempts=1
  local i
  for (( i = 0; i < attempts; i++ )); do
    session_locked || return 0
    (( i < attempts - 1 )) && sleep 1
  done
  return 1
}

wait_for_shell() {
  local attempts=$HEALTH_TIMEOUT
  (( attempts >= 1 )) || attempts=1
  local i
  for (( i = 0; i < attempts; i++ )); do
    omarchy-shell shell ping >/dev/null 2>&1 && return 0
    (( i < attempts - 1 )) && sleep 1
  done
  return 1
}

# omarchy-restart-shell also exits 1 when it refuses a locked session or its own 2 s readiness wait runs out
restart_shell() {
  RESTART_LOCKED=0
  omarchy-restart-shell >/dev/null 2>&1 && return 0
  if session_locked; then
    if wait_for_unlock && omarchy-restart-shell >/dev/null 2>&1; then
      return 0
    fi
    if session_locked; then
      RESTART_LOCKED=1
      LAST_FAILURE_REASON="the session is locked"
      return 1
    fi
  fi
  wait_for_shell && return 0
  LAST_FAILURE_REASON="the shell could not be restarted"
  return 1
}

# A running shell keeps the compiled QML of a plugin it has loaded, so only a fresh shell runs the new files
activate_and_check() {
  restart_shell || return 1
  if (( ! no_enable )); then
    wait_for_plugin_known || true
    if ! plugin_listed_enabled; then
      omarchy-plugin-enable "$PLUGIN_ID" >/dev/null 2>&1 || true
    fi
  fi
  if ! wait_for_health; then
    LAST_FAILURE_REASON="the widget did not report healthy within ${HEALTH_TIMEOUT}s"
    return 1
  fi
  if log_has_failure; then
    LAST_FAILURE_REASON="the shell log reported an error loading the widget"
    return 1
  fi
  return 0
}

notify_disabled() {
  local reason="$1"
  omarchy-plugin-disable "$PLUGIN_ID" >/dev/null 2>&1 || true
  center_anchor_set "$STOCK_ID" || true
  omarchy-notification-send -u critical -g 󰃭 "Calendar widget disabled" "$reason" >/dev/null 2>&1 || true
}

pin_bar_centre() {
  plugin_listed_enabled || return 0
  center_anchor_set "$PLUGIN_ID" || true
}

warn_if_clock_changed() {
  local sums="$UPSTREAM/SHA256SUMS"
  [[ -f "$sums" ]] || return 0
  if [[ ! -d "$OMARCHY_CLOCK_DIR" ]] || ! ( cd "$OMARCHY_CLOCK_DIR" && sha256sum --status -c "$sums" ); then
    echo "deploy.sh: Omarchy's clock no longer matches upstream/SHA256SUMS; see $UPDATING" >&2
  fi
}

retry_later() {
  echo "deploy.sh: the session is locked; $1. Run deploy.sh again after unlocking" >&2
  exit "$EXIT_RETRY_LATER"
}

recover_from_failure() {
  local reason="$1"
  if [[ -e "$PREV" ]]; then
    rm -rf "$FAILED"
    SWAP_MS=$(now_ms)
    mv "$CUR" "$FAILED"
    mv "$PREV" "$CUR"
    if activate_and_check; then
      echo "deploy.sh: $PLUGIN_ID failed ($reason), restored the previous version" >&2
      exit 1
    fi
    if (( RESTART_LOCKED )); then
      reason="$reason; the previous version is back on disk and loads after the next shell restart once the widget is enabled again"
      notify_disabled "$reason"
      echo "deploy.sh: $PLUGIN_ID failed and was disabled: $reason" >&2
      exit 1
    fi
    reason="$reason; the previous version then failed too: $LAST_FAILURE_REASON"
  fi
  notify_disabled "$reason"
  echo "deploy.sh: $PLUGIN_ID failed and was disabled: $reason" >&2
  exit 1
}

swap_cur_prev() {
  local tmp="$PLUGINS/.$PLUGIN_ID.swap.$$"
  local had_cur=0
  if [[ -e "$CUR" ]]; then
    mv "$CUR" "$tmp"
    had_cur=1
  fi
  mv "$PREV" "$CUR"
  (( had_cur )) && mv "$tmp" "$PREV"
  return 0
}

warn_if_clock_changed

if (( rollback )); then
  if [[ ! -e "$PREV" ]]; then
    echo "deploy.sh: no previous version to roll back to" >&2
    exit 1
  fi
  wait_for_unlock || retry_later "nothing was changed"
  SWAP_MS=$(now_ms)
  swap_cur_prev
  if activate_and_check; then
    pin_bar_centre
    echo "deploy.sh: $PLUGIN_ID rolled back to the previous version"
    exit 0
  fi
  if (( RESTART_LOCKED )); then
    swap_cur_prev
    retry_later "both versions were swapped back"
  fi
  recover_from_failure "$LAST_FAILURE_REASON"
fi

if ! omarchy-plugin-validate "$SRC"; then
  echo "deploy.sh: $SRC failed plugin validation" >&2
  exit 2
fi

qml_files=()
while IFS= read -r -d '' f; do
  qml_files+=("$f")
done < <(find "$SRC" -type f -name '*.qml' -print0 | sort -z)

for f in "${qml_files[@]}"; do
  code=0
  "$QMLLINT" "$f" || code=$?
  if (( code == 255 )); then
    echo "deploy.sh: qmllint found a syntax error in $f" >&2
    exit 3
  fi
done

wait_for_unlock || retry_later "nothing was changed"

mkdir -p "$PLUGINS"
stage="$PLUGINS/.$PLUGIN_ID.stage.$$"
rm -rf "$stage"
cp -a "$SRC" "$stage"

# The older rollback copy is only deleted once this deploy is settled, so a locked session can put everything back
aside="$PLUGINS/.$PLUGIN_ID.oldprev.$$"
rm -rf "$aside"
had_cur=0
SWAP_MS=$(now_ms)
if [[ -e "$CUR" ]]; then
  if [[ -e "$PREV" ]]; then
    mv "$PREV" "$aside"
  fi
  mv "$CUR" "$PREV"
  had_cur=1
fi
mv "$stage" "$CUR"

if activate_and_check; then
  rm -rf "$aside"
  pin_bar_centre
  echo "deploy.sh: $PLUGIN_ID deployed and healthy"
  exit 0
fi

if (( RESTART_LOCKED )); then
  rm -rf "$CUR"
  if (( had_cur )); then
    mv "$PREV" "$CUR"
    if [[ -e "$aside" ]]; then
      mv "$aside" "$PREV"
    fi
  fi
  retry_later "the previous files are back in place"
fi

rm -rf "$aside"
recover_from_failure "$LAST_FAILURE_REASON"
