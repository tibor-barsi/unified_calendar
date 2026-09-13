import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHECK_SH = join(here, '..', 'tools', 'check-omarchy.sh');
const ANCHOR_SH = join(here, '..', 'tools', 'center-anchor.sh');
const STUBS_DIR = join(here, '..', 'tools', 'test-stubs');
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';
const PLUGIN_ID = 'unified.clock';
const STOCK_ID = 'omarchy.clock';
const GLYPH = '\u{f00ed}';
const CLOCK_FILES = {
  'BarWidget.qml': 'Item { id: bar }\n',
  'Panel.qml': 'Item { id: panel }\n',
  'Model.js': 'function model() {}\n',
  'manifest.json': '{"schemaVersion":1,"id":"omarchy.clock"}\n',
};

const explain = (r) => `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function shellJson(anchor) {
  const config = {
    version: 1,
    bar: {
      position: 'top',
      centerAnchor: anchor,
      layout: {
        left: [{ id: 'omarchy.menu' }],
        center: [{ id: 'omarchy.indicators' }, { id: PLUGIN_ID, format: 'dddd HH:mm' }],
        right: [{ id: 'omarchy.power' }],
      },
    },
    plugins: [],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function setup(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'unified-clock-check-')));
  if (!process.env.KEEP_TEST_TMP) t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = {
    root,
    home: join(root, 'home'),
    state: join(root, 'state'),
    clock: join(root, 'clock'),
    widget: join(root, 'widget'),
    shellConfig: join(root, 'shell-config'),
    shellJson: join(root, 'home', '.config', 'omarchy', 'shell.json'),
    calls: join(root, 'calls.log'),
    notifyArgv: join(root, 'notify-argv'),
    pluginState: join(root, 'plugin-state'),
    stockState: join(root, 'stock-state'),
    qsLog: join(root, 'qs-log'),
    log: join(root, 'state', 'check.log'),
    paused: join(root, 'state', 'paused'),
  };
  mkdirSync(dirname(s.shellJson), { recursive: true });
  mkdirSync(s.state, { recursive: true });
  mkdirSync(s.clock, { recursive: true });
  mkdirSync(join(s.widget, 'upstream'), { recursive: true });
  writeFileSync(join(s.widget, 'UPDATING.md'), '# how to update\n');
  writeFileSync(s.shellJson, shellJson(options.anchor ?? PLUGIN_ID));
  writeFileSync(s.pluginState, options.enabled === false ? 'false' : 'true');
  writeFileSync(s.stockState, 'false');
  writeFileSync(s.qsLog, 'INFO shell started\n');
  for (const [name, body] of Object.entries(CLOCK_FILES)) {
    writeFileSync(join(s.clock, name), body);
  }
  writeSums(s);
  return s;
}

function writeSums(s) {
  const names = readdirSync(s.clock).sort().reverse();
  const lines = names.map((name) => `${sha256(readFileSync(join(s.clock, name)))}  ${name}`);
  writeFileSync(join(s.widget, 'upstream', 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function env(s, overrides = {}) {
  const base = {
    PATH: `${STUBS_DIR}:${SYSTEM_PATH}`,
    HOME: s.home,
    UNIFIED_WIDGET_WIDGET_DIR: s.widget,
    UNIFIED_WIDGET_STATE_DIR: s.state,
    UNIFIED_WIDGET_OMARCHY_CLOCK_DIR: s.clock,
    UNIFIED_WIDGET_SHELL_JSON: s.shellJson,
    OMARCHY_SHELL_CONFIG: s.shellConfig,
    UNIFIED_WIDGET_HEALTH_WAIT_SECONDS: '0',
    UNIFIED_WIDGET_POLL_SECONDS: '0.05',
    STUB_CALLS_LOG: s.calls,
    STUB_NOTIFY_ARGV_FILE: s.notifyArgv,
    STUB_PLUGIN_STATE_FILE: s.pluginState,
    STUB_STOCK_CLOCK_STATE_FILE: s.stockState,
    STUB_QS_LOG_BEFORE: s.qsLog,
    ...overrides,
  };
  for (const key of Object.keys(base)) {
    if (base[key] === undefined) delete base[key];
  }
  return base;
}

function runCheck(s, args = [], overrides = {}) {
  return spawnSync('bash', [CHECK_SH, ...args], {
    env: env(s, overrides), encoding: 'utf8', timeout: 30000,
  });
}

function calls(s) {
  if (!existsSync(s.calls)) return [];
  return readFileSync(s.calls, 'utf8').split('\n').filter(Boolean);
}

const notifications = (s) => calls(s).filter((l) => l.startsWith('omarchy-notification-send '));
const pluginCommands = (s) => calls(s).filter((l) => /^omarchy-plugin-(enable|disable) /.test(l));
const notifyArgv = (s) => readFileSync(s.notifyArgv, 'utf8').split('\n').slice(0, -1);
const anchorOf = (s) => JSON.parse(readFileSync(s.shellJson, 'utf8')).bar.centerAnchor;
const pluginState = (s) => readFileSync(s.pluginState, 'utf8');
const pausedText = (s) => readFileSync(s.paused, 'utf8');

function changeClock(s) {
  writeFileSync(join(s.clock, 'Panel.qml'), `${CLOCK_FILES['Panel.qml']}// upstream change\n`);
}

function assertPausedNotification(s, body, widgetDir) {
  assert.equal(notifications(s).length, 1, notifications(s).join('\n'));
  assert.deepEqual(notifyArgv(s).slice(0, 7), [
    '-u', 'critical', '-g', GLYPH, 'Calendar widget paused', body, '--exec',
  ]);
  const argv = notifyArgv(s);
  assert.equal(argv.length, 9, argv.join(' | '));
  assert.equal(argv[7], 'omarchy-agent-prompt');
  assert.ok(argv[8].includes(join(widgetDir, 'UPDATING.md')), argv[8]);
}

test('a widget the user took out of the bar layout stops the run before anything else', (t) => {
  const s = setup(t);
  const config = JSON.parse(readFileSync(s.shellJson, 'utf8'));
  config.bar.layout.center = config.bar.layout.center.filter((e) => e.id !== PLUGIN_ID);
  writeFileSync(s.shellJson, `${JSON.stringify(config, null, 2)}\n`);
  changeClock(s);

  const r = runCheck(s, ['--trigger', 'post-boot']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(calls(s), []);
  assert.ok(!existsSync(s.paused));
  assert.match(r.stdout, /bar layout/);
});

test('an unreadable shell.json stops the run without touching anything', (t) => {
  const s = setup(t);
  writeFileSync(s.shellJson, '{ this is not json\n');

  const r = runCheck(s, ['--trigger', 'post-boot']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(calls(s), []);
  assert.ok(!existsSync(s.paused));
});

test('an unchanged clock with a healthy widget is silent and clears an old paused marker', (t) => {
  const s = setup(t);
  writeFileSync(s.paused, 'stale-fingerprint\nthe widget did not load\n');

  const r = runCheck(s, ['--trigger', 'post-boot']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(notifications(s), []);
  assert.deepEqual(pluginCommands(s), []);
  assert.ok(!existsSync(s.paused), 'the paused marker survived a healthy run');
  assert.equal(anchorOf(s), PLUGIN_ID);
  assert.equal(pluginState(s), 'true');
  assert.match(r.stdout, /unchanged/);
});

test('the fingerprint ignores the order of the SHA256SUMS lines', (t) => {
  const s = setup(t);
  const sums = join(s.widget, 'upstream', 'SHA256SUMS');
  const lines = readFileSync(sums, 'utf8').split('\n').filter(Boolean);
  writeFileSync(sums, `${lines.sort().join('\n')}\n`);

  const r = runCheck(s, ['--trigger', 'post-boot']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(notifications(s), []);
  assert.match(r.stdout, /unchanged/);
});

const unhealthy = [
  ['a health answer that is not ok', { STUB_HEALTH_JSON: '{"ok":false}' }],
  ['a health answer that is not JSON', { STUB_HEALTH_JSON: 'could not reach the widget' }],
  ['no answer from the IPC call', { STUB_HEALTH_JSON: '', STUB_HEALTH_EXIT: '1' }],
];

for (const [name, overrides] of unhealthy) {
  test(`an unchanged clock with ${name} pauses the widget and notifies once`, (t) => {
    const s = setup(t);

    const r = runCheck(s, ['--trigger', 'post-boot'], overrides);

    assert.equal(r.status, 0, explain(r));
    assert.deepEqual(pluginCommands(s), [`omarchy-plugin-disable ${PLUGIN_ID}`]);
    assert.equal(pluginState(s), 'false');
    assert.equal(anchorOf(s), STOCK_ID);
    assertPausedNotification(s, 'The calendar widget failed to load. Click to look into it.', s.widget);
    assert.match(pausedText(s), /the widget did not load/);
  });
}

test('a widget failure line in the shell log counts as unhealthy even when health answers ok', (t) => {
  const s = setup(t);
  writeFileSync(s.qsLog, `INFO shell started\nWARN Plugin widget ${PLUGIN_ID} failed to load\n`);

  const r = runCheck(s, ['--trigger', 'post-boot']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(pluginCommands(s), [`omarchy-plugin-disable ${PLUGIN_ID}`]);
  assert.equal(anchorOf(s), STOCK_ID);
  assertPausedNotification(s, 'The calendar widget failed to load. Click to look into it.', s.widget);
});

test('a shell log whose two failure substrings sit on different lines is not a failure', (t) => {
  const s = setup(t);
  writeFileSync(s.qsLog, `INFO plugin ${PLUGIN_ID} loaded\nWARN something else ) threw: boom\n`);

  const r = runCheck(s, ['--trigger', 'post-boot']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(notifications(s), []);
  assert.deepEqual(pluginCommands(s), []);
});

test('a changed clock pauses the widget, moves the anchor and notifies once', (t) => {
  const s = setup(t);
  changeClock(s);

  const r = runCheck(s, ['--trigger', 'post-update']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(pluginCommands(s), [`omarchy-plugin-disable ${PLUGIN_ID}`]);
  assert.equal(pluginState(s), 'false');
  assert.equal(anchorOf(s), STOCK_ID);
  assertPausedNotification(s, 'Omarchy updated its clock. Click to update the widget.', s.widget);
  assert.match(r.stdout, /changed/);
  const [fingerprint, reason] = pausedText(s).split('\n');
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(reason.length > 0);
});

test('a clock directory that is gone counts as changed with its own reason', (t) => {
  const s = setup(t);
  rmSync(s.clock, { recursive: true, force: true });

  const r = runCheck(s, ['--trigger', 'post-update']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(pluginCommands(s), [`omarchy-plugin-disable ${PLUGIN_ID}`]);
  assert.match(pausedText(s), /missing/);
});

test('a clock directory without a manifest counts as changed with its own reason', (t) => {
  const s = setup(t);
  rmSync(join(s.clock, 'manifest.json'));

  const r = runCheck(s, ['--trigger', 'post-update']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(pluginCommands(s), [`omarchy-plugin-disable ${PLUGIN_ID}`]);
  assert.match(pausedText(s), /manifest/);
});

test('a second run for the same fingerprint stays quiet', (t) => {
  const s = setup(t);
  changeClock(s);
  const first = runCheck(s, ['--trigger', 'post-update']);
  assert.equal(first.status, 0, explain(first));
  const fingerprint = pausedText(s);
  rmSync(s.calls);

  const second = runCheck(s, ['--trigger', 'post-update']);

  assert.equal(second.status, 0, explain(second));
  assert.deepEqual(notifications(s), []);
  assert.deepEqual(pluginCommands(s), []);
  assert.equal(pausedText(s), fingerprint);
  assert.equal(anchorOf(s), STOCK_ID);
});

test('a manual run while the widget is already paused notifies again', (t) => {
  const s = setup(t);
  changeClock(s);
  assert.equal(runCheck(s, ['--trigger', 'post-update']).status, 0);
  rmSync(s.calls);

  const again = runCheck(s, ['--trigger', 'manual']);

  assert.equal(again.status, 0, explain(again));
  assert.deepEqual(pluginCommands(s), []);
  assertPausedNotification(s, 'Omarchy updated its clock. Click to update the widget.', s.widget);
});

test('a further Omarchy change while paused is reported again', (t) => {
  const s = setup(t);
  changeClock(s);
  assert.equal(runCheck(s, ['--trigger', 'post-update']).status, 0);
  const firstFingerprint = pausedText(s).split('\n')[0];
  rmSync(s.calls);
  writeFileSync(join(s.clock, 'Panel.qml'), 'Item { id: panel }\n// a second upstream change\n');

  const second = runCheck(s, ['--trigger', 'post-update']);

  assert.equal(second.status, 0, explain(second));
  assert.equal(notifications(s).length, 1, notifications(s).join('\n'));
  assert.notEqual(pausedText(s).split('\n')[0], firstFingerprint);
});

test('a disable that fails notifies once and writes no marker', (t) => {
  const s = setup(t);
  changeClock(s);

  const r = runCheck(s, ['--trigger', 'post-update'], { STUB_DISABLE_EXIT: '1' });

  assert.equal(r.status, 0, explain(r));
  assert.ok(!existsSync(s.paused), 'a marker was written although the widget is still running');
  assert.equal(pluginState(s), 'true');
  assert.equal(anchorOf(s), PLUGIN_ID);
  assert.equal(notifications(s).length, 1, notifications(s).join('\n'));
  const argv = notifyArgv(s);
  assert.deepEqual(argv.slice(0, 4), ['-u', 'critical', '-g', GLYPH]);
  assert.equal(argv.length, 6, argv.join(' | '));
  assert.ok(argv[5].includes(`omarchy-plugin-disable ${PLUGIN_ID}`), argv[5]);
});

test('the post-update trigger never runs a health check', (t) => {
  const s = setup(t);

  const r = runCheck(s, ['--trigger', 'post-update'], { STUB_HEALTH_JSON: '{"ok":false}' });

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(notifications(s), []);
  assert.deepEqual(pluginCommands(s), []);
  assert.ok(!calls(s).some((l) => l.includes('calendarHealth')), calls(s).join('\n'));
  assert.ok(!calls(s).some((l) => l.startsWith('qs log')), calls(s).join('\n'));
});

test('a widget the shell reports as disabled is not health-checked', (t) => {
  const s = setup(t, { enabled: false });

  const r = runCheck(s, ['--trigger', 'post-boot'], { STUB_HEALTH_JSON: '{"ok":false}' });

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(notifications(s), []);
  assert.deepEqual(pluginCommands(s), []);
  assert.ok(!calls(s).some((l) => l.includes('calendarHealth')), calls(s).join('\n'));
});

test('the health poll keeps asking until the widget answers', (t) => {
  const s = setup(t);
  const counter = join(s.root, 'health-counter');

  const r = runCheck(s, ['--trigger', 'manual'], {
    UNIFIED_WIDGET_HEALTH_WAIT_SECONDS: '10',
    STUB_HEALTH_COUNTER_FILE: counter,
    STUB_HEALTH_OK_AFTER: '3',
  });

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(notifications(s), []);
  assert.equal(readFileSync(counter, 'utf8'), '4');
});

test('--resume enables the widget, restores the anchor, clears the marker and reports health', (t) => {
  const s = setup(t, { anchor: STOCK_ID, enabled: false });
  writeFileSync(s.paused, 'some-fingerprint\nOmarchy changed its clock\n');

  const r = runCheck(s, ['--resume']);

  assert.equal(r.status, 0, explain(r));
  assert.deepEqual(pluginCommands(s), [`omarchy-plugin-enable ${PLUGIN_ID}`]);
  assert.equal(pluginState(s), 'true');
  assert.equal(anchorOf(s), PLUGIN_ID);
  assert.ok(!existsSync(s.paused));
  assert.match(r.stdout, /healthy/);
  assert.deepEqual(notifications(s), []);
});

test('--resume reports a non-zero exit when the widget does not come back healthy', (t) => {
  const s = setup(t, { anchor: STOCK_ID, enabled: false });
  writeFileSync(s.paused, 'some-fingerprint\nOmarchy changed its clock\n');

  const r = runCheck(s, ['--resume'], { STUB_HEALTH_JSON: '{"ok":false}' });

  assert.notEqual(r.status, 0, explain(r));
  assert.equal(anchorOf(s), PLUGIN_ID);
  assert.match(r.stdout + r.stderr, /not healthy|did not/);
});

test('--resume fails when the widget cannot be enabled', (t) => {
  const s = setup(t, { anchor: STOCK_ID, enabled: false });

  const r = runCheck(s, ['--resume'], { STUB_ENABLE_EXIT: '1' });

  assert.notEqual(r.status, 0, explain(r));
  assert.equal(anchorOf(s), STOCK_ID);
  assert.equal(pluginState(s), 'false');
});

test('--status reports the fingerprint, the widget state, the anchor, the marker and the last log lines', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')}\n`);

  const matching = runCheck(s, ['--status']);

  assert.equal(matching.status, 0, explain(matching));
  assert.match(matching.stdout, /clock fingerprint match: yes/);
  assert.match(matching.stdout, /widget: enabled/);
  assert.match(matching.stdout, new RegExp(`anchor: ${PLUGIN_ID.replace('.', '\\.')}`));
  assert.match(matching.stdout, /paused: no/);
  assert.match(matching.stdout, /line 8/);
  assert.match(matching.stdout, /line 4/);
  assert.doesNotMatch(matching.stdout, /line 3\b/);
  assert.deepEqual(pluginCommands(s), []);

  changeClock(s);
  writeFileSync(s.paused, 'abc\nOmarchy changed its clock\n');
  const changed = runCheck(s, ['--status']);

  assert.equal(changed.status, 0, explain(changed));
  assert.match(changed.stdout, /clock fingerprint match: no/);
  assert.match(changed.stdout, /paused: yes \(Omarchy changed its clock\)/);
});

test('the check log is trimmed to its last 500 lines once it grows past 256 KB', (t) => {
  const s = setup(t);
  const line = `${'x'.repeat(200)}\n`;
  writeFileSync(s.log, line.repeat(2000));
  const before = statSync(s.log).size;
  assert.ok(before > 262144);

  const r = runCheck(s, ['--trigger', 'post-update']);

  assert.equal(r.status, 0, explain(r));
  const lines = readFileSync(s.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 500);
  assert.ok(statSync(s.log).size < before);
  assert.deepEqual(readdirSync(s.state).filter((n) => n.includes('trim')), []);
});

test('a state directory that cannot be created never fails the run', (t) => {
  const s = setup(t);
  const blocker = join(s.root, 'not-a-dir');
  writeFileSync(blocker, '');

  const r = runCheck(s, ['--trigger', 'post-update'], { UNIFIED_WIDGET_STATE_DIR: join(blocker, 'state') });

  assert.equal(r.status, 0, explain(r));
});

test('an unknown argument is refused', (t) => {
  const s = setup(t);

  const r = runCheck(s, ['--sync-everything']);

  assert.notEqual(r.status, 0, explain(r));
  assert.deepEqual(calls(s), []);
});

test('every logged line carries an ISO timestamp', (t) => {
  const s = setup(t);
  changeClock(s);

  const r = runCheck(s, ['--trigger', 'post-update']);

  const lines = r.stdout.split('\n').filter(Boolean);
  assert.ok(lines.length >= 2, r.stdout);
  for (const l of lines) {
    assert.match(l, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \S/, l);
  }
});

function runAnchor(s, args, overrides = {}) {
  return spawnSync('bash', [ANCHOR_SH, ...args], {
    env: env(s, overrides), encoding: 'utf8', timeout: 30000,
  });
}

test('the anchor helper switches between the two clock ids and leaves the rest byte for byte', (t) => {
  const s = setup(t);
  const before = readFileSync(s.shellJson, 'utf8');

  const toStock = runAnchor(s, [STOCK_ID]);

  assert.equal(toStock.status, 0, explain(toStock));
  const stockText = readFileSync(s.shellJson, 'utf8');
  assert.equal(stockText, before.replace(`"centerAnchor": "${PLUGIN_ID}"`, `"centerAnchor": "${STOCK_ID}"`));

  const back = runAnchor(s, [PLUGIN_ID]);

  assert.equal(back.status, 0, explain(back));
  assert.equal(readFileSync(s.shellJson, 'utf8'), before);
});

test('the anchor helper leaves a third value alone', (t) => {
  const s = setup(t, { anchor: 'omarchy.weather' });
  const before = readFileSync(s.shellJson, 'utf8');

  const r = runAnchor(s, [PLUGIN_ID]);

  assert.equal(r.status, 0, explain(r));
  assert.equal(readFileSync(s.shellJson, 'utf8'), before);
  assert.match(r.stdout, /omarchy\.weather/);
});

test('the anchor helper leaves a shell.json without a centerAnchor alone', (t) => {
  const s = setup(t);
  const config = JSON.parse(readFileSync(s.shellJson, 'utf8'));
  delete config.bar.centerAnchor;
  const before = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(s.shellJson, before);

  const r = runAnchor(s, [PLUGIN_ID]);

  assert.equal(r.status, 0, explain(r));
  assert.equal(readFileSync(s.shellJson, 'utf8'), before);
});

test('the anchor helper is a no-op when the anchor already names the wanted id', (t) => {
  const s = setup(t);
  const before = statSync(s.shellJson);

  const r = runAnchor(s, [PLUGIN_ID]);

  assert.equal(r.status, 0, explain(r));
  assert.equal(statSync(s.shellJson).mtimeMs, before.mtimeMs, 'shell.json was rewritten for nothing');
});

test('the anchor helper keeps the file mode and leaves no temporary file behind', (t) => {
  const s = setup(t);
  const dir = dirname(s.shellJson);

  const r = runAnchor(s, [STOCK_ID]);

  assert.equal(r.status, 0, explain(r));
  assert.equal(statSync(s.shellJson).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(dir), ['shell.json']);
});

test('the anchor helper writes nothing when the file is missing or unparseable', (t) => {
  const s = setup(t);
  writeFileSync(s.shellJson, `{ "bar": { "centerAnchor": "${PLUGIN_ID}" \n`);
  const broken = readFileSync(s.shellJson, 'utf8');

  const unparseable = runAnchor(s, [STOCK_ID]);

  assert.notEqual(unparseable.status, 0, explain(unparseable));
  assert.equal(readFileSync(s.shellJson, 'utf8'), broken);

  rmSync(s.shellJson);
  const missing = runAnchor(s, [STOCK_ID]);

  assert.equal(missing.status, 0, explain(missing));
  assert.ok(!existsSync(s.shellJson));
});

test('the anchor helper refuses an id that is not one of the two clocks', (t) => {
  const s = setup(t);
  const before = readFileSync(s.shellJson, 'utf8');

  const r = runAnchor(s, ['omarchy.weather']);

  assert.notEqual(r.status, 0, explain(r));
  assert.equal(readFileSync(s.shellJson, 'utf8'), before);
});

test('the real tools directory holds no leftover sync safety net', () => {
  const tools = join(here, '..', 'tools');
  assert.ok(!existsSync(join(tools, 'sync-omarchy.sh')));
  assert.ok(existsSync(join(tools, 'check-omarchy.sh')));
  assert.ok(existsSync(join(tools, 'center-anchor.sh')));
  assert.ok(existsSync(join(here, '..', 'UPDATING.md')));
});
