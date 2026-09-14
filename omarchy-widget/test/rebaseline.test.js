import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REBASELINE_SH = join(here, '..', 'tools', 'rebaseline.sh');
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';

const CLOCK_FILES = {
  'BarWidget.qml': 'Item { id: bar }\n',
  'Panel.qml': 'Item { id: panel }\n',
  'Model.js': 'function model() {}\n',
  'manifest.json': '{"schemaVersion":1,"id":"omarchy.clock"}\n',
};

const explain = (r) => `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'unified-clock-rebaseline-')));
  if (!process.env.KEEP_TEST_TMP) t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    home: join(root, 'home'),
    clock: join(root, 'clock'),
    upstream: join(root, 'upstream'),
  };
}

function writeClock(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

// Writes upstream/SHA256SUMS, upstream/VERSION, and a tracked copy of each file --
// the same shape rebaseline.sh itself produces and check-omarchy.sh reads back.
// `reverseOrder` builds the SUMS lines in something other than name-sorted order,
// like the real upstream/SHA256SUMS in this repo.
function writeBaseline(s, files, { version = 'omarchy old-version-placeholder\n', reverseOrder = false } = {}) {
  mkdirSync(s.upstream, { recursive: true });
  let entries = Object.entries(files);
  if (reverseOrder) entries = entries.reverse();
  const lines = entries.map(([name, body]) => `${sha256(body)}  ${name}`);
  writeFileSync(join(s.upstream, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(s.upstream, name), body);
  if (version !== null) writeFileSync(join(s.upstream, 'VERSION'), version);
}

function env(s, overrides = {}) {
  const base = {
    PATH: SYSTEM_PATH,
    HOME: s.home,
    UNIFIED_WIDGET_OMARCHY_CLOCK_DIR: s.clock,
    UNIFIED_WIDGET_UPSTREAM_DIR: s.upstream,
    ...overrides,
  };
  for (const key of Object.keys(base)) {
    if (base[key] === undefined) delete base[key];
  }
  return base;
}

function runRebaseline(s, args = [], { input, overrides = {} } = {}) {
  const opts = { env: env(s, overrides), encoding: 'utf8', timeout: 30000 };
  if (input !== undefined) opts.input = input;
  return spawnSync('bash', [REBASELINE_SH, ...args], opts);
}

function parseSums(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const gap = line.indexOf('  ');
    out[line.slice(gap + 2)] = line.slice(0, gap);
  }
  return out;
}

// Mirrors check-omarchy.sh's fingerprint_lines(): sort the lines, sha256sum the
// sorted block, keep only the hex digest.
function fingerprintLines(text) {
  const r = spawnSync('bash', ['-c', 'LC_ALL=C sort | sha256sum | cut -d " " -f1'], {
    input: text, encoding: 'utf8', env: { PATH: SYSTEM_PATH },
  });
  return r.stdout.trim();
}

// Mirrors check-omarchy.sh's clock_fingerprint(): hash every top-level file of the
// clock dir, from inside it, sorted by name -- then fingerprint_lines() that.
function clockFingerprint(dir) {
  const r = spawnSync('bash', [
    '-c',
    'cd "$1" && find . -maxdepth 1 -type f -printf "%P\\n" | LC_ALL=C sort | '
      + 'while IFS= read -r name; do sha256sum -- "$name"; done',
    '_', dir,
  ], { encoding: 'utf8', env: { PATH: SYSTEM_PATH } });
  return fingerprintLines(r.stdout);
}

function realOmarchyVersion() {
  const r = spawnSync('bash', ['-c', "pacman -Q omarchy 2>/dev/null || printf 'omarchy unknown\\n'"], {
    encoding: 'utf8', env: { PATH: SYSTEM_PATH },
  });
  return r.stdout;
}

// A baseline that is stale (one changed file, one added file, one removed file
// relative to the baseline), followed by a `--yes` adopt. Reused by the tests that
// only care about the state left behind after adopting.
function setupAdopted(t) {
  const s = setup(t);
  writeClock(s.clock, {
    'BarWidget.qml': CLOCK_FILES['BarWidget.qml'],
    'Panel.qml': `${CLOCK_FILES['Panel.qml']}// v2\n`,
    'Model.js': CLOCK_FILES['Model.js'],
    'manifest.json': CLOCK_FILES['manifest.json'],
    'Extra.qml': 'Item { id: extra }\n',
  });
  writeBaseline(s, {
    ...CLOCK_FILES,
    'ToBeRemoved.txt': 'stale\n',
  });

  const result = runRebaseline(s, ['--yes']);
  return { s, result };
}

test('--check exits 0 and writes nothing when the clock matches the baseline', (t) => {
  const s = setup(t);
  writeClock(s.clock, CLOCK_FILES);
  writeBaseline(s, CLOCK_FILES, { version: 'omarchy 4.0.0-1\n' });
  const beforeSums = readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8');
  const beforeVersion = readFileSync(join(s.upstream, 'VERSION'), 'utf8');
  const beforeEntries = readdirSync(s.upstream).sort();

  const result = runRebaseline(s, ['--check']);

  assert.equal(result.status, 0, explain(result));
  assert.match(result.stdout, /already matches/);
  assert.equal(readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8'), beforeSums);
  assert.equal(readFileSync(join(s.upstream, 'VERSION'), 'utf8'), beforeVersion);
  assert.deepEqual(readdirSync(s.upstream).sort(), beforeEntries);
});

test('--check exits 1 when the clock differs, and leaves the baseline files untouched', (t) => {
  const s = setup(t);
  writeClock(s.clock, CLOCK_FILES);
  writeBaseline(s, CLOCK_FILES, { version: 'omarchy 4.0.0-1\n' });
  writeFileSync(join(s.clock, 'Panel.qml'), `${CLOCK_FILES['Panel.qml']}// an upstream change\n`);
  const beforeSums = readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8');
  const beforeVersion = readFileSync(join(s.upstream, 'VERSION'), 'utf8');

  const result = runRebaseline(s, ['--check']);

  assert.equal(result.status, 1, explain(result));
  assert.match(result.stdout, /differs/);
  assert.equal(readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8'), beforeSums);
  assert.equal(readFileSync(join(s.upstream, 'VERSION'), 'utf8'), beforeVersion);
});

test('a shuffled SHA256SUMS line order is not treated as a difference (regression guard)', (t) => {
  const s = setup(t);
  writeClock(s.clock, CLOCK_FILES);
  writeBaseline(s, CLOCK_FILES, { version: 'omarchy 4.0.0-1\n', reverseOrder: true });
  const names = readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8').trim().split('\n')
    .map((l) => l.split('  ')[1]);
  assert.notDeepEqual(names, [...names].sort(), 'test setup bug: the baseline ended up name-sorted anyway');

  const result = runRebaseline(s, ['--check']);

  assert.equal(result.status, 0, explain(result));
  assert.match(result.stdout, /already matches/);
});

test('--yes adopts a changed file, an added file, and a removed file, and regenerates SHA256SUMS and VERSION', (t) => {
  const { s, result } = setupAdopted(t);

  assert.equal(result.status, 0, explain(result));
  assert.equal(
    readFileSync(join(s.upstream, 'Panel.qml'), 'utf8'),
    readFileSync(join(s.clock, 'Panel.qml'), 'utf8'),
    'the changed file was not updated in upstream/',
  );
  assert.equal(
    readFileSync(join(s.upstream, 'Extra.qml'), 'utf8'),
    readFileSync(join(s.clock, 'Extra.qml'), 'utf8'),
    'the added file was not copied into upstream/',
  );
  assert.ok(!existsSync(join(s.upstream, 'ToBeRemoved.txt')), 'the removed file is still in upstream/');

  const sums = parseSums(readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8'));
  const clockNames = readdirSync(s.clock).sort();
  assert.deepEqual(Object.keys(sums).sort(), clockNames, 'SHA256SUMS does not list exactly the current clock files');
  for (const name of clockNames) {
    assert.equal(sums[name], sha256(readFileSync(join(s.clock, name))), `hash for ${name} was not regenerated`);
  }

  assert.equal(readFileSync(join(s.upstream, 'VERSION'), 'utf8'), realOmarchyVersion());
});

test('after --yes adopts, --check reports the baseline matches', (t) => {
  const { s, result } = setupAdopted(t);
  assert.equal(result.status, 0, explain(result));

  const check = runRebaseline(s, ['--check']);

  assert.equal(check.status, 0, explain(check));
  assert.match(check.stdout, /already matches/);
});

test("the adopted SHA256SUMS is byte-compatible with check-omarchy.sh's clock_fingerprint()", (t) => {
  const { s, result } = setupAdopted(t);
  assert.equal(result.status, 0, explain(result));

  const clockFp = clockFingerprint(s.clock);
  const sumsFp = fingerprintLines(readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8'));

  assert.ok(clockFp, 'could not compute a clock fingerprint');
  assert.equal(sumsFp, clockFp);
});

test('refuses when the clock directory does not exist', (t) => {
  const s = setup(t);
  mkdirSync(s.upstream, { recursive: true });

  const result = runRebaseline(s, ['--check']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no clock directory/);
  assert.ok(!existsSync(join(s.upstream, 'SHA256SUMS')));
});

test('refuses when the clock directory exists but has no manifest.json', (t) => {
  const s = setup(t);
  writeClock(s.clock, { 'BarWidget.qml': 'Item {}\n' });
  mkdirSync(s.upstream, { recursive: true });

  const result = runRebaseline(s, ['--check']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest\.json/);
  assert.ok(!existsSync(join(s.upstream, 'SHA256SUMS')));
});

test('an interactive run answered "n" leaves the baseline unchanged and exits non-zero', (t) => {
  const s = setup(t);
  writeClock(s.clock, CLOCK_FILES);
  writeBaseline(s, { ...CLOCK_FILES, 'Panel.qml': `${CLOCK_FILES['Panel.qml']}// old\n` });
  const beforeSums = readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8');
  const beforeVersion = readFileSync(join(s.upstream, 'VERSION'), 'utf8');

  const result = runRebaseline(s, [], { input: 'n\n' });

  assert.notEqual(result.status, 0, explain(result));
  assert.match(result.stdout, /Left the baseline alone/);
  assert.equal(readFileSync(join(s.upstream, 'SHA256SUMS'), 'utf8'), beforeSums);
  assert.equal(readFileSync(join(s.upstream, 'VERSION'), 'utf8'), beforeVersion);
  assert.equal(
    readFileSync(join(s.upstream, 'Panel.qml'), 'utf8'),
    `${CLOCK_FILES['Panel.qml']}// old\n`,
    'the tracked copy was overwritten despite the "n" answer',
  );
});

test('an unknown argument exits non-zero and prints usage', (t) => {
  const s = setup(t);
  writeClock(s.clock, CLOCK_FILES);
  mkdirSync(s.upstream, { recursive: true });

  const result = runRebaseline(s, ['--bogus']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown argument/);
  assert.match(result.stderr, /Usage: rebaseline\.sh/);
});
