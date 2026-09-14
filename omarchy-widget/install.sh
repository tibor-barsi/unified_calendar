#!/bin/bash
# One-shot setup of the unified_calendar server + Omarchy bar widget on this machine.
#
# The widget is only half of the thing: it renders events fetched from a
# unified_calendar server on localhost, so a fresh machine needs both. This walks
# the whole path — dependencies, the systemd user service, the clock baseline, the
# plugin, the update hooks, the keybinding — and every step is re-runnable.
#
#   ./install.sh                 install or repair, asking before anything surprising
#   ./install.sh --port 8585     serve on a different port
#   ./install.sh --yes           no prompts (for a scripted rollout)
#   ./install.sh --uninstall     put the machine back the way it was
#
# Nothing here needs sudo, and nothing writes outside $HOME and this checkout.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
widget_dir="$script_dir"
repo_dir="$(cd "$widget_dir/.." && pwd)"
tools_dir="$widget_dir/tools"

PLUGIN_ID="unified.clock"
SERVICE_NAME="calendar"
UNIT_DIR="${UNIFIED_WIDGET_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT="$UNIT_DIR/$SERVICE_NAME.service"
SHELL_JSON="${UNIFIED_WIDGET_SHELL_JSON:-$HOME/.config/omarchy/shell.json}"
BINDINGS="${UNIFIED_WIDGET_BINDINGS:-$HOME/.config/hypr/bindings.lua}"
CLOCK_DIR="${UNIFIED_WIDGET_OMARCHY_CLOCK_DIR:-/usr/share/omarchy/shell/plugins/panels/clock}"
STATE_DIR="${UNIFIED_WIDGET_STATE_DIR:-$HOME/.local/state/unified-calendar-widget}"

BIND_KEY="SUPER + SHIFT + C"
BIND_BEGIN="-- >>> unified-calendar-widget (added by omarchy-widget/install.sh)"
BIND_END="-- <<< unified-calendar-widget"

DEFAULT_PORT=3000
port=""
assume_yes=0
offline_cache=""
do_hooks=1
do_keybind=""
skip_npm=0
uninstall=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]
       install.sh --uninstall

Options:
  --port N          Port for the calendar server (default: 3000, or the port an
                    existing install already uses). Written into the systemd unit
                    and into the widget's serverUrl.
  --offline-cache   Let the SERVER cache a reduced copy of events to disk, so the
                    widget still renders while a calendar provider is unreachable.
                    Off by default: it is the only event data the server stores.
  --no-offline-cache  Turn that back off on a re-run.
  --no-hooks        Skip the Omarchy post-update / post-boot hooks.
  --keybind         Bind SUPER + SHIFT + C to the calendar popup without asking.
  --no-keybind      Never touch the Hyprland keybindings.
  --skip-npm        Do not run `npm install` (dependencies already present).
  --yes, -y         Accept every prompt. Implies --keybind unless --no-keybind.
  --uninstall       Remove the widget, hooks, keybinding and service. Your
                    calendars in data/ are kept.
  -h, --help        This text.
EOF
}

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\n\033[31minstall.sh: %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  (( assume_yes )) && return 0
  local reply
  read -r -p "    $1 [y/N] " reply
  [[ "$reply" == [yY]* ]]
}

backup() {
  # Timestamped, never overwritten, so repeated runs keep every previous state.
  local file="$1"
  [[ -e "$file" ]] || return 0
  local dest="$file.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p -- "$file" "$dest"
  info "backed up $(basename "$file") -> $(basename "$dest")"
}

while (( $# )); do
  case "$1" in
    --port) [[ -n "${2:-}" ]] || die "--port needs a number"; port="$2"; shift 2 ;;
    --port=*) port="${1#*=}"; shift ;;
    --offline-cache) offline_cache=1; shift ;;
    --no-offline-cache) offline_cache=0; shift ;;
    --no-hooks) do_hooks=0; shift ;;
    --keybind) do_keybind=1; shift ;;
    --no-keybind) do_keybind=0; shift ;;
    --skip-npm) skip_npm=1; shift ;;
    --yes|-y) assume_yes=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'install.sh: unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

# ── uninstall ────────────────────────────────────────────────────────────────

remove_keybind() {
  [[ -f "$BINDINGS" ]] || return 0
  grep -qF "$BIND_BEGIN" "$BINDINGS" || return 0
  backup "$BINDINGS"
  # Drop the marked block and the blank line that precedes it.
  awk -v b="$BIND_BEGIN" -v e="$BIND_END" '
    index($0, b) { drop = 1; if (blank) blank = 0; next }
    index($0, e) { drop = 0; next }
    drop { next }
    { print }
  ' "$BINDINGS" > "$BINDINGS.tmp"
  mv -- "$BINDINGS.tmp" "$BINDINGS"
  info "removed the $BIND_KEY binding"
  command -v hyprctl >/dev/null && hyprctl reload >/dev/null 2>&1 || true
}

do_uninstall() {
  say "Removing the Omarchy update hooks"
  if [[ -x "$tools_dir/install-hooks.sh" ]]; then
    "$tools_dir/install-hooks.sh" --uninstall || warn "hook removal reported a problem"
  fi

  say "Removing the widget from the bar"
  if [[ -x "$tools_dir/deploy.sh" ]]; then
    # deploy.sh --rollback restores the previous copy and returns the centre anchor
    # to Omarchy's own clock, so the bar is never left without one.
    "$tools_dir/deploy.sh" --rollback || warn "rollback reported a problem; check the bar"
  fi

  say "Removing the keybinding"
  remove_keybind

  say "Stopping the calendar service"
  if systemctl --user list-unit-files "$SERVICE_NAME.service" >/dev/null 2>&1; then
    systemctl --user disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
  fi
  if [[ -f "$UNIT" ]]; then
    backup "$UNIT"
    rm -f -- "$UNIT"
    systemctl --user daemon-reload || true
    info "removed $UNIT"
  fi

  say "Done"
  info "Your calendars and settings are untouched in $repo_dir/data/"
  info "The widget's own cache is at ~/.cache/unified-calendar-widget/ — delete it if you want it gone."
  info "State and logs: $STATE_DIR"
}

(( uninstall )) && { do_uninstall; exit 0; }

# ── 1. preflight ─────────────────────────────────────────────────────────────

say "Checking this machine"

[[ -f "$repo_dir/server.js" && -f "$repo_dir/package.json" ]] \
  || die "this does not look like a unified_calendar checkout: $repo_dir"

[[ -d "$CLOCK_DIR" ]] \
  || die "Omarchy's bar clock is not at $CLOCK_DIR — is Omarchy installed? (override with UNIFIED_WIDGET_OMARCHY_CLOCK_DIR)"

omarchy_version="$(pacman -Q omarchy 2>/dev/null | awk '{print $2}' || true)"
if [[ -n "$omarchy_version" ]]; then
  info "Omarchy $omarchy_version"
  case "$omarchy_version" in
    4.*) ;;
    *) warn "this widget was built for Omarchy 4.x; $omarchy_version is untested"
       confirm "Continue anyway?" || die "stopped" ;;
  esac
else
  warn "could not read the Omarchy version from pacman — continuing"
fi

missing=()
for cmd in jq curl sha256sum systemctl; do
  command -v "$cmd" >/dev/null || missing+=("$cmd")
done
(( ${#missing[@]} )) && die "missing required commands: ${missing[*]}"

for cmd in omarchy-plugin-enable omarchy-plugin-validate omarchy-restart-shell omarchy-shell; do
  command -v "$cmd" >/dev/null || warn "$cmd not found — deploy may fail"
done

# Prefer mise's shim: it is a stable path that keeps working across Node upgrades,
# where a versioned install path breaks the unit the next time Node is bumped.
node_bin=""
if [[ -x "$HOME/.local/share/mise/shims/node" ]]; then
  node_bin="$HOME/.local/share/mise/shims/node"
  info "node: mise shim (stable across Node upgrades)"
elif command -v node >/dev/null; then
  node_bin="$(command -v node)"
  warn "using $node_bin — a Node upgrade may move this path and break the service"
else
  die "node not found; install Node (e.g. 'mise use -g node@lts') and re-run"
fi
info "node $("$node_bin" --version 2>/dev/null || echo '?')"

command -v npm >/dev/null || (( skip_npm )) || die "npm not found; install it or pass --skip-npm"

# ── 2. port ──────────────────────────────────────────────────────────────────

say "Choosing the port"

existing_port=""
if [[ -f "$UNIT" ]]; then
  existing_port="$(sed -n 's/^Environment=PORT=\([0-9]\+\).*/\1/p' "$UNIT" | tail -1)"
fi

if [[ -z "$port" ]]; then
  suggested="${existing_port:-$DEFAULT_PORT}"
  if (( assume_yes )); then
    port="$suggested"
  else
    read -r -p "    Port for the calendar server [$suggested]: " port
    port="${port:-$suggested}"
  fi
fi

[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) \
  || die "port must be a number between 1024 and 65535 (got: $port)"

# A port already held by something that is not our own service is a hard stop:
# the widget would silently poll a stranger.
if command -v ss >/dev/null && ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
  if systemctl --user is-active --quiet "$SERVICE_NAME.service" 2>/dev/null && [[ "$existing_port" == "$port" || -z "$existing_port" ]]; then
    info "port $port is in use by the calendar service itself — will restart it"
  else
    die "port $port is already in use by something else; pick another with --port"
  fi
fi
info "using port $port"

server_url="http://127.0.0.1:$port"

# ── 3. dependencies ──────────────────────────────────────────────────────────

if (( skip_npm )); then
  say "Skipping npm install"
else
  say "Installing Node dependencies"
  ( cd "$repo_dir" && npm install --no-audit --no-fund ) || die "npm install failed"
fi

# ── 4. the systemd user service ──────────────────────────────────────────────

say "Installing the calendar service"

if [[ -z "$offline_cache" ]]; then
  if [[ -f "$UNIT" ]] && grep -q '^Environment=UNIFIED_CALENDAR_WIDGET_CACHE=1' "$UNIT"; then
    offline_cache=1   # keep what this machine already chose
  elif (( assume_yes )); then
    offline_cache=0
  else
    info "The server can keep a reduced copy of events on disk (id, title, times,"
    info "calendar, colour — no descriptions, locations or links) so the widget"
    info "still renders when a calendar provider is unreachable."
    if confirm "Enable the offline event cache?"; then offline_cache=1; else offline_cache=0; fi
  fi
fi

mkdir -p "$UNIT_DIR"
backup "$UNIT"

{
  printf '[Unit]\n'
  printf 'Description=Unified Calendar server (http://localhost:%s)\n' "$port"
  printf 'After=network.target\n\n'
  printf '[Service]\n'
  printf 'Type=simple\n'
  printf 'WorkingDirectory=%s\n' "$repo_dir"
  printf 'ExecStart=%s server.js\n' "$node_bin"
  printf 'Restart=on-failure\n'
  printf 'RestartSec=5\n'
  printf 'Environment=NODE_ENV=production\n'
  printf 'Environment=PORT=%s\n' "$port"
  (( offline_cache )) && printf 'Environment=UNIFIED_CALENDAR_WIDGET_CACHE=1\n'
  printf '\n[Install]\n'
  printf 'WantedBy=default.target\n'
} > "$UNIT"

info "wrote $UNIT"
(( offline_cache )) && info "offline event cache: on" || info "offline event cache: off"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME.service" >/dev/null 2>&1 || true
systemctl --user restart "$SERVICE_NAME.service" || die "the calendar service failed to start — see: journalctl --user -u $SERVICE_NAME -n 40"

say "Waiting for the server"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 2 "$server_url/api/widget/events?start=$(date +%Y-%m-%d)&end=$(date -d '+1 day' +%Y-%m-%d)" 2>/dev/null; then
    ready=1; break
  fi
  sleep 1
done
if (( ready )); then
  info "the widget API is answering on $server_url"
else
  warn "the server did not answer on $server_url within 30s"
  warn "check: journalctl --user -u $SERVICE_NAME -n 40"
  confirm "Carry on and install the widget anyway?" || die "stopped"
fi

# ── 5. the clock baseline ────────────────────────────────────────────────────

say "Checking Omarchy's clock against the widget's baseline"

if "$tools_dir/rebaseline.sh" --check >/dev/null 2>&1; then
  info "the baseline matches this machine's clock"
else
  info "This machine's Omarchy clock differs from the one the widget was built"
  info "against. Left alone, the update check would read that as 'Omarchy changed"
  info "its clock' on the first boot and pause a widget that may be perfectly fine."
  info "Adopting it as the baseline silences that; the widget is then verified by"
  info "actually loading it, below."
  if (( assume_yes )) || confirm "Adopt this machine's clock as the baseline?"; then
    "$tools_dir/rebaseline.sh" --yes || die "could not record the baseline"
    adopted_baseline=1
  else
    warn "keeping the recorded baseline — expect the update check to pause the widget"
  fi
fi

# ── 6. deploy the widget ─────────────────────────────────────────────────────

say "Deploying the widget to the bar"
info "(this restarts the Omarchy shell — the bar will blink)"
"$tools_dir/deploy.sh" || {
  rc=$?
  (( rc == 75 )) && die "the session is locked; unlock and run install.sh again"
  die "deploy failed — the previous bar clock has been left in place"
}

# ── 7. point the widget at this server ───────────────────────────────────────

say "Pointing the widget at $server_url"

if [[ ! -f "$SHELL_JSON" ]]; then
  warn "no $SHELL_JSON — set serverUrl on the $PLUGIN_ID entry yourself"
else
  backup "$SHELL_JSON"
  tmp="$SHELL_JSON.tmp.$$"
  # The widget's settings live inline on its bar.layout entry. An entry may be a
  # bare id string, which cannot carry settings — promote it to an object.
  jq --arg id "$PLUGIN_ID" --arg url "$server_url" '
    .bar.layout |= with_entries(
      .value |= map(
        if (type == "object" and .id == $id) then .serverUrl = $url
        elif (type == "string" and . == $id) then { id: $id, serverUrl: $url }
        else . end
      )
    )
  ' "$SHELL_JSON" > "$tmp" || { rm -f -- "$tmp"; die "could not edit $SHELL_JSON"; }

  # Prove the edit changed serverUrl and nothing else before it goes live.
  if ! diff -q <(jq -S "walk(if type == \"object\" and has(\"serverUrl\") then del(.serverUrl) else . end)" "$SHELL_JSON") \
                <(jq -S "walk(if type == \"object\" and has(\"serverUrl\") then del(.serverUrl) else . end)" "$tmp") >/dev/null; then
    rm -f -- "$tmp"
    die "the shell.json edit would have changed more than serverUrl — left it alone"
  fi
  mv -- "$tmp" "$SHELL_JSON"
  if jq -e --arg id "$PLUGIN_ID" --arg url "$server_url" '
        [.bar.layout[]?[]? | select(type == "object" and .id == $id and .serverUrl == $url)] | length > 0
      ' "$SHELL_JSON" >/dev/null; then
    info "serverUrl set on the $PLUGIN_ID entry"
  else
    warn "could not find a $PLUGIN_ID entry in bar.layout — is the widget on the bar?"
  fi
fi

# ── 8. update hooks ──────────────────────────────────────────────────────────

if (( do_hooks )); then
  say "Installing the Omarchy update hooks"
  if "$tools_dir/install-hooks.sh"; then
    info "post-update and post-boot will check the clock and the widget's health"
  else
    warn "hook install failed — run $tools_dir/install-hooks.sh by hand"
  fi
else
  say "Skipping the update hooks (--no-hooks)"
fi

# ── 9. keybinding ────────────────────────────────────────────────────────────

say "Keybinding"

if [[ -z "$do_keybind" ]]; then
  if (( assume_yes )); then do_keybind=1
  elif confirm "Bind $BIND_KEY to the calendar popup (replaces Omarchy's HEY Calendar binding)?"; then do_keybind=1
  else do_keybind=0; fi
fi

if (( do_keybind )); then
  if [[ ! -f "$BINDINGS" ]]; then
    warn "no $BINDINGS — skipping the keybinding"
  elif grep -qF "$BIND_BEGIN" "$BINDINGS"; then
    info "already bound"
  elif grep -q "^[^-]*[\"']$BIND_KEY[\"']" "$BINDINGS"; then
    # Someone already bound this key by hand (this repo's own author did). Adding
    # our block would leave two binds on one key, so say so and leave it alone.
    info "$BIND_KEY is already bound in $(basename "$BINDINGS") — leaving it as it is"
    info "to let install.sh manage it, delete that binding and re-run"
  else
    backup "$BINDINGS"
    {
      printf '\n%s\n' "$BIND_BEGIN"
      printf -- '-- Calendar popup on the bar clock. Was: HEY Calendar (Omarchy default).\n'
      printf -- '-- `shell toggle` reaches a clone of omarchy.clock when one is enabled.\n'
      printf 'hl.unbind("%s")\n' "$BIND_KEY"
      printf 'o.bind("%s", "Calendar", "omarchy-shell shell toggle omarchy.clock")\n' "$BIND_KEY"
      printf '%s\n' "$BIND_END"
    } >> "$BINDINGS"
    info "bound $BIND_KEY"
    if command -v hyprctl >/dev/null; then
      hyprctl reload >/dev/null 2>&1 || true
      errs="$(hyprctl configerrors 2>/dev/null || true)"
      if [[ -n "$errs" && "$errs" != "no errors" ]]; then
        warn "hyprctl reports config errors after the change:"
        printf '%s\n' "$errs" >&2
      fi
    fi
  fi
else
  info "left the keybindings alone"
fi

# ── done ─────────────────────────────────────────────────────────────────────

say "Installed"
info "Web app:    $server_url"
info "Popup:      click the bar clock$( (( do_keybind )) && printf ', or %s' "$BIND_KEY" )"
info "Health:     omarchy-shell omarchy.clock calendarHealth"
info "Service:    systemctl --user status $SERVICE_NAME"
info "Logs:       journalctl --user -u $SERVICE_NAME -f"
info "Uninstall:  $widget_dir/install.sh --uninstall"
printf '\n'
info "Add your calendars at $server_url (Settings -> ICS / CalDAV / OAuth)."
if [[ -n "${adopted_baseline:-}" ]]; then
  printf '\n'
  warn "The clock baseline was adopted from this machine, so tracked files changed."
  warn "Review with: git -C $repo_dir diff omarchy-widget/upstream/"
fi
