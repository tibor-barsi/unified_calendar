#!/bin/bash
# Record the Omarchy clock on THIS machine as the widget's baseline.
#
# The baseline in upstream/ is what check-omarchy.sh compares the installed clock
# against to notice that an Omarchy update changed it. It is pinned to whichever
# Omarchy the widget was last reconciled with, so a machine running a different
# 4.x sees "the clock changed" the moment the hooks first run and pauses a widget
# that was never broken.
#
# Adopting the local clock silences that, correctly, but it does not merge
# Omarchy's changes into the widget: plugin/{BarWidget,Panel}.qml and Model.js stay
# derived from whatever version they were written against. Adopting says "this
# widget is fine on this clock" — which install.sh only concludes after the widget
# has actually loaded and answered a health probe. For a real reconciliation see
# UPDATING.md.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
widget_dir="$(cd "$script_dir/.." && pwd)"

CLOCK_DIR="${UNIFIED_WIDGET_OMARCHY_CLOCK_DIR:-/usr/share/omarchy/shell/plugins/panels/clock}"
UPSTREAM="${UNIFIED_WIDGET_UPSTREAM_DIR:-$widget_dir/upstream}"
SUMS="$UPSTREAM/SHA256SUMS"
VERSION_FILE="$UPSTREAM/VERSION"

assume_yes=0
check_only=0

usage() {
  cat <<'EOF'
Usage: rebaseline.sh [--check] [--yes]

  --check   Report whether the installed clock matches the recorded baseline and
            exit 0 (match) or 1 (differs). Writes nothing.
  --yes     Adopt without the interactive confirmation.

Environment:
  UNIFIED_WIDGET_OMARCHY_CLOCK_DIR   clock to read   (default: Omarchy's)
  UNIFIED_WIDGET_UPSTREAM_DIR        baseline to write (default: ../upstream)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --check) check_only=1 ;;
    --yes|-y) assume_yes=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'rebaseline.sh: unknown argument: %s\n' "$arg" >&2; usage >&2; exit 1 ;;
  esac
done

# Exactly the line set check-omarchy.sh's clock_fingerprint() builds, so a baseline
# written here compares equal there: every file at the top level of the clock dir,
# hashed from inside it, sorted by name.
sums_for() {
  local dir="$1" name
  ( cd "$dir" && find . -maxdepth 1 -type f -printf '%P\n' | LC_ALL=C sort \
      | while IFS= read -r name; do sha256sum -- "$name"; done )
}

omarchy_version() {
  pacman -Q omarchy 2>/dev/null || printf 'omarchy unknown\n'
}

[[ -d "$CLOCK_DIR" ]] || { printf 'rebaseline.sh: no clock directory at %s\n' "$CLOCK_DIR" >&2; exit 1; }
[[ -f "$CLOCK_DIR/manifest.json" ]] || { printf 'rebaseline.sh: %s has no manifest.json — not a clock plugin\n' "$CLOCK_DIR" >&2; exit 1; }

current="$(sums_for "$CLOCK_DIR")"
[[ -n "$current" ]] || { printf 'rebaseline.sh: could not read %s\n' "$CLOCK_DIR" >&2; exit 1; }

# check-omarchy.sh fingerprints plain files at the top level only, and this has to
# match it exactly. If Omarchy ever ships the clock with a subdirectory or a
# symlinked file, neither script would see it — say so rather than record a
# baseline that quietly ignores part of the plugin.
unseen="$(find "$CLOCK_DIR" -maxdepth 1 -mindepth 1 \! -type f -printf '%P\n' 2>/dev/null || true)"
if [[ -n "$unseen" ]]; then
  printf 'rebaseline.sh: warning — ignoring entries the fingerprint cannot see:\n' >&2
  printf '  %s\n' $unseen >&2
  printf '  (only plain files at the top level are hashed, here and in check-omarchy.sh)\n' >&2
fi

recorded=""
[[ -f "$SUMS" ]] && recorded="$(cat "$SUMS")"

# check-omarchy.sh sorts the lines before hashing, so a baseline whose lines are in
# a different order is still a match there. Compare the same way, or a re-baseline
# would "fix" a difference that does not exist.
normalize() { LC_ALL=C sort; }

if [[ "$(normalize <<<"$current")" == "$(normalize <<<"$recorded")" ]]; then
  printf 'Baseline already matches the installed clock (%s).\n' "$(omarchy_version)"
  exit 0
fi

(( check_only )) && {
  printf 'Baseline differs from the installed clock.\n'
  printf '  recorded: %s\n' "$([[ -f "$VERSION_FILE" ]] && cat "$VERSION_FILE" || printf 'none')"
  printf '  installed: %s\n' "$(omarchy_version)"
  exit 1
}

# Show what actually moved, by name, so adopting is an informed choice.
printf 'The installed clock differs from the recorded baseline.\n\n'
printf '  recorded baseline: %s\n' "$([[ -f "$VERSION_FILE" ]] && cat "$VERSION_FILE" || printf 'none')"
printf '  installed Omarchy: %s\n\n' "$(omarchy_version)"

declare -A had=() now=()
while read -r hash name; do [[ -n "$name" ]] && had["$name"]="$hash"; done <<<"$recorded"
while read -r hash name; do [[ -n "$name" ]] && now["$name"]="$hash"; done <<<"$current"

for name in $(printf '%s\n' "${!had[@]}" "${!now[@]}" | LC_ALL=C sort -u); do
  if [[ -z "${now[$name]:-}" ]]; then printf '  removed:   %s\n' "$name"
  elif [[ -z "${had[$name]:-}" ]]; then printf '  added:     %s\n' "$name"
  elif [[ "${had[$name]}" != "${now[$name]}" ]]; then printf '  changed:   %s\n' "$name"
  fi
done
printf '\n'

if [[ -n "$recorded" ]]; then
  printf 'Adopting records the installed clock as the baseline. It does NOT merge\n'
  printf "Omarchy's changes into the widget — see UPDATING.md for that.\n\n"
fi

if ! (( assume_yes )); then
  read -r -p 'Adopt the installed clock as the baseline? [y/N] ' reply
  [[ "$reply" == [yY]* ]] || { printf 'Left the baseline alone.\n'; exit 1; }
fi

mkdir -p "$UPSTREAM"
# Replace the tracked copies rather than merging, so upstream/ is always exactly
# one Omarchy version and `git diff` shows precisely what changed.
while read -r _ name; do
  [[ -n "$name" ]] || continue
  cp -- "$CLOCK_DIR/$name" "$UPSTREAM/$name"
done <<<"$current"

for name in "${!had[@]}"; do
  [[ -z "${now[$name]:-}" ]] && rm -f -- "$UPSTREAM/$name"
done

printf '%s\n' "$current" > "$SUMS"
omarchy_version > "$VERSION_FILE"

printf 'Baseline adopted: %s\n' "$(cat "$VERSION_FILE")"

# Only worth mentioning git when the baseline really is inside this working tree;
# with UNIFIED_WIDGET_UPSTREAM_DIR pointed elsewhere there is nothing to review.
top="$(git -C "$widget_dir" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$top" && "$UPSTREAM" == "$top"/* ]]; then
  printf 'Tracked files changed — review with: git diff %s\n' "${UPSTREAM#"$top/"}"
fi
