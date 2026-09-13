#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOOK_NAME="unified-calendar-widget"
EVENTS=(post-update post-boot)
HOOK_INSTALL="${OMARCHY_HOOK_INSTALL:-omarchy-hook-install}"
TMP_DIR=""

usage() {
  printf 'Usage: install-hooks.sh [--uninstall]\n'
}

cleanup() {
  [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]] || return 0
  rm -f -- "$TMP_DIR/$HOOK_NAME"
  rmdir -- "$TMP_DIR" 2>/dev/null || true
}

resolve_check_script() {
  local path="${UNIFIED_WIDGET_CHECK_SCRIPT:-$script_dir/check-omarchy.sh}"
  if ! realpath -e -- "$path" 2>/dev/null; then
    printf 'install-hooks.sh: check script not found: %s\n' "$path" >&2
    return 1
  fi
}

write_wrapper() {
  local file="$1" event="$2" check="$3"
  {
    cat <<'EOF'
#!/bin/bash
set -euo pipefail
PATH="$HOME/.local/share/mise/shims:$PATH"
state="${UNIFIED_WIDGET_STATE_DIR:-$HOME/.local/state/unified-calendar-widget}"
mkdir -p "$state" 2>/dev/null || true
EOF
    printf 'check=%q\n' "$check"
    cat <<'EOF'
[[ -x "$check" ]] || exit 0
# An inherited update lock fd would keep the next omarchy update from starting
if [[ -n ${OMARCHY_UPDATE_LOCK_FD:-} ]]; then
  if [[ $OMARCHY_UPDATE_LOCK_FD =~ ^[0-9]+$ ]] && (( OMARCHY_UPDATE_LOCK_FD > 2 )); then
    exec {OMARCHY_UPDATE_LOCK_FD}>&-
  fi
  unset OMARCHY_UPDATE_LOCK_FD
fi
EOF
    if [[ "$event" == post-update ]]; then
      printf '{ timeout 60 "$check" --trigger post-update >>"$state/check.log" 2>&1; } || true\n'
    else
      printf '{ setsid -f "$check" --trigger post-boot >>"$state/check.log" 2>&1 </dev/null; } 2>/dev/null || true\n'
    fi
    printf 'exit 0\n'
  } > "$file"
}

install_hooks() {
  local check event
  check="$(resolve_check_script)"
  TMP_DIR="$(mktemp -d)"
  for event in "${EVENTS[@]}"; do
    write_wrapper "$TMP_DIR/$HOOK_NAME" "$event" "$check"
    "$HOOK_INSTALL" "$event" "$TMP_DIR/$HOOK_NAME"
  done
  printf 'post-update runs %s inline; post-boot runs it detached; both append to check.log in the state dir\n' "$check"
}

uninstall_hooks() {
  local event file removed=0
  for event in "${EVENTS[@]}"; do
    file="$HOME/.config/omarchy/hooks/$event.d/$HOOK_NAME"
    if [[ -f "$file" || -L "$file" ]]; then
      rm -f -- "$file"
      printf 'Removed %s\n' "$file"
      removed=1
    fi
  done
  (( removed )) || printf 'The %s hooks are not installed\n' "$HOOK_NAME"
}

trap cleanup EXIT

if (( $# > 1 )); then
  usage >&2
  exit 1
fi

case "${1:-}" in
  "") install_hooks ;;
  --uninstall) uninstall_hooks ;;
  -h|--help) usage ;;
  *)
    usage >&2
    exit 1
    ;;
esac
