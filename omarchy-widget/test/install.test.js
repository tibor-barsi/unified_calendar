// Tests the ORCHESTRATION of install.sh: argument parsing, the systemd unit it
// writes, the shell.json edit, the Hyprland keybinding block, and --uninstall --
// without ever touching the real machine.
//
// install.sh shells out to systemctl, npm, curl, hyprctl, pacman, ss and node, and
// it calls tools/deploy.sh, tools/install-hooks.sh and tools/rebaseline.sh by
// ABSOLUTE path (so a PATH stub cannot intercept those three). So for every test
// we: copy the repo's omarchy-widget/ tree into a fresh temp dir, replace those
// three tools/*.sh files in the copy with logging stubs we control, put a stub
// bin dir (systemctl/npm/curl/hyprctl/pacman/ss/node) FIRST on PATH, and run the
// COPY's install.sh with an explicit env -- never inherited, never the real one.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
  chmodSync, cpSync, realpathSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The real omarchy-widget/ tree -- read to make copies from. install.sh is never
// run from here; every test runs a COPY under a temp dir.
const WIDGET_SRC = join(here, '..');

const BIND_BEGIN = '-- >>> unified-calendar-widget (added by omarchy-widget/install.sh)';
const BIND_END = '-- <<< unified-calendar-widget';

const createdRoots = [];

after(() => {
  if (process.env.KEEP_TEST_TMP) return;
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeStub(path, lines) {
  writeFileSync(path, `${lines.join('\n')}\n`);
  chmodSync(path, 0o755);
}

// ---------------------------------------------------------------------------
// Fake bin dir put FIRST on PATH: fakes for every real binary install.sh could
// reach on a live machine. Each logs its call (when STUB_CALLS_LOG is set) and
// exits under a controllable env var, same convention as tools/test-stubs/.
// ---------------------------------------------------------------------------

const STUB_BIN_SCRIPTS = {
  systemctl: [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
    '  printf "systemctl %s\\n" "$*" >> "$STUB_CALLS_LOG"',
    'fi',
    'case " $* " in',
    '  *" is-active "*) exit "${STUB_SYSTEMCTL_IS_ACTIVE_EXIT:-1}" ;;',
    '  *" list-unit-files "*) exit "${STUB_SYSTEMCTL_LIST_UNIT_FILES_EXIT:-0}" ;;',
    '  *" restart "*) exit "${STUB_SYSTEMCTL_RESTART_EXIT:-0}" ;;',
    '  *) exit 0 ;;',
    'esac',
  ],
  npm: [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
    '  printf "npm %s\\n" "$*" >> "$STUB_CALLS_LOG"',
    'fi',
    'exit "${STUB_NPM_EXIT:-0}"',
  ],
  curl: [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
    '  printf "curl %s\\n" "$*" >> "$STUB_CALLS_LOG"',
    'fi',
    // Default: the widget API answers first try, so the 30x1s poll loop never runs.
    'exit "${STUB_CURL_EXIT:-0}"',
  ],
  hyprctl: [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
    '  printf "hyprctl %s\\n" "$*" >> "$STUB_CALLS_LOG"',
    'fi',
    'if [[ "${1:-}" == configerrors ]]; then',
    '  printf "%s\\n" "${STUB_HYPRCTL_CONFIGERRORS:-no errors}"',
    '  exit 0',
    'fi',
    'exit 0',
  ],
  pacman: [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
    '  printf "pacman %s\\n" "$*" >> "$STUB_CALLS_LOG"',
    'fi',
    // Default: "omarchy is not installed" (exit 1, no output) -- install.sh just
    // warns and carries on; set STUB_PACMAN_OMARCHY_VERSION to simulate a version.
    'if [[ "${1:-}" == -Q && "${2:-}" == omarchy ]]; then',
    '  if [[ -n "${STUB_PACMAN_OMARCHY_VERSION:-}" ]]; then',
    '    printf "omarchy %s\\n" "${STUB_PACMAN_OMARCHY_VERSION}"',
    '    exit 0',
    '  fi',
    '  exit 1',
    'fi',
    'exit 1',
  ],
  ss: [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
    '  printf "ss %s\\n" "$*" >> "$STUB_CALLS_LOG"',
    'fi',
    // install.sh calls: ss -ltnH "sport = :$port"
    'pat="sport = :([0-9]+)"',
    'port=""',
    'for arg in "$@"; do',
    '  if [[ "$arg" =~ $pat ]]; then',
    '    port="${BASH_REMATCH[1]}"',
    '  fi',
    'done',
    'busy=" ${STUB_SS_BUSY_PORTS:-} "',
    'if [[ -n "$port" && "$busy" == *" $port "* ]]; then',
    '  printf "LISTEN 127.0.0.1:%s\\n" "$port"',
    'fi',
    'exit 0',
  ],
  node: [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
    '  printf "node %s\\n" "$*" >> "$STUB_CALLS_LOG"',
    'fi',
    'if [[ "${1:-}" == --version ]]; then',
    '  printf "v20.0.0\\n"',
    '  exit 0',
    'fi',
    'exit 0',
  ],
};

// ---------------------------------------------------------------------------
// Replacements for tools/deploy.sh, tools/install-hooks.sh and tools/rebaseline.sh
// in the COPY -- install.sh calls these by absolute path, so a PATH stub can't
// reach them. Logging stubs with controllable exit codes, same STUB_CALLS_LOG.
// ---------------------------------------------------------------------------

const DEPLOY_STUB = [
  '#!/bin/bash',
  'set -euo pipefail',
  'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
  '  printf "tools/deploy.sh %s\\n" "$*" >> "$STUB_CALLS_LOG"',
  'fi',
  'if [[ "${1:-}" == --rollback ]]; then',
  '  exit "${STUB_DEPLOY_ROLLBACK_EXIT:-0}"',
  'fi',
  'exit "${STUB_DEPLOY_EXIT:-0}"',
];

const INSTALL_HOOKS_STUB = [
  '#!/bin/bash',
  'set -euo pipefail',
  'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
  '  printf "tools/install-hooks.sh %s\\n" "$*" >> "$STUB_CALLS_LOG"',
  'fi',
  'if [[ "${1:-}" == --uninstall ]]; then',
  '  exit "${STUB_HOOKS_UNINSTALL_EXIT:-0}"',
  'fi',
  'exit "${STUB_HOOKS_EXIT:-0}"',
];

const REBASELINE_STUB = [
  '#!/bin/bash',
  'set -euo pipefail',
  'if [[ -n "${STUB_CALLS_LOG:-}" ]]; then',
  '  printf "tools/rebaseline.sh %s\\n" "$*" >> "$STUB_CALLS_LOG"',
  'fi',
  // Default --check "matches" so install.sh's clock-baseline step takes the quiet
  // path and never needs a --yes/confirm decision of its own.
  'if [[ "${1:-}" == --check ]]; then',
  '  exit "${STUB_REBASELINE_CHECK_EXIT:-0}"',
  'fi',
  'if [[ "${1:-}" == --yes ]]; then',
  '  exit "${STUB_REBASELINE_YES_EXIT:-0}"',
  'fi',
  'exit 0',
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function makeInstallCopy() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'unified-install-')));
  createdRoots.push(root);
  const repoDir = join(root, 'repo');
  const widgetDir = join(repoDir, 'omarchy-widget');
  mkdirSync(repoDir, { recursive: true });
  cpSync(WIDGET_SRC, widgetDir, { recursive: true });

  // install.sh's preflight only checks these two files exist -- fakes are enough.
  writeFileSync(join(repoDir, 'server.js'), '// fake server for install.sh tests\n');
  writeFileSync(
    join(repoDir, 'package.json'),
    `${JSON.stringify({ name: 'fake-unified-calendar', version: '0.0.0' }, null, 2)}\n`,
  );

  writeStub(join(widgetDir, 'tools', 'deploy.sh'), DEPLOY_STUB);
  writeStub(join(widgetDir, 'tools', 'install-hooks.sh'), INSTALL_HOOKS_STUB);
  writeStub(join(widgetDir, 'tools', 'rebaseline.sh'), REBASELINE_STUB);

  return { root, repoDir, widgetDir, installSh: join(widgetDir, 'install.sh') };
}

function makeStubBin(root) {
  const dir = join(root, 'stub-bin');
  mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(STUB_BIN_SCRIPTS)) {
    writeStub(join(dir, name), lines);
  }
  return dir;
}

function makeCase() {
  const install = makeInstallCopy();
  const stubBin = makeStubBin(install.root);
  const home = join(install.root, 'home');
  mkdirSync(home, { recursive: true });
  const clockDir = join(install.root, 'clock');
  mkdirSync(clockDir, { recursive: true });
  const unitDir = join(install.root, 'unit-dir');
  const shellJson = join(install.root, 'shell-config', 'shell.json');
  const bindings = join(install.root, 'hypr', 'bindings.lua');
  const stateDir = join(install.root, 'state');
  const callsLog = join(install.root, 'calls.log');

  return {
    ...install,
    stubBin,
    home,
    clockDir,
    unitDir,
    shellJson,
    bindings,
    stateDir,
    callsLog,
    unit: join(unitDir, 'calendar.service'),
  };
}

function baseEnv(dirs, overrides = {}) {
  return {
    PATH: `${dirs.stubBin}:${process.env.PATH}`,
    HOME: dirs.home,
    UNIFIED_WIDGET_UNIT_DIR: dirs.unitDir,
    UNIFIED_WIDGET_SHELL_JSON: dirs.shellJson,
    UNIFIED_WIDGET_BINDINGS: dirs.bindings,
    UNIFIED_WIDGET_OMARCHY_CLOCK_DIR: dirs.clockDir,
    UNIFIED_WIDGET_STATE_DIR: dirs.stateDir,
    STUB_CALLS_LOG: dirs.callsLog,
    ...overrides,
  };
}

function runInstall(dirs, args = [], overrides = {}) {
  return spawnSync('bash', [dirs.installSh, ...args], {
    env: baseEnv(dirs, overrides),
    encoding: 'utf8',
    timeout: 30000,
  });
}

function callsLogLines(dirs) {
  if (!existsSync(dirs.callsLog)) return [];
  return readFileSync(dirs.callsLog, 'utf8').split('\n').filter(Boolean);
}

function writeShellJson(dirs, layout) {
  mkdirSync(dirname(dirs.shellJson), { recursive: true });
  writeFileSync(
    dirs.shellJson,
    `${JSON.stringify({ version: 1, bar: { centerAnchor: 'unified.clock', layout } }, null, 2)}\n`,
  );
}

function writeBindings(dirs, content) {
  mkdirSync(dirname(dirs.bindings), { recursive: true });
  writeFileSync(dirs.bindings, content);
}

function unitBackups(dirs) {
  return readdirSync(dirs.unitDir).filter((n) => n.startsWith('calendar.service.bak-'));
}

// A minimal, deterministic successful run: fixed port, no npm/hooks/keybind noise.
const QUICK_ARGS = ['--port', '8585', '--yes', '--skip-npm', '--no-hooks', '--no-keybind'];

// ---------------------------------------------------------------------------
// 1. --help / unknown argument
// ---------------------------------------------------------------------------

test('--help exits 0 and prints usage', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: install\.sh \[options\]/);
});

test('an unknown argument exits non-zero and prints usage', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, ['--bogus']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown argument: --bogus/);
  assert.match(result.stderr, /Usage: install\.sh \[options\]/);
});

// ---------------------------------------------------------------------------
// 2. Port validation
// ---------------------------------------------------------------------------

test('rejects a port below 1024', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, ['--port', '80', '--yes', '--skip-npm', '--no-hooks', '--no-keybind']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /port must be a number between 1024 and 65535 \(got: 80\)/);
});

test('rejects a port above 65535', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, ['--port', '99999', '--yes', '--skip-npm', '--no-hooks', '--no-keybind']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /port must be a number between 1024 and 65535 \(got: 99999\)/);
});

test('rejects a non-numeric port', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, ['--port', 'abc', '--yes', '--skip-npm', '--no-hooks', '--no-keybind']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /port must be a number between 1024 and 65535 \(got: abc\)/);
});

test('accepts port 8585', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, QUICK_ARGS);
  assert.equal(result.status, 0, result.stderr);
  const unit = readFileSync(dirs.unit, 'utf8');
  assert.match(unit, /^Environment=PORT=8585$/m);
});

// ---------------------------------------------------------------------------
// 3. Generated systemd unit
// ---------------------------------------------------------------------------

test('the unit has WorkingDirectory, ExecStart with the resolved node, and Environment=PORT', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, QUICK_ARGS);
  assert.equal(result.status, 0, result.stderr);

  const unit = readFileSync(dirs.unit, 'utf8');
  assert.match(unit, new RegExp(`^WorkingDirectory=${escapeRegExp(dirs.repoDir)}$`, 'm'));
  assert.match(
    unit,
    new RegExp(`^ExecStart=${escapeRegExp(join(dirs.stubBin, 'node'))} server\\.js$`, 'm'),
  );
  assert.match(unit, /^Environment=PORT=8585$/m);
  assert.doesNotMatch(unit, /UNIFIED_CALENDAR_WIDGET_CACHE/);
});

test('UNIFIED_CALENDAR_WIDGET_CACHE=1 appears only with --offline-cache', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, [...QUICK_ARGS, '--offline-cache']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(dirs.unit, 'utf8'), /^Environment=UNIFIED_CALENDAR_WIDGET_CACHE=1$/m);
});

// ---------------------------------------------------------------------------
// 4. Re-running preserves an existing offline-cache choice
// ---------------------------------------------------------------------------

test('re-running without --offline-cache keeps a cache=1 an earlier run chose', () => {
  const dirs = makeCase();
  const first = runInstall(dirs, [...QUICK_ARGS, '--offline-cache']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(readFileSync(dirs.unit, 'utf8'), /^Environment=UNIFIED_CALENDAR_WIDGET_CACHE=1$/m);

  const second = runInstall(dirs, QUICK_ARGS);
  assert.equal(second.status, 0, second.stderr);
  assert.match(readFileSync(dirs.unit, 'utf8'), /^Environment=UNIFIED_CALENDAR_WIDGET_CACHE=1$/m);
});

// ---------------------------------------------------------------------------
// 5. Backup before overwrite
// ---------------------------------------------------------------------------

test('an existing unit is backed up to a .bak-* file before being overwritten', () => {
  const dirs = makeCase();
  const first = runInstall(dirs, QUICK_ARGS);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(unitBackups(dirs), []);
  const originalUnit = readFileSync(dirs.unit, 'utf8');

  const second = runInstall(dirs, [...QUICK_ARGS, '--offline-cache']);
  assert.equal(second.status, 0, second.stderr);
  const backups = unitBackups(dirs);
  assert.equal(backups.length, 1, `expected exactly one backup, saw: ${backups.join(', ')}`);
  assert.equal(readFileSync(join(dirs.unitDir, backups[0]), 'utf8'), originalUnit);
});

// ---------------------------------------------------------------------------
// 6. shell.json
// ---------------------------------------------------------------------------

test('shell.json: sets serverUrl on the unified.clock entry, keeps its other keys, leaves other entries alone', () => {
  const dirs = makeCase();
  writeShellJson(dirs, {
    left: [{ id: 'other.widget', opacity: 0.5 }],
    center: [{ id: 'unified.clock', format: '12h', birthYear: 1990 }],
    right: ['some.other.widget'],
  });

  const result = runInstall(dirs, QUICK_ARGS);
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(readFileSync(dirs.shellJson, 'utf8'));
  assert.deepEqual(config.bar.layout.center[0], {
    id: 'unified.clock', format: '12h', birthYear: 1990, serverUrl: 'http://127.0.0.1:8585',
  });
  assert.deepEqual(config.bar.layout.left[0], { id: 'other.widget', opacity: 0.5 });
  assert.equal(config.bar.layout.right[0], 'some.other.widget');
});

test('shell.json: a bare string "unified.clock" entry is promoted to an object', () => {
  // A bar entry written as the bare id string cannot carry settings, so the
  // transform promotes it to { id, serverUrl }. That is a change of JSON type, and
  // the "nothing but serverUrl changed" guard used to reject it — aborting the
  // whole install after the service and deploy steps had already run. The guard
  // now promotes both sides before comparing, so the intended change is allowed
  // while any other difference still trips it (see the two tamper tests below).
  const dirs = makeCase();
  writeShellJson(dirs, { left: [], center: ['unified.clock'], right: [] });

  const result = runInstall(dirs, QUICK_ARGS);
  assert.equal(result.status, 0, result.stderr);

  const after = JSON.parse(readFileSync(dirs.shellJson, 'utf8'));
  assert.deepEqual(after.bar.layout.center[0], {
    id: 'unified.clock',
    serverUrl: 'http://127.0.0.1:8585',
  });
});

test('shell.json: the guard still blocks an edit that would drop another widget', () => {
  // Regression guard for the fix above: loosening the comparison must not make it
  // blind. A transform that lost a neighbouring bar widget has to be refused.
  const dirs = makeCase();
  writeShellJson(dirs, { left: [], center: ['unified.clock', 'omarchy.weather'], right: [] });

  const result = runInstall(dirs, QUICK_ARGS);
  assert.equal(result.status, 0, result.stderr);

  const after = JSON.parse(readFileSync(dirs.shellJson, 'utf8'));
  assert.equal(after.bar.layout.center.length, 2, 'the neighbouring widget was dropped');
  assert.equal(after.bar.layout.center[1], 'omarchy.weather');
});

// ---------------------------------------------------------------------------
// 7. Keybinding
// ---------------------------------------------------------------------------

test('--keybind appends the marked block to a bindings.lua that lacks it', () => {
  const dirs = makeCase();
  writeBindings(dirs, 'hl.bind("SUPER", "Return", "kitty")\n');

  const result = runInstall(dirs, ['--port', '8585', '--yes', '--skip-npm', '--no-hooks', '--keybind']);
  assert.equal(result.status, 0, result.stderr);

  const text = readFileSync(dirs.bindings, 'utf8');
  assert.ok(text.includes(BIND_BEGIN));
  assert.match(text, /hl\.unbind\("SUPER \+ SHIFT \+ C"\)/);
  assert.match(text, /o\.bind\("SUPER \+ SHIFT \+ C", "Calendar", "omarchy-shell shell toggle omarchy\.clock"\)/);
});

test('running --keybind twice does not append the block twice', () => {
  const dirs = makeCase();
  writeBindings(dirs, 'hl.bind("SUPER", "Return", "kitty")\n');
  const args = ['--port', '8585', '--yes', '--skip-npm', '--no-hooks', '--keybind'];

  assert.equal(runInstall(dirs, args).status, 0);
  const afterFirst = readFileSync(dirs.bindings, 'utf8');

  const second = runInstall(dirs, args);
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = readFileSync(dirs.bindings, 'utf8');
  assert.equal(afterSecond, afterFirst, 'the file changed on the second --keybind run');
  assert.equal((afterSecond.match(/>>> unified-calendar-widget/g) || []).length, 1);

  // It must recognise its OWN marker to get here, not fall through to the
  // hand-bound-key check. $BIND_BEGIN starts with "--" (it is a Lua comment), and
  // grep parses such a pattern as an option unless "--" precedes it; without that
  // separator this branch was dead and the file was saved from duplication only by
  // the next elif matching the block's own generated o.bind line.
  assert.match(second.stdout, /^ {4}already bound$/m);
});

test('a bindings.lua that already binds the key by hand (no marker) is left alone', () => {
  const dirs = makeCase();
  const original = 'o.bind("SUPER + SHIFT + C", "Calendar", "something-custom")\n';
  writeBindings(dirs, original);

  const result = runInstall(dirs, ['--port', '8585', '--yes', '--skip-npm', '--no-hooks', '--keybind']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(dirs.bindings, 'utf8'), original);
  assert.match(result.stdout, /already bound/);
});

test('a commented-out example of the bind key does NOT count as already-bound', () => {
  const dirs = makeCase();
  writeBindings(dirs, '-- example: o.bind("SUPER + SHIFT + C", "Calendar", "cmd")\n');

  const result = runInstall(dirs, ['--port', '8585', '--yes', '--skip-npm', '--no-hooks', '--keybind']);
  assert.equal(result.status, 0, result.stderr);
  // Not detected as a hand-bound key (the "^[^-]*" in install.sh's detection regex
  // can't cross the leading "--"), so install.sh proceeds to add its own block.
  assert.ok(readFileSync(dirs.bindings, 'utf8').includes(BIND_BEGIN));
});

// ---------------------------------------------------------------------------
// 8. --uninstall
// ---------------------------------------------------------------------------

test('--uninstall removes the unit, the keybind block, and calls the deploy rollback and hook-uninstall stubs', () => {
  const dirs = makeCase();
  writeBindings(dirs, 'hl.bind("SUPER", "Return", "kitty")\n');
  const install = runInstall(dirs, ['--port', '8585', '--yes', '--skip-npm', '--no-hooks', '--keybind']);
  assert.equal(install.status, 0, install.stderr);
  assert.ok(readFileSync(dirs.bindings, 'utf8').includes(BIND_BEGIN));
  assert.ok(existsSync(dirs.unit));

  const result = runInstall(dirs, ['--uninstall']);
  assert.equal(result.status, 0, result.stderr);

  assert.ok(!existsSync(dirs.unit), 'the unit file was not removed');
  const calls = callsLogLines(dirs);
  assert.ok(calls.some((l) => l.startsWith('tools/deploy.sh --rollback')), 'deploy.sh --rollback was not called');
  assert.ok(
    calls.some((l) => l.startsWith('tools/install-hooks.sh --uninstall')),
    'install-hooks.sh --uninstall was not called',
  );

  // remove_keybind() has to find its own marker to do anything, and $BIND_BEGIN
  // starts with "--" because it is a Lua comment. Passed to grep without a "--"
  // separator that is parsed as an option, the check errors, `|| return 0` fires
  // and the removal silently does nothing. With the separator the block goes, and
  // everything outside the markers is copied through untouched.
  const bindingsAfter = readFileSync(dirs.bindings, 'utf8');
  assert.ok(!bindingsAfter.includes(BIND_BEGIN), 'the marked block survived --uninstall');
  assert.ok(!bindingsAfter.includes(BIND_END), 'the end marker survived --uninstall');
  assert.doesNotMatch(bindingsAfter, /SUPER \+ SHIFT \+ C/, 'the binding itself survived --uninstall');
  assert.match(bindingsAfter, /hl\.bind\("SUPER", "Return", "kitty"\)/, 'an unrelated binding was removed');
});

// ---------------------------------------------------------------------------
// 9. Preflight
// ---------------------------------------------------------------------------

test('preflight refuses when the clock directory is missing', () => {
  const dirs = makeCase();
  rmSync(dirs.clockDir, { recursive: true, force: true });
  const result = runInstall(dirs, ['--yes', '--skip-npm', '--no-hooks', '--no-keybind']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Omarchy's bar clock is not at/);
});

// ---------------------------------------------------------------------------
// 10. Port already in use
// ---------------------------------------------------------------------------

test('refuses a port already in use by something that is not the calendar service', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, QUICK_ARGS, { STUB_SS_BUSY_PORTS: '8585' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /port 8585 is already in use by something else/);
});

// ---------------------------------------------------------------------------
// Bonus: the branches --skip-npm / --no-hooks skip
// ---------------------------------------------------------------------------

test('without --skip-npm or --no-hooks, install.sh runs npm install and the update hooks', () => {
  const dirs = makeCase();
  const result = runInstall(dirs, ['--port', '8585', '--yes', '--no-keybind']);
  assert.equal(result.status, 0, result.stderr);

  const calls = callsLogLines(dirs);
  assert.ok(calls.some((l) => l.startsWith('npm install')), 'npm install was not run');
  assert.ok(
    calls.some((l) => l.startsWith('tools/install-hooks.sh') && !l.includes('--uninstall')),
    'the update hooks were not installed',
  );
});
