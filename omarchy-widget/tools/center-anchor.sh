#!/bin/bash
set -euo pipefail

center_anchor_log() {
  printf '%s %s\n' "$(date -Is)" "$*" 2>/dev/null || true
}

center_anchor_other() {
  case "$1" in
    unified.clock) printf 'omarchy.clock\n' ;;
    omarchy.clock) printf 'unified.clock\n' ;;
    *) return 1 ;;
  esac
}

center_anchor_set() {
  local to="$1" file from content matched current replacement updated expected actual dir tmp
  file="${UNIFIED_WIDGET_SHELL_JSON:-$HOME/.config/omarchy/shell.json}"
  if ! from="$(center_anchor_other "$to")"; then
    printf 'center-anchor.sh: not a clock id: %s\n' "$to" >&2
    return 2
  fi
  if [[ ! -f "$file" ]]; then
    center_anchor_log "center anchor: $file is not there"
    return 0
  fi

  content=""
  IFS= read -r -d '' content < "$file" || true
  local pattern='"centerAnchor"[[:space:]]*:[[:space:]]*"([^"]*)"'
  if [[ ! "$content" =~ $pattern ]]; then
    center_anchor_log "center anchor: shell.json names no centerAnchor"
    return 0
  fi
  matched="${BASH_REMATCH[0]}"
  current="${BASH_REMATCH[1]}"
  if [[ "$current" == "$to" ]]; then
    center_anchor_log "center anchor: already $to"
    return 0
  fi
  if [[ "$current" != "$from" ]]; then
    center_anchor_log "center anchor: left at $current, which is neither clock"
    return 0
  fi

  replacement="${matched%\"$from\"}\"$to\""
  updated="${content/"$matched"/"$replacement"}"
  if ! expected="$(jq -S --arg to "$to" '.bar.centerAnchor = $to' <<<"$content" 2>/dev/null)" ||
    ! actual="$(jq -S . <<<"$updated" 2>/dev/null)" ||
    [[ "$expected" != "$actual" ]]; then
    printf 'center-anchor.sh: rewriting %s would change more than centerAnchor; nothing was written\n' "$file" >&2
    return 1
  fi

  dir="$(dirname -- "$file")"
  tmp="$(mktemp "$dir/.shell.json.XXXXXX")"
  chmod --reference="$file" "$tmp"
  printf '%s' "$updated" > "$tmp"
  mv -f -- "$tmp" "$file"
  center_anchor_log "center anchor: $current -> $to"
}

center_anchor_main() {
  if (( $# != 1 )); then
    printf 'Usage: center-anchor.sh <unified.clock|omarchy.clock>\n' >&2
    return 1
  fi
  center_anchor_set "$1"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  center_anchor_main "$@"
fi
