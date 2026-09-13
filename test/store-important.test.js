process.env.TZ = 'Europe/Ljubljana';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-calendar-store-test-'));
  tempDirs.push(dir);
  return dir;
}

async function freshStore() {
  const dir = await makeTempDir();
  process.env.UNIFIED_CALENDAR_DATA_DIR = dir;
  // Cache-bust: a unique query string gets each test its own module instance (and in-memory `settings`).
  const mod = await import(`../src/store.js?t=${Date.now()}-${Math.random()}`);
  mod.loadSettings();
  return { mod, dir };
}

test('setEventImportant: adding an id includes it in importantEvents', async () => {
  const { mod } = await freshStore();
  const list = mod.setEventImportant('ics-f1-abc', true);
  assert.ok(list.includes('ics-f1-abc'));
});

test('setEventImportant: removing an id drops it from importantEvents', async () => {
  const { mod } = await freshStore();
  mod.setEventImportant('ics-f1-abc', true);
  const list = mod.setEventImportant('ics-f1-abc', false);
  assert.ok(!list.includes('ics-f1-abc'));
});

test('setEventImportant: adding the same id twice does not duplicate it', async () => {
  const { mod } = await freshStore();
  mod.setEventImportant('dup-id', true);
  const list = mod.setEventImportant('dup-id', true);
  assert.equal(list.filter((x) => x === 'dup-id').length, 1);
});

test('setEventImportant: removing an id that is not present is a no-op', async () => {
  const { mod } = await freshStore();
  const before = mod.getSettings().importantEvents.slice();
  const list = mod.setEventImportant('never-added', false);
  assert.deepEqual(list, before);
});

test('setEventImportant: caps the list at MAX_IMPORTANT_EVENTS (5000), keeping the most recently starred ids', async () => {
  const { mod } = await freshStore();
  for (let i = 0; i < 5002; i++) mod.setEventImportant(`id-${i}`, true);
  const list = mod.getSettings().importantEvents;
  assert.equal(list.length, 5000);
  // The cap must evict the OLDEST entries, not the newest.
  assert.ok(list.includes('id-5001'), 'the most recently starred id was evicted instead of the oldest one');
  assert.ok(list.includes('id-5000'), 'the second most recently starred id was evicted instead of the oldest one');
  assert.ok(!list.includes('id-0'), 'the oldest id should have been evicted to make room for the new one');
});

test('setEventImportant: re-marking an already-important id moves it to the most-recently-starred end, protecting it from eviction', async () => {
  const { mod } = await freshStore();
  mod.setEventImportant('old-but-important', true);
  for (let i = 0; i < 4999; i++) mod.setEventImportant(`filler-${i}`, true);
  // Now exactly at the cap — re-marking must move it to the most-recently-starred end.
  mod.setEventImportant('old-but-important', true);
  const list = mod.setEventImportant('brand-new', true);
  assert.equal(list.length, 5000);
  assert.ok(
    list.includes('old-but-important'),
    're-marking an id must protect it from eviction as the most-recently-starred, not leave it at its original position'
  );
  assert.ok(list.includes('brand-new'));
});

test('setEventImportant: persists to widget-cache-independent settings.json under the injected data dir', async () => {
  const { mod, dir } = await freshStore();
  mod.setEventImportant('persisted-id', true);
  const raw = await fs.readFile(path.join(dir, 'settings.json'), 'utf8');
  const saved = JSON.parse(raw);
  assert.ok(saved.importantEvents.includes('persisted-id'));
});

test('setEventImportant: a second store instance pointed at the same injected dir reloads the change', async () => {
  const dir = await makeTempDir();
  process.env.UNIFIED_CALENDAR_DATA_DIR = dir;
  const mod1 = await import(`../src/store.js?t=${Date.now()}-${Math.random()}`);
  mod1.loadSettings();
  mod1.setEventImportant('reload-id', true);

  process.env.UNIFIED_CALENDAR_DATA_DIR = dir;
  const mod2 = await import(`../src/store.js?t=${Date.now()}-${Math.random()}`);
  mod2.loadSettings();
  assert.ok(mod2.getSettings().importantEvents.includes('reload-id'));
});

// ── one eviction policy across all three importantEvents paths ────
// setEventImportant, updateSettings and loadSettings write the same capped field. They used to
// disagree — one kept the newest ids, the other two the oldest — so a full-array save could drop
// exactly the ids a single-id star had just added.

test('updateSettings: caps importantEvents at 5000 keeping the NEWEST ids, like setEventImportant', async () => {
  const { mod } = await freshStore();
  const ids = Array.from({ length: 5002 }, (_, i) => `id-${i}`);
  const list = mod.updateSettings({ importantEvents: ids }).importantEvents;
  assert.equal(list.length, 5000);
  assert.ok(list.includes('id-5001'), 'the most recently starred id was evicted instead of the oldest one');
  assert.ok(!list.includes('id-0'), 'the oldest id should have been evicted to make room');
});

test('updateSettings: a duplicated id is deduped at its most recent position', async () => {
  const { mod } = await freshStore();
  const list = mod.updateSettings({ importantEvents: ['a', 'b', 'a'] }).importantEvents;
  assert.deepEqual(list, ['b', 'a']);
});

test('updateSettings: non-string entries are dropped', async () => {
  const { mod } = await freshStore();
  const list = mod.updateSettings({ importantEvents: ['a', 42, null, 'b'] }).importantEvents;
  assert.deepEqual(list, ['a', 'b']);
});

test('loadSettings: caps importantEvents at 5000 keeping the NEWEST ids, like setEventImportant', async () => {
  const dir = await makeTempDir();
  const ids = Array.from({ length: 5002 }, (_, i) => `id-${i}`);
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ importantEvents: ids }));
  process.env.UNIFIED_CALENDAR_DATA_DIR = dir;
  const mod = await import(`../src/store.js?t=${Date.now()}-${Math.random()}`);
  const list = mod.loadSettings().importantEvents;
  assert.equal(list.length, 5000);
  assert.ok(list.includes('id-5001'), 'the most recently starred id was evicted instead of the oldest one');
  assert.ok(!list.includes('id-0'), 'the oldest id should have been evicted to make room');
});

test('a widget star is not evicted by a later full-array save at the cap', async () => {
  const { mod } = await freshStore();
  // The web app's page-load snapshot: already at the cap.
  const snapshot = Array.from({ length: 5000 }, (_, i) => `old-${i}`);
  mod.updateSettings({ importantEvents: snapshot });
  // A star made in the widget afterwards must be the newest entry, so it survives the cap.
  const list = mod.setEventImportant('widget-star', true);
  assert.equal(list.length, 5000);
  assert.ok(list.includes('widget-star'));
  assert.ok(!list.includes('old-0'), 'the oldest snapshot id should have been evicted, not the new star');
});

// ── persistSettings: atomic write (tmp file + rename) ────────────

test('persistSettings: writes leave only settings.json in the data dir (no leftover tmp files)', async () => {
  const { mod, dir } = await freshStore();
  mod.setEventImportant('a', true);
  mod.updateSettings({ theme: 'dark' });
  mod.setEventImportant('b', true);
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['settings.json']);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(saved.importantEvents.sort(), ['a', 'b']);
});

test('persistSettings: a failed rename leaves no tmp file behind and rethrows', async () => {
  const { mod, dir } = await freshStore();
  // A directory in place of the target file makes the final rename fail.
  await fs.mkdir(path.join(dir, 'settings.json'));
  assert.throws(() => mod.setEventImportant('x', true));
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['settings.json']);
  assert.ok((await fs.stat(path.join(dir, 'settings.json'))).isDirectory());
});

test('persistSettings: a pre-existing world-readable settings.json is forced back to 0o600', async () => {
  const { mod, dir } = await freshStore();
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, '{}', { mode: 0o644 });
  await fs.chmod(file, 0o644);
  mod.setEventImportant('a', true);
  const mode = (await fs.stat(file)).mode & 0o777;
  // This file holds OAuth access/refresh tokens and the CalDAV password in plaintext, so the
  // hardening must not be skipped just because the file already existed with looser bits.
  assert.equal(mode.toString(8), '600');
});

test('persistSettings: a pre-existing group-readable settings.json is forced back to 0o600', async () => {
  const { mod, dir } = await freshStore();
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, '{}', { mode: 0o640 });
  await fs.chmod(file, 0o640);
  mod.setEventImportant('a', true);
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode.toString(8), '600');
});

test('persistSettings: a new settings.json is created with mode 0o600', async () => {
  const { mod, dir } = await freshStore();
  mod.setEventImportant('a', true);
  const mode = (await fs.stat(path.join(dir, 'settings.json'))).mode & 0o777;
  assert.equal(mode.toString(8), '600');
});

// feeds.json gets the same treatment as settings.json. An ICS feed URL is a capability: an
// Outlook or Google calendar link works for anyone holding it, with no credentials, so the file
// is as private as a password even though it contains none.
test('persist: a pre-existing world-readable feeds.json is forced back to 0o600', async () => {
  const { mod, dir } = await freshStore();
  const file = path.join(dir, 'feeds.json');
  await fs.writeFile(file, '[]', { mode: 0o644 });
  await fs.chmod(file, 0o644);
  mod.loadFeeds();
  mod.addFeed({ url: 'https://example.com/cal.ics', name: 'Test', color: '#ff0000' });
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode.toString(8), '600');
});

test('persist: a new feeds.json is created with mode 0o600', async () => {
  const { mod, dir } = await freshStore();
  mod.loadFeeds();
  mod.addFeed({ url: 'https://example.com/cal.ics', name: 'Test', color: '#ff0000' });
  const mode = (await fs.stat(path.join(dir, 'feeds.json'))).mode & 0o777;
  assert.equal(mode.toString(8), '600');
});

test('persist: feeds.json is written atomically — a failed rename leaves no tmp file behind', async () => {
  const { mod, dir } = await freshStore();
  mod.loadFeeds();
  // A directory in place of the target file makes the final rename fail.
  await fs.mkdir(path.join(dir, 'feeds.json'));
  assert.throws(() => mod.addFeed({ url: 'https://example.com/cal.ics', name: 'Test', color: '#ff0000' }));
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['feeds.json']);
});
