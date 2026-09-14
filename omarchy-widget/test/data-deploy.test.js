import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync,
  readdirSync, statSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SH = join(here, '..', 'tools', 'deploy.sh');
const STUBS_DIR = join(here, '..', 'tools', 'test-stubs');
const PLUGIN_ID = 'unified.clock';
const createdRoots = [];

after(() => {
  if (process.env.KEEP_TEST_TMP) return;
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

function makeFakeSrc(dir, marker) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Calendar Clock',
    version: '0.1.0',
    kinds: ['bar-widget'],
    entryPoints: { barWidget: 'BarWidget.qml' },
  }, null, 2));
  writeFileSync(join(dir, 'BarWidget.qml'), `// marker:${marker}\nItem {}\n`);
}

function marker(dir) {
  const text = readFileSync(join(dir, 'BarWidget.qml'), 'utf8');
  const m = /marker:(\S+)/.exec(text);
  return m ? m[1] : null;
}

function makeClock(dirs) {
  mkdirSync(dirs.clock, { recursive: true });
  mkdirSync(dirs.upstream, { recursive: true });
  const files = {
    'BarWidget.qml': 'Item { id: bar }\n',
    'Panel.qml': 'Item { id: panel }\n',
    'Model.js': 'function model() {}\n',
    'manifest.json': '{"schemaVersion":1,"id":"omarchy.clock"}\n',
  };
  const lines = [];
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dirs.clock, name), body);
    lines.push(`${createHash('sha256').update(body).digest('hex')}  ${name}`);
  }
  writeFileSync(join(dirs.upstream, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function writeShellJson(dirs, anchor) {
  mkdirSync(dirname(dirs.shellJson), { recursive: true });
  const config = {
    version: 1,
    bar: {
      centerAnchor: anchor,
      layout: { left: [], center: [{ id: PLUGIN_ID }], right: [] },
    },
  };
  writeFileSync(dirs.shellJson, `${JSON.stringify(config, null, 2)}\n`);
}

const anchorOf = (dirs) => JSON.parse(readFileSync(dirs.shellJson, 'utf8')).bar.centerAnchor;

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'unified-clock-deploy-'));
  createdRoots.push(root);
  const home = join(root, 'home');
  const plugins = join(home, '.config', 'omarchy', 'plugins');
  mkdirSync(plugins, { recursive: true });
  const dirs = {
    root,
    home,
    plugins,
    clock: join(root, 'clock'),
    upstream: join(root, 'upstream'),
    shellJson: join(home, '.config', 'omarchy', 'shell.json'),
    pluginState: join(root, 'plugin-state'),
    cur: join(plugins, PLUGIN_ID),
    prev: join(plugins, `.${PLUGIN_ID}.prev`),
    failed: join(plugins, `.${PLUGIN_ID}.failed`),
    src: join(root, 'src'),
    shellConfig: join(root, 'shell-config'),
    callsLog: join(root, 'calls.log'),
    healthCounter: join(root, 'health-counter'),
    listCounter: join(root, 'list-counter'),
    restartMarker: join(root, 'restarted'),
    restartCounter: join(root, 'restart-counter'),
    lockedCounter: join(root, 'locked-counter'),
  };
  makeClock(dirs);
  writeShellJson(dirs, PLUGIN_ID);
  return dirs;
}

function resetPerRunState(dirs) {
  rmSync(dirs.callsLog, { force: true });
  rmSync(dirs.healthCounter, { force: true });
  rmSync(dirs.listCounter, { force: true });
  rmSync(dirs.restartMarker, { force: true });
  rmSync(dirs.restartCounter, { force: true });
  rmSync(dirs.lockedCounter, { force: true });
}

function callsLogLines(dirs) {
  if (!existsSync(dirs.callsLog)) return [];
  return readFileSync(dirs.callsLog, 'utf8').split('\n').filter(Boolean);
}

function callIndex(calls, prefix) {
  return calls.findIndex((l) => l.startsWith(prefix));
}

function baseEnv(dirs, overrides = {}) {
  return {
    PATH: `${STUBS_DIR}:${process.env.PATH}`,
    HOME: dirs.home,
    UNIFIED_WIDGET_PLUGINS_DIR: dirs.plugins,
    UNIFIED_WIDGET_SRC: dirs.src,
    UNIFIED_WIDGET_OMARCHY_CLOCK_DIR: dirs.clock,
    UNIFIED_WIDGET_UPSTREAM_DIR: dirs.upstream,
    QMLLINT: join(STUBS_DIR, 'qmllint'),
    OMARCHY_SHELL_CONFIG: dirs.shellConfig,
    UNIFIED_WIDGET_HEALTH_TIMEOUT: '1',
    STUB_CALLS_LOG: dirs.callsLog,
    STUB_HEALTH_COUNTER_FILE: dirs.healthCounter,
    STUB_LISTPLUGINS_COUNTER_FILE: dirs.listCounter,
    STUB_RESTART_MARKER: dirs.restartMarker,
    STUB_RESTART_COUNTER_FILE: dirs.restartCounter,
    STUB_LOCKED_COUNTER_FILE: dirs.lockedCounter,
    ...overrides,
  };
}

function runDeploy(dirs, args = [], overrides = {}) {
  resetPerRunState(dirs);
  const env = baseEnv(dirs, overrides);
  return spawnSync('bash', [DEPLOY_SH, ...args], { env, encoding: 'utf8' });
}

function stageOrSwapEntries(dirs) {
  if (!existsSync(dirs.plugins)) return [];
  return readdirSync(dirs.plugins).filter(
    (name) => name.startsWith(`.${PLUGIN_ID}.stage.`) || name.startsWith(`.${PLUGIN_ID}.swap.`)
      || name.startsWith(`.${PLUGIN_ID}.oldprev.`),
  );
}

test('first deploy copies the plugin and enables it', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_LISTPLUGINS_JSON: '[]' });

  assert.equal(result.status, 0);
  assert.ok(existsSync(dirs.cur));
  assert.equal(marker(dirs.cur), 'v1');
  assert.ok(!existsSync(dirs.prev));
  assert.deepEqual(stageOrSwapEntries(dirs), []);

  const calls = callsLogLines(dirs);
  assert.ok(calls.some((l) => l.startsWith('omarchy-plugin-validate')));
  assert.ok(calls.some((l) => l.startsWith('qmllint')));
  assert.ok(calls.some((l) => l.startsWith('omarchy-restart-shell')));
  assert.ok(calls.some((l) => l.startsWith('omarchy-shell shell listPlugins')));
  assert.ok(calls.some((l) => l.startsWith(`omarchy-plugin-enable ${PLUGIN_ID}`)));
  assert.ok(calls.some((l) => l.startsWith('omarchy-shell omarchy.clock calendarHealth')));
});

test('redeploy keeps the previous version and does not re-enable an already-enabled plugin', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  const first = runDeploy(dirs, [], { STUB_LISTPLUGINS_JSON: '[]' });
  assert.equal(first.status, 0);

  makeFakeSrc(dirs.src, 'v2');
  const listedEnabled = JSON.stringify([{ id: PLUGIN_ID, enabled: true }]);
  const second = runDeploy(dirs, [], { STUB_LISTPLUGINS_JSON: listedEnabled });

  assert.equal(second.status, 0);
  assert.equal(marker(dirs.cur), 'v2');
  assert.ok(existsSync(dirs.prev));
  assert.equal(marker(dirs.prev), 'v1');
  assert.deepEqual(stageOrSwapEntries(dirs), []);

  const calls = callsLogLines(dirs);
  assert.ok(!calls.some((l) => l.startsWith('omarchy-plugin-enable')));
  assert.ok(calls.some((l) => l.startsWith('omarchy-restart-shell')));
});

test('the shell is restarted before the widget health is checked', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, []);

  assert.equal(result.status, 0);
  const calls = callsLogLines(dirs);
  const restart = callIndex(calls, 'omarchy-restart-shell');
  const health = callIndex(calls, 'omarchy-shell omarchy.clock calendarHealth');
  assert.ok(restart >= 0, 'omarchy-restart-shell was not called');
  assert.ok(health > restart, 'health was checked before the shell restarted');
});

test('a failed restart after which the shell never answers takes the failure path without polling health', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_RESTART_EXIT: '1', STUB_PING_EXIT: '1' });

  assert.equal(result.status, 1);
  const calls = callsLogLines(dirs);
  assert.ok(!calls.some((l) => l.startsWith('omarchy-shell omarchy.clock calendarHealth')));
  assert.ok(calls.some((l) => l.startsWith(`omarchy-plugin-disable ${PLUGIN_ID}`)));
  assert.match(result.stderr, /could not be restarted/);
});

test('enabling waits until the restarted shell lists the plugin', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], {
    STUB_LISTPLUGINS_UNKNOWN_CALLS: '1',
    STUB_LISTPLUGINS_JSON: JSON.stringify([{ id: PLUGIN_ID, enabled: false }]),
    UNIFIED_WIDGET_HEALTH_TIMEOUT: '2',
  });

  assert.equal(result.status, 0);
  const calls = callsLogLines(dirs);
  const enable = callIndex(calls, `omarchy-plugin-enable ${PLUGIN_ID}`);
  assert.ok(enable >= 0, 'the plugin was never enabled');
  const listsBeforeEnable = calls.slice(0, enable)
    .filter((l) => l.startsWith('omarchy-shell shell listPlugins'));
  assert.ok(listsBeforeEnable.length >= 2,
    `expected the plugin list to be polled until the plugin is known, saw ${listsBeforeEnable.length} call(s)`);
});

test('plugin validation failure exits 2 and touches nothing', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_VALIDATE_EXIT: '1' });

  assert.equal(result.status, 2);
  assert.ok(!existsSync(dirs.cur));
  assert.equal(readdirSync(dirs.plugins).length, 0);

  const calls = callsLogLines(dirs);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('omarchy-plugin-validate'));
});

test('a qmllint syntax error (exit 255) exits 3 and touches nothing', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_QMLLINT_EXIT: '255' });

  assert.equal(result.status, 3);
  assert.ok(!existsSync(dirs.cur));
  assert.equal(readdirSync(dirs.plugins).length, 0);

  const calls = callsLogLines(dirs);
  assert.ok(calls.some((l) => l.startsWith('omarchy-plugin-validate')));
  assert.ok(calls.some((l) => l.startsWith('qmllint')));
  assert.ok(!calls.some((l) => l.startsWith('omarchy-shell')));
});

test('a non-255 qmllint exit code (warnings) does not block the deploy', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_QMLLINT_EXIT: '1' });

  assert.equal(result.status, 0);
  assert.ok(existsSync(dirs.cur));
});

test('health check failure restores the previous version', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  const first = runDeploy(dirs, []);
  assert.equal(first.status, 0);

  makeFakeSrc(dirs.src, 'v2');
  const second = runDeploy(dirs, [], { STUB_HEALTH_OK_AFTER: '1' });

  assert.equal(second.status, 1);
  assert.ok(existsSync(dirs.cur));
  assert.equal(marker(dirs.cur), 'v1');
  assert.ok(!existsSync(dirs.prev));
  assert.ok(existsSync(dirs.failed));
  assert.equal(marker(dirs.failed), 'v2');
  assert.deepEqual(stageOrSwapEntries(dirs), []);

  const calls = callsLogLines(dirs);
  assert.ok(!calls.some((l) => l.startsWith('omarchy-plugin-disable')));
  assert.ok(!calls.some((l) => l.startsWith('omarchy-notification-send')));
});

test('health check failure with no previous version disables the plugin and notifies', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_HEALTH_OK_AFTER: '999999' });

  assert.equal(result.status, 1);
  assert.ok(existsSync(dirs.cur));
  assert.ok(!existsSync(dirs.prev));
  assert.ok(!existsSync(dirs.failed));

  const calls = callsLogLines(dirs);
  assert.ok(calls.some((l) => l.startsWith(`omarchy-plugin-disable ${PLUGIN_ID}`)));
  const notify = calls.find((l) => l.startsWith('omarchy-notification-send'));
  assert.ok(notify);
  assert.ok(notify.includes('-u critical'));
  assert.ok(notify.includes('Calendar widget disabled'));
});

test('a healthy answer from the copy loaded before the swap is not accepted', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_HEALTH_STALE_CALLS: '999999' });

  assert.equal(result.status, 1);
  const calls = callsLogLines(dirs);
  assert.ok(calls.some((l) => l.startsWith(`omarchy-plugin-disable ${PLUGIN_ID}`)));
});

test('health polling continues until the freshly loaded copy answers', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], {
    STUB_HEALTH_STALE_CALLS: '1',
    UNIFIED_WIDGET_HEALTH_TIMEOUT: '2',
  });

  assert.equal(result.status, 0);
  const healthCalls = callsLogLines(dirs)
    .filter((l) => l.startsWith('omarchy-shell omarchy.clock calendarHealth'));
  assert.equal(healthCalls.length, 2);
});

test('--rollback does not accept a healthy answer from the copy loaded before the swap', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v2');
  assert.equal(runDeploy(dirs, []).status, 0);

  const result = runDeploy(dirs, ['--rollback'], { STUB_HEALTH_STALE_CALLS: '999999' });

  assert.equal(result.status, 1);
});

test('a matching shell-log failure line triggers the same failure path as a health failure', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const beforeFile = join(dirs.root, 'log-before.txt');
  const afterFile = join(dirs.root, 'log-after.txt');
  writeFileSync(beforeFile, 'DEBUG qml: startup\nWARN qt.qpa: unrelated\n');
  writeFileSync(afterFile,
    'DEBUG qml: startup\nWARN qt.qpa: unrelated\n'
    + `WARN qml: Plugin widget ${PLUGIN_ID} failed: BarWidget.qml:3: TypeError\n`);

  const result = runDeploy(dirs, [], {
    STUB_QS_LOG_BEFORE: beforeFile,
    STUB_QS_LOG_AFTER: afterFile,
  });

  assert.equal(result.status, 1);
  const calls = callsLogLines(dirs);
  assert.ok(calls.some((l) => l.startsWith(`omarchy-plugin-disable ${PLUGIN_ID}`)));
  assert.ok(calls.some((l) => l.startsWith('omarchy-notification-send')));
});

test('the whole log of the restarted shell is checked, even when it is shorter than the old one', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const beforeFile = join(dirs.root, 'log-before.txt');
  const afterFile = join(dirs.root, 'log-after.txt');
  writeFileSync(beforeFile, 'DEBUG qml: one\nDEBUG qml: two\nDEBUG qml: three\nDEBUG qml: four\n');
  writeFileSync(afterFile, `WARN qml: Plugin widget ${PLUGIN_ID} failed: BarWidget.qml:3: TypeError\n`);

  const result = runDeploy(dirs, [], {
    STUB_QS_LOG_BEFORE: beforeFile,
    STUB_QS_LOG_AFTER: afterFile,
  });

  assert.equal(result.status, 1);
});

test('the "threw:" log pattern only fires when both substrings share a line', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const beforeFile = join(dirs.root, 'log-before.txt');
  const afterFile = join(dirs.root, 'log-after.txt');
  writeFileSync(beforeFile, 'DEBUG qml: startup\n');
  // The two substrings appear in the new lines but never on the same line --
  // must NOT be treated as a match.
  writeFileSync(afterFile,
    'DEBUG qml: startup\n'
    + 'WARN qml: plugin unified.clock summon() ok\n'
    + 'WARN qml: something else entirely) threw: elsewhere\n');

  const result = runDeploy(dirs, [], {
    STUB_QS_LOG_BEFORE: beforeFile,
    STUB_QS_LOG_AFTER: afterFile,
  });

  assert.equal(result.status, 0);
});

test('the "threw:" log pattern fires when both substrings are on the same new line', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const beforeFile = join(dirs.root, 'log-before.txt');
  const afterFile = join(dirs.root, 'log-after.txt');
  writeFileSync(beforeFile, 'DEBUG qml: startup\n');
  writeFileSync(afterFile,
    'DEBUG qml: startup\n'
    + `WARN qml: plugin ${PLUGIN_ID} open() threw: TypeError\n`);

  const result = runDeploy(dirs, [], {
    STUB_QS_LOG_BEFORE: beforeFile,
    STUB_QS_LOG_AFTER: afterFile,
  });

  assert.equal(result.status, 1);
});

test('the "plugins/<id>/ ... Error" log pattern only fires when both substrings share a line', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const beforeFile = join(dirs.root, 'log-before.txt');
  const afterFile = join(dirs.root, 'log-after.txt');
  writeFileSync(beforeFile, 'DEBUG qml: startup\n');
  // The two substrings appear in the new lines but never on the same line --
  // must NOT be treated as a match.
  writeFileSync(afterFile,
    'DEBUG qml: startup\n'
    + `WARN qml: loading plugins/${PLUGIN_ID}/BarWidget.qml\n`
    + 'WARN qml: unrelated Error elsewhere\n');

  const result = runDeploy(dirs, [], {
    STUB_QS_LOG_BEFORE: beforeFile,
    STUB_QS_LOG_AFTER: afterFile,
  });

  assert.equal(result.status, 0);
});

test('the "plugins/<id>/ ... Error" log pattern fires when both substrings are on the same new line', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const beforeFile = join(dirs.root, 'log-before.txt');
  const afterFile = join(dirs.root, 'log-after.txt');
  writeFileSync(beforeFile, 'DEBUG qml: startup\n');
  writeFileSync(afterFile,
    'DEBUG qml: startup\n'
    + `WARN qml: plugins/${PLUGIN_ID}/BarWidget.qml:12: Error: TypeError\n`);

  const result = runDeploy(dirs, [], {
    STUB_QS_LOG_BEFORE: beforeFile,
    STUB_QS_LOG_AFTER: afterFile,
  });

  assert.equal(result.status, 1);
});

test('--rollback swaps the current and previous versions', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v2');
  assert.equal(runDeploy(dirs, []).status, 0);
  assert.equal(marker(dirs.cur), 'v2');
  assert.equal(marker(dirs.prev), 'v1');

  const result = runDeploy(dirs, ['--rollback']);

  assert.equal(result.status, 0);
  assert.equal(marker(dirs.cur), 'v1');
  assert.equal(marker(dirs.prev), 'v2');
  assert.deepEqual(stageOrSwapEntries(dirs), []);

  const calls = callsLogLines(dirs);
  assert.ok(!calls.some((l) => l.startsWith('omarchy-plugin-validate')));
  assert.ok(!calls.some((l) => l.startsWith('qmllint')));
  assert.ok(calls.some((l) => l.startsWith('omarchy-restart-shell')));
  assert.ok(calls.some((l) => l.startsWith('omarchy-shell omarchy.clock calendarHealth')));
});

test('--rollback with no previous version fails without touching anything', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);

  const result = runDeploy(dirs, ['--rollback']);

  assert.equal(result.status, 1);
  assert.equal(callsLogLines(dirs).length, 0);
  assert.equal(marker(dirs.cur), 'v1');
});

test('--no-enable skips enabling the plugin', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, ['--no-enable'], { STUB_LISTPLUGINS_JSON: '[]' });

  assert.equal(result.status, 0);
  const calls = callsLogLines(dirs);
  assert.ok(!calls.some((l) => l.startsWith('omarchy-plugin-enable')));
});

test('no stage or swap directories are left behind across success and failure paths', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  runDeploy(dirs, []);
  makeFakeSrc(dirs.src, 'v2');
  runDeploy(dirs, [], { STUB_HEALTH_OK_AFTER: '1' });
  makeFakeSrc(dirs.src, 'v3');
  runDeploy(dirs, [], { STUB_VALIDATE_EXIT: '1' });
  runDeploy(dirs, [], { STUB_QMLLINT_EXIT: '255' });
  runDeploy(dirs, ['--rollback']);

  assert.deepEqual(stageOrSwapEntries(dirs), []);
});

test('never touches the real home directory or invokes a real omarchy binary', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const realPluginDir = join(homedir(), '.config', 'omarchy', 'plugins', PLUGIN_ID);
  const existedBefore = existsSync(realPluginDir);
  const mtimeBefore = existedBefore ? statSync(realPluginDir).mtimeMs : null;

  const result = runDeploy(dirs, [], { STUB_LISTPLUGINS_JSON: '[]' });

  assert.equal(result.status, 0);
  const calls = callsLogLines(dirs);
  assert.ok(calls.length > 0);
  const knownStubs = [
    'omarchy-plugin-validate', 'qmllint', 'omarchy-shell', 'omarchy-restart-shell',
    'omarchy-plugin-enable', 'omarchy-plugin-disable', 'omarchy-notification-send', 'qs',
    'omarchy-hyprland-session-locked',
  ];
  for (const line of calls) {
    assert.ok(knownStubs.some((name) => line.startsWith(name)), `unexpected call: ${line}`);
  }

  assert.equal(existsSync(realPluginDir), existedBefore);
  if (existedBefore) {
    assert.equal(statSync(realPluginDir).mtimeMs, mtimeBefore);
  }
});

test('a restart that reports failure while the new shell still comes up is health-checked instead of failed', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_RESTART_EXIT: '1' });

  assert.equal(result.status, 0);
  const calls = callsLogLines(dirs);
  const ping = callIndex(calls, 'omarchy-shell shell ping');
  const health = callIndex(calls, 'omarchy-shell omarchy.clock calendarHealth');
  assert.ok(ping >= 0, 'the shell was never pinged after the failed restart');
  assert.ok(health > ping, 'health was not checked after the shell answered');
  assert.ok(!calls.some((l) => l.startsWith('omarchy-plugin-disable')));
});

test('a locked session is waited out before the shell is restarted', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_LOCKED_SEQUENCE: '0 1', UNIFIED_WIDGET_UNLOCK_TIMEOUT: '2' });

  assert.equal(result.status, 0);
  assert.equal(marker(dirs.cur), 'v1');
  const calls = callsLogLines(dirs);
  const lockChecks = calls.filter((l) => l.startsWith('omarchy-hyprland-session-locked'));
  assert.ok(lockChecks.length >= 2, `expected the lock to be polled until unlocked, saw ${lockChecks.length} check(s)`);
  assert.ok(callIndex(calls, 'omarchy-hyprland-session-locked') < callIndex(calls, 'omarchy-restart-shell'));
});

test('a session that stays locked exits 75 without swapping, restarting or disabling anything', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v2');

  const result = runDeploy(dirs, [], { STUB_LOCKED_SEQUENCE: '0', UNIFIED_WIDGET_UNLOCK_TIMEOUT: '1' });

  assert.equal(result.status, 75);
  assert.equal(marker(dirs.cur), 'v1');
  assert.ok(!existsSync(dirs.prev));
  assert.deepEqual(stageOrSwapEntries(dirs), []);
  const calls = callsLogLines(dirs);
  assert.ok(!calls.some((l) => l.startsWith('omarchy-restart-shell')));
  assert.ok(!calls.some((l) => l.startsWith('omarchy-plugin-disable')));
  assert.ok(!calls.some((l) => l.startsWith('omarchy-notification-send')));
  assert.match(result.stderr, /locked/);
});

test('a restart refused because the session locked after the swap puts every version back and exits 75', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v2');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v3');

  const result = runDeploy(dirs, [], {
    STUB_LOCKED_SEQUENCE: '1 0',
    STUB_RESTART_EXIT: '1',
    UNIFIED_WIDGET_UNLOCK_TIMEOUT: '1',
  });

  assert.equal(result.status, 75);
  assert.equal(marker(dirs.cur), 'v2');
  assert.equal(marker(dirs.prev), 'v1');
  assert.ok(!existsSync(dirs.failed));
  assert.deepEqual(stageOrSwapEntries(dirs), []);
  const calls = callsLogLines(dirs);
  assert.ok(!calls.some((l) => l.startsWith('omarchy-shell omarchy.clock calendarHealth')));
  assert.ok(!calls.some((l) => l.startsWith('omarchy-plugin-disable')));
  assert.ok(!calls.some((l) => l.startsWith('omarchy-notification-send')));
});

test('a restart refused while the session is locked is retried once it unlocks', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], {
    STUB_LOCKED_SEQUENCE: '1 0 1',
    STUB_RESTART_EXIT: '1 0',
    UNIFIED_WIDGET_UNLOCK_TIMEOUT: '2',
  });

  assert.equal(result.status, 0);
  assert.equal(marker(dirs.cur), 'v1');
  const restarts = callsLogLines(dirs).filter((l) => l.startsWith('omarchy-restart-shell'));
  assert.equal(restarts.length, 2);
});

test('--rollback while the session stays locked exits 75 and leaves both versions where they are', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v2');
  assert.equal(runDeploy(dirs, []).status, 0);

  const result = runDeploy(dirs, ['--rollback'], { STUB_LOCKED_SEQUENCE: '0', UNIFIED_WIDGET_UNLOCK_TIMEOUT: '1' });

  assert.equal(result.status, 75);
  assert.equal(marker(dirs.cur), 'v2');
  assert.equal(marker(dirs.prev), 'v1');
  assert.ok(!callsLogLines(dirs).some((l) => l.startsWith('omarchy-restart-shell')));
});

test('--rollback whose restart is refused by a lock after the swap swaps back and exits 75', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v2');
  assert.equal(runDeploy(dirs, []).status, 0);

  const result = runDeploy(dirs, ['--rollback'], {
    STUB_LOCKED_SEQUENCE: '1 0',
    STUB_RESTART_EXIT: '1',
    UNIFIED_WIDGET_UNLOCK_TIMEOUT: '1',
  });

  assert.equal(result.status, 75);
  assert.equal(marker(dirs.cur), 'v2');
  assert.equal(marker(dirs.prev), 'v1');
  assert.deepEqual(stageOrSwapEntries(dirs), []);
  assert.ok(!callsLogLines(dirs).some((l) => l.startsWith('omarchy-plugin-disable')));
});

test('a failed new version whose restored previous version cannot restart because the session stays locked disables the widget and notifies', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v2');

  const result = runDeploy(dirs, [], {
    STUB_HEALTH_OK_AFTER: '999999',
    STUB_RESTART_EXIT: '0 1',
    STUB_LOCKED_SEQUENCE: '1 0',
    UNIFIED_WIDGET_UNLOCK_TIMEOUT: '1',
  });

  assert.equal(result.status, 1);
  assert.equal(marker(dirs.cur), 'v1');
  assert.equal(marker(dirs.failed), 'v2');
  assert.ok(!existsSync(dirs.prev));
  assert.deepEqual(stageOrSwapEntries(dirs), []);
  const calls = callsLogLines(dirs);
  assert.equal(calls.filter((l) => l.startsWith('omarchy-restart-shell')).length, 2);
  assert.ok(calls.some((l) => l.startsWith(`omarchy-plugin-disable ${PLUGIN_ID}`)), 'the widget was not disabled');
  const notify = calls.find((l) => l.startsWith('omarchy-notification-send'));
  assert.ok(notify, 'no notification was sent');
  assert.ok(notify.includes('-u critical'));
  assert.ok(notify.includes('Calendar widget disabled'));
  assert.match(notify, /previous version is back on disk/);
  assert.match(notify, /next shell restart/);
});

test('when the restored previous version fails too, the notification also names that later failure', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  assert.equal(runDeploy(dirs, []).status, 0);
  makeFakeSrc(dirs.src, 'v2');

  const beforeFile = join(dirs.root, 'log-before.txt');
  const afterFile = join(dirs.root, 'log-after.txt');
  writeFileSync(beforeFile, 'DEBUG qml: startup\n');
  writeFileSync(afterFile, `WARN qml: Plugin widget ${PLUGIN_ID} failed: BarWidget.qml:3: TypeError\n`);

  const result = runDeploy(dirs, [], {
    STUB_QS_LOG_BEFORE: beforeFile,
    STUB_QS_LOG_AFTER: afterFile,
    STUB_RESTART_EXIT: '0 1',
    STUB_PING_EXIT: '1',
  });

  assert.equal(result.status, 1);
  const notify = callsLogLines(dirs).find((l) => l.startsWith('omarchy-notification-send'));
  assert.ok(notify, 'no notification was sent');
  assert.match(notify, /shell log reported an error/);
  assert.match(notify, /could not be restarted/);
});

test('a successful deploy pins the bar centre on the widget', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  writeShellJson(dirs, 'omarchy.clock');
  writeFileSync(dirs.pluginState, 'false');

  const result = runDeploy(dirs, [], { STUB_PLUGIN_STATE_FILE: dirs.pluginState });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(anchorOf(dirs), PLUGIN_ID);
});

test('a deploy that leaves the widget switched off leaves the centre anchor alone', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');
  writeShellJson(dirs, 'omarchy.clock');
  writeFileSync(dirs.pluginState, 'false');

  const result = runDeploy(dirs, ['--no-enable'], { STUB_PLUGIN_STATE_FILE: dirs.pluginState });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(anchorOf(dirs), 'omarchy.clock');
  assert.ok(!callsLogLines(dirs).some((l) => l.startsWith('omarchy-plugin-enable')));
});

test('a deploy that disables the widget puts the centre anchor back on the stock clock', () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const result = runDeploy(dirs, [], { STUB_HEALTH_OK_AFTER: '999999' });

  assert.equal(result.status, 1);
  assert.ok(callsLogLines(dirs).some((l) => l.startsWith(`omarchy-plugin-disable ${PLUGIN_ID}`)));
  assert.equal(anchorOf(dirs), 'omarchy.clock');
});

test("a deploy warns without failing when Omarchy's clock no longer matches the recorded checksums", () => {
  const dirs = makeDirs();
  makeFakeSrc(dirs.src, 'v1');

  const quiet = runDeploy(dirs, [], { STUB_LISTPLUGINS_JSON: '[]' });

  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /UPDATING\.md/);

  writeFileSync(join(dirs.clock, 'Panel.qml'), 'Item { id: panel }\n// an upstream change\n');
  makeFakeSrc(dirs.src, 'v2');
  const warned = runDeploy(dirs, [], { STUB_LISTPLUGINS_JSON: '[]' });

  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /UPDATING\.md/);
  assert.equal(marker(dirs.cur), 'v2');
});
