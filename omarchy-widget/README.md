# Calendar Clock — an Omarchy bar widget

Omarchy's own top-bar clock, with this project's events built into it. The bar
still shows the time and the panel still looks like Omarchy's; what is added is:

- up to three event dots per day cell, in the theme's text colour
- important days filled with the theme's attention colour (`Color.bar.active`)
- a mark next to the clock label while today still has an important event ahead
- click a day and the panel grows to show that day's events; click an event for
  its details inline
- a collapsed "★ N upcoming" line, opened on demand (`u`, or click it)
- desktop reminders at configurable offsets before an event

It reads from a **locally running** unified_calendar server and caches what it
last saw, so the panel still shows events when the server is down — with a
"synced X ago" note. Nothing is sent anywhere.

## Requirements

- Omarchy 4 (Arch + Hyprland + Quickshell). The widget replaces the stock clock,
  so it is specific to this desktop and useless elsewhere.
- The unified_calendar server running locally — normally as a systemd **user**
  service on port 3000. `install.sh` sets that up for you.
- Node, for the server. A `mise` shim is preferred: the unit then keeps working
  across Node upgrades, where a version-pinned path would break.
- `jq` and `curl` (both are already Omarchy dependencies).

## Install

On a fresh Omarchy machine, from a clone of this repository:

    omarchy-widget/install.sh

That is the whole thing. It checks the machine, installs the Node dependencies,
writes and starts a `calendar.service` systemd **user** unit pointed at this
checkout, waits for the widget API to answer, reconciles the clock baseline,
deploys the plugin, points the widget at the server, installs the update hooks,
and offers the `SUPER + SHIFT + C` keybinding. Every step is re-runnable: run it
again after pulling and it repairs rather than duplicates.

    install.sh --port 8585      serve on a different port
    install.sh --yes            no prompts, for a scripted rollout
    install.sh --offline-cache  let the server keep a reduced event cache on disk
    install.sh --no-keybind     leave the Hyprland bindings alone
    install.sh --uninstall      put the machine back (your calendars are kept)

It never needs root, and writes only inside `$HOME` and this checkout. Anything
it replaces — the unit, `shell.json`, `bindings.lua` — is copied to a timestamped
`.bak-<date>` first.

### If your Omarchy is newer than the baseline

`upstream/` records the Omarchy clock this widget was last reconciled with.
On a machine running a different 4.x, the update check would otherwise read the
difference as "Omarchy changed its clock" on the first boot and pause a widget
that is fine. `install.sh` offers to adopt the local clock as the baseline, and
only concludes the widget is healthy after it has actually loaded and answered a
health probe. Adoption is recorded in tracked files, so `git diff
omarchy-widget/upstream/` always shows which Omarchy you are pinned to.

Adopting does **not** merge Omarchy's clock changes into the widget — the panel
is still built from the code it was written against. For a real reconciliation
see `UPDATING.md`; to adopt or check by hand:

    tools/rebaseline.sh --check     does the installed clock match the baseline?
    tools/rebaseline.sh             adopt it, after showing what differs

### Doing it by hand

    tools/deploy.sh          copy plugin/ into place and restart the shell
    tools/install-hooks.sh   register the post-update / post-boot checks

`deploy.sh` keeps the previous copy as `.unified.clock.prev`; `--rollback` puts
it back. Add `unified.clock` to the bar and remove `omarchy.clock` — both
register the same IPC target, so running them together makes health checks
ambiguous. If `bar.centerAnchor` in `~/.config/omarchy/shell.json` names
`omarchy.clock`, `deploy.sh` repoints it at `unified.clock`; otherwise the clock
drifts sideways whenever the hover-reveal icons appear.

## Settings

The widget's settings live in its entry in `~/.config/omarchy/shell.json`, edited
through Omarchy's own settings UI:

| Key | Default | Meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:3000` | where the calendar server is. Must be http(s); anything else falls back to the default. |
| `calendars` | `[]` (all) | ids of the calendars to show. |
| `reminders` | `["1d", "15m"]` | offsets before an event to notify at. |
| `allDayReminderTime` | `"08:00"` | clock time an all-day event's reminder fires at. |
| `upcomingDays` | `30` (1–60) | how far ahead the "★ N upcoming" list looks. |
| `upcomingMax` | `5` (1–20) | how many entries that list shows. |
| `refreshMinutes` | `15` (5–240) | polling interval. Failures back off to 30 s, 30 s, 60 s, 120 s, 300 s, then this. |

`SUPER+SHIFT+C` opens the panel.

## IPC

    omarchy-shell omarchy.clock calendarHealth     # JSON: {ok, loadedAt, ...}
    omarchy-shell omarchy.clock calendarRefresh    # force a poll now
    omarchy-shell omarchy.clock selectDay <YYYY-MM-DD>
    omarchy-shell omarchy.clock toggleUpcoming

The target is `omarchy.clock`, not `unified.clock` — a cloned plugin keeps the
IPC identity of the plugin it was cloned from.

## Surviving Omarchy updates

Three of the plugin's files are copies of Omarchy's clock, so an Omarchy release
that touches that clock leaves this widget behind. `tools/check-omarchy.sh`
watches for exactly that. Installed by `tools/install-hooks.sh` as Omarchy
`post-update` and `post-boot` hooks, it compares the installed clock against
`upstream/SHA256SUMS` and checks that the widget actually loaded:

- unchanged and healthy → silence.
- changed, or the widget failed to load → the widget is switched off, the stock
  clock comes back, the bar anchor is repointed, and **one** notification
  appears. Clicking it opens the agent with `UPDATING.md`.

Nothing is merged or repaired unattended. `tools/check-omarchy.sh --status`
prints where things stand; `--resume` switches the widget back on after you have
updated it.

## Where the widget keeps things

| Path | Holds |
|---|---|
| `~/.cache/unified-calendar-widget/events.json` | the offline cache |
| `~/.local/state/unified-calendar-widget.json` | reminder state — which reminders have fired, and when the last check was |
| `~/.local/state/unified-calendar-widget/` | the update check's log and paused marker |

The offline cache holds every range fetched exactly as the server returned it —
whole event bodies, `notes` (descriptions), `location` and `meetingUrl` included
— and is written unconditionally, with no setting to turn it off. It therefore
lives in a directory of its own created mode `0700`, so no other local user can
read it: Quickshell's `FileView` has no permission property and its atomic write
renames a fresh temp file into place, so the file's own mode cannot be pinned
from QML. Delete the file to clear it; the next poll rewrites it.

A cache left at the pre-0.2 path `~/.cache/unified-calendar-widget.json` is moved
into the new directory on first start.

This is separate from the *server's* cache (`data/widget-cache.json`), which is
off unless `UNIFIED_CALENDAR_WIDGET_CACHE=1` and stores only reduced events.

## Tests

    node --test omarchy-widget/test/*.test.js
    QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input omarchy-widget/test-qml/tst_calendar_model.qml
    QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input omarchy-widget/test-qml/tst_data_model.qml

The `node --test` suite reads Omarchy's installed `Model.js` to check the month
grid matches Omarchy's own, so it needs Omarchy present.

## Uninstall

    omarchy-widget/install.sh --uninstall

Removes the hooks, rolls the bar back to Omarchy's own clock (restoring
`bar.centerAnchor` with it), drops the keybinding it added, and stops and removes
the service. Your calendars and settings in `data/` are kept, as is the widget's
own cache in `~/.cache/unified-calendar-widget/` — delete that yourself if you
want it gone.

## Provenance

See `NOTICE` — parts of this are Omarchy's MIT-licensed code.
