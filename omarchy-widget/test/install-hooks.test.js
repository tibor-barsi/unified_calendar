import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = join(here, '..', 'tools', 'install-hooks.sh');
const CHECK_SH = join(here, '..', 'tools', 'check-omarchy.sh');
const STUBS_DIR = join(here, '..', 'tools', 'test-stubs');
const HOOK_INSTALL = '/usr/share/omarchy/bin/omarchy-hook-install';
const HOOK_RUN = '/usr/share/omarchy/bin/omarchy-hook';
const UPDATE_LOCK = '/usr/share/omarchy/bin/omarchy-update-lock';
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';
const EVENTS = ['post-update', 'post-boot'];
const NAME = 'unified-calendar-widget';
const LOCK_CLOSE = 'exec {OMARCHY_UPDATE_LOCK_FD}>&-';

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'unified-clock-hooks-')));
  if (!process.env.KEEP_TEST_TMP) t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = {
    root,
    home: join(root, 'home'),
    state: join(root, 'state'),
    runtime: join(root, 'runtime'),
    calls: join(root, 'calls.log'),
    hooks: join(root, 'home', '.config', 'omarchy', 'hooks'),
  };
  mkdirSync(s.home, { recursive: true });
  mkdirSync(s.runtime, { recursive: true });
  return s;
}

function writeStubCheck(s, body) {
  const real = join(s.root, 'real-tools');
  mkdirSync(real, { recursive: true });
  symlinkSync(real, join(s.root, 'linked-tools'));
  const file = join(real, 'check-omarchy.sh');
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return { linked: join(s.root, 'linked-tools', 'check-omarchy.sh'), real: realpathSync(file) };
}

function runInstall(s, args = [], overrides = {}) {
  const env = { PATH: SYSTEM_PATH, HOME: s.home, OMARCHY_HOOK_INSTALL: HOOK_INSTALL, ...overrides };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return spawnSync('bash', [INSTALL_SH, ...args], { env, encoding: 'utf8', timeout: 30000 });
}

const wrapperPath = (s, event) => join(s.hooks, `${event}.d`, NAME);
const explain = (r) => `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return true;
}

test('install puts a wrapper for post-update and post-boot in place through omarchy-hook-install', (t) => {
  const s = setup(t);
  const check = writeStubCheck(s, '#!/bin/bash\nexit 0\n');
  mkdirSync(join(s.hooks, 'post-boot.d'), { recursive: true });
  writeFileSync(join(s.hooks, 'post-boot.d', 'my-own-hook'), 'echo mine\n');

  const first = runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: check.linked });
  assert.equal(first.status, 0, explain(first));
  const firstTexts = EVENTS.map((event) => readFileSync(wrapperPath(s, event), 'utf8'));
  const second = runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: check.linked });
  assert.equal(second.status, 0, explain(second));

  EVENTS.forEach((event, i) => {
    const file = wrapperPath(s, event);
    assert.equal(statSync(file).mode & 0o777, 0o755, `${event} mode`);
    const text = readFileSync(file, 'utf8');
    assert.equal(text, firstTexts[i], 'a second install changed the wrapper');
    assert.ok(text.startsWith('#!/bin/bash\n'));
    assert.ok(text.includes('PATH="$HOME/.local/share/mise/shims:$PATH"'));
    assert.ok(text.includes('state="${UNIFIED_WIDGET_STATE_DIR:-$HOME/.local/state/unified-calendar-widget}"'));
    assert.ok(text.includes('mkdir -p "$state"'));
    assert.ok(text.includes(`check=${check.real}\n`), 'the real check path is not baked in');
    assert.ok(!text.includes('linked-tools'));
    assert.ok(text.includes('[[ -x "$check" ]] || exit 0'));
    assert.ok(!text.includes('check-script-missing'), `${event} wrapper still keeps a missing-script marker`);
    assert.ok(!text.includes('omarchy-notification-send'), `${event} wrapper still notifies on its own`);
    assert.ok(text.trimEnd().endsWith('exit 0'));
    assert.equal(text.indexOf('mkdir -p "$state"') < text.indexOf('[[ -x "$check" ]]'), true);
    const close = text.indexOf(LOCK_CLOSE);
    assert.ok(close >= 0, `${event} wrapper does not close the update lock fd`);
    assert.ok(text.includes('unset OMARCHY_UPDATE_LOCK_FD'));
    assert.equal(spawnSync('bash', ['-n', file]).status, 0, `${event} wrapper has a syntax error`);
  });

  const update = readFileSync(wrapperPath(s, 'post-update'), 'utf8');
  assert.ok(
    update.includes('timeout 60 "$check" --trigger post-update >>"$state/check.log" 2>&1'),
    `post-update does not run the check inline under a timeout:\n${update}`,
  );
  assert.ok(!update.includes('setsid'), 'post-update detaches the check');
  assert.ok(update.indexOf(LOCK_CLOSE) < update.indexOf('timeout 60'));

  const boot = readFileSync(wrapperPath(s, 'post-boot'), 'utf8');
  assert.ok(
    boot.includes('setsid -f "$check" --trigger post-boot >>"$state/check.log" 2>&1 </dev/null'),
    `post-boot does not detach the check:\n${boot}`,
  );
  assert.ok(boot.indexOf(LOCK_CLOSE) < boot.indexOf('setsid -f'));

  assert.deepEqual(readdirSync(join(s.hooks, 'post-boot.d')).sort(), ['my-own-hook', NAME]);
  assert.deepEqual(readdirSync(join(s.hooks, 'post-update.d')), [NAME]);
  assert.match(first.stdout, /post-update/);
  assert.match(first.stdout, /post-boot/);
});

test("without an override the wrapper runs this repo's check-omarchy.sh by its real path", (t) => {
  const s = setup(t);

  const r = runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: undefined });

  assert.equal(r.status, 0, explain(r));
  for (const event of EVENTS) {
    assert.ok(readFileSync(wrapperPath(s, event), 'utf8').includes(`check=${realpathSync(CHECK_SH)}\n`));
  }
});

test('install fails and installs nothing when the check script does not exist', (t) => {
  const s = setup(t);

  const r = runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: join(s.root, 'missing', 'check-omarchy.sh') });

  assert.notEqual(r.status, 0, explain(r));
  assert.ok(!existsSync(s.hooks));
});

test('uninstall removes exactly the two wrappers and nothing else', (t) => {
  const s = setup(t);
  const check = writeStubCheck(s, '#!/bin/bash\nexit 0\n');
  assert.equal(runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: check.linked }).status, 0);
  writeFileSync(join(s.hooks, 'post-update.d', 'my-own-hook'), 'echo mine\n');
  writeFileSync(join(s.hooks, 'post-boot.d', `${NAME}.sample`), 'echo sample\n');
  mkdirSync(join(s.hooks, 'pre-update.d'), { recursive: true });
  writeFileSync(join(s.hooks, 'pre-update.d', NAME), 'echo other event\n');

  const r = runInstall(s, ['--uninstall']);

  assert.equal(r.status, 0, explain(r));
  for (const event of EVENTS) assert.ok(!existsSync(wrapperPath(s, event)), `${event} wrapper still there`);
  assert.ok(existsSync(join(s.hooks, 'post-update.d', 'my-own-hook')));
  assert.ok(existsSync(join(s.hooks, 'post-boot.d', `${NAME}.sample`)));
  assert.ok(existsSync(join(s.hooks, 'pre-update.d', NAME)));
  assert.match(r.stdout, /Removed/);

  const again = runInstall(s, ['--uninstall']);

  assert.equal(again.status, 0, explain(again));
  assert.doesNotMatch(again.stdout, /Removed/);
  assert.match(again.stdout, /not installed/);
});

test('the installed post-boot wrapper returns at once while the check keeps running detached', async (t) => {
  const s = setup(t);
  const marker = join(s.root, 'check-finished');
  const argsFile = join(s.root, 'check-args');
  const check = writeStubCheck(s, [
    '#!/bin/bash',
    'printf \'%s\\n\' "$@" > "$STUB_CHECK_ARGS"',
    'sleep 5',
    'touch "$STUB_CHECK_MARKER"',
    '',
  ].join('\n'));
  assert.equal(runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: check.linked }).status, 0);

  const env = {
    PATH: SYSTEM_PATH,
    HOME: s.home,
    UNIFIED_WIDGET_STATE_DIR: s.state,
    STUB_CHECK_ARGS: argsFile,
    STUB_CHECK_MARKER: marker,
  };
  const started = Date.now();
  const r = spawnSync(HOOK_RUN, ['post-boot'], { env, encoding: 'utf8', timeout: 15000 });
  const elapsed = Date.now() - started;

  assert.equal(r.status, 0, explain(r));
  assert.ok(elapsed < 2000, `omarchy-hook post-boot took ${elapsed} ms`);
  assert.doesNotMatch(r.stdout, /Hook failed/);
  assert.ok(!existsSync(marker), 'the check finished before the hook returned');
  assert.ok(await waitFor(() => existsSync(marker), 12000), 'the detached check never finished');
  assert.deepEqual(readFileSync(argsFile, 'utf8').split('\n').filter(Boolean), ['--trigger', 'post-boot']);
  assert.ok(existsSync(join(s.state, 'check.log')));
});

test('the installed post-update wrapper runs the check inline and waits for it', (t) => {
  const s = setup(t);
  const marker = join(s.root, 'check-finished');
  const argsFile = join(s.root, 'check-args');
  const check = writeStubCheck(s, [
    '#!/bin/bash',
    'printf \'%s\\n\' "$@" > "$STUB_CHECK_ARGS"',
    'printf \'the check ran\\n\'',
    'sleep 0.5',
    'touch "$STUB_CHECK_MARKER"',
    'exit 1',
    '',
  ].join('\n'));
  assert.equal(runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: check.linked }).status, 0);

  const env = {
    PATH: SYSTEM_PATH,
    HOME: s.home,
    UNIFIED_WIDGET_STATE_DIR: s.state,
    STUB_CHECK_ARGS: argsFile,
    STUB_CHECK_MARKER: marker,
  };
  const r = spawnSync(HOOK_RUN, ['post-update'], { env, encoding: 'utf8', timeout: 15000 });

  assert.equal(r.status, 0, `a check that exits non-zero must not fail the hook\n${explain(r)}`);
  assert.doesNotMatch(r.stdout, /Hook failed/);
  assert.ok(existsSync(marker), 'the hook returned before the check finished');
  assert.deepEqual(readFileSync(argsFile, 'utf8').split('\n').filter(Boolean), ['--trigger', 'post-update']);
  assert.match(readFileSync(join(s.state, 'check.log'), 'utf8'), /the check ran/);
});

test('the wrapper exits 0 without starting anything when check-omarchy.sh is not executable', async (t) => {
  const s = setup(t);
  const argsFile = join(s.root, 'check-args');
  const check = writeStubCheck(s, '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$STUB_CHECK_ARGS"\n');
  assert.equal(runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: check.linked }).status, 0);
  chmodSync(check.real, 0o644);

  const r = spawnSync('bash', [wrapperPath(s, 'post-update')], {
    env: { PATH: SYSTEM_PATH, HOME: s.home, UNIFIED_WIDGET_STATE_DIR: s.state, STUB_CHECK_ARGS: argsFile },
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(r.status, 0, explain(r));
  await new Promise((resolve) => { setTimeout(resolve, 500); });
  assert.ok(!existsSync(argsFile), 'the check was started although it is not executable');
  assert.ok(!existsSync(join(s.state, 'check.log')));
});

test('a post-update hook run under the real Omarchy update lock hands the check no lock fd and frees the lock when it returns', (t) => {
  const s = setup(t);
  const report = join(s.root, 'check-lock-report');
  const check = writeStubCheck(s, [
    '#!/bin/bash',
    'fds=0',
    'for link in /proc/$$/fd/*; do',
    '  if [[ "$(readlink -- "$link" 2>/dev/null || true)" == */omarchy-update.lock ]]; then fds=$((fds + 1)); fi',
    'done',
    'printf \'fds=%s env=%s\\n\' "$fds" "${OMARCHY_UPDATE_LOCK_FD-<unset>}" > "$STUB_CHECK_REPORT.tmp"',
    'mv "$STUB_CHECK_REPORT.tmp" "$STUB_CHECK_REPORT"',
    '',
  ].join('\n'));
  assert.equal(runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: check.linked }).status, 0);

  const env = {
    PATH: SYSTEM_PATH,
    HOME: s.home,
    XDG_RUNTIME_DIR: s.runtime,
    UNIFIED_WIDGET_STATE_DIR: s.state,
    STUB_CHECK_REPORT: report,
  };
  const started = Date.now();
  const r = spawnSync(UPDATE_LOCK, ['run', HOOK_RUN, 'post-update'], { env, encoding: 'utf8', timeout: 15000 });
  const elapsed = Date.now() - started;

  assert.equal(r.status, 0, explain(r));
  assert.ok(elapsed < 5000, `the post-update hook took ${elapsed} ms`);
  assert.doesNotMatch(r.stdout, /Hook failed/);
  assert.ok(existsSync(join(s.runtime, 'omarchy-update.lock')), 'the real update lock was not used');
  assert.equal(readFileSync(report, 'utf8').trim(), 'fds=0 env=<unset>');

  const retry = spawnSync(UPDATE_LOCK, ['run', 'true'], { env, encoding: 'utf8', timeout: 10000 });

  assert.equal(retry.status, 0, `a later update was refused\n${explain(retry)}`);
  assert.doesNotMatch(retry.stdout, /already running/);
});

test('a wrapper whose check script is gone exits 0 in silence, leaving no notification and no state behind', (t) => {
  const s = setup(t);
  const check = writeStubCheck(s, '#!/bin/bash\nexit 0\n');
  assert.equal(runInstall(s, [], { UNIFIED_WIDGET_CHECK_SCRIPT: check.linked }).status, 0);
  rmSync(check.real);
  const env = { PATH: `${STUBS_DIR}:${SYSTEM_PATH}`, HOME: s.home, UNIFIED_WIDGET_STATE_DIR: s.state, STUB_CALLS_LOG: s.calls };
  const run = (event, overrides = {}) => spawnSync('bash', [wrapperPath(s, event)], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
  });
  const calls = () => readLines(s.calls);

  const first = run('post-boot');

  assert.equal(first.status, 0, explain(first));
  assert.equal(first.stdout, '', `the wrapper printed something\n${first.stdout}`);
  assert.deepEqual(calls(), [], `the wrapper ran a command for a missing check script\n${calls().join('\n')}`);
  assert.deepEqual(
    existsSync(s.state) ? readdirSync(s.state) : [],
    [],
    'the wrapper left a marker file in the state dir',
  );

  const second = run('post-update');

  assert.equal(second.status, 0, explain(second));
  assert.deepEqual(calls(), [], calls().join('\n'));

  const blocker = join(s.root, 'not-a-dir');
  writeFileSync(blocker, '');
  const unusable = { UNIFIED_WIDGET_STATE_DIR: join(blocker, 'state') };
  const missingAndUnusable = run('post-update', unusable);

  assert.equal(missingAndUnusable.status, 0, explain(missingAndUnusable));

  writeFileSync(check.real, '#!/bin/bash\nexit 0\n');
  chmodSync(check.real, 0o755);
  const presentAndUnusable = run('post-boot', unusable);

  assert.equal(presentAndUnusable.status, 0, explain(presentAndUnusable));
});
