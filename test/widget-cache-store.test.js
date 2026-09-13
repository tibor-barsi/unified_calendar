process.env.TZ = 'Europe/Ljubljana';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createWidgetCacheStore,
  createNullCacheStore,
  widgetCacheEnabled,
  MAX_CACHE_BYTES,
} from '../src/widget-cache-store.js';

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function mkTmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'widget-cache-test-'));
  tempDirs.push(dir);
  return dir;
}

test('createWidgetCacheStore: missing file -> load() returns an empty cache', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  const cache = await store.load();
  assert.deepEqual(cache, { ranges: {} });
});

test('createWidgetCacheStore: corrupt JSON -> load() returns an empty cache', async () => {
  const dir = await mkTmpDir();
  await fs.writeFile(path.join(dir, 'widget-cache.json'), '{ not valid json');
  const store = createWidgetCacheStore({ dir });
  const cache = await store.load();
  assert.deepEqual(cache, { ranges: {} });
});

test('createWidgetCacheStore: file with no "ranges" key -> load() returns an empty cache', async () => {
  const dir = await mkTmpDir();
  await fs.writeFile(path.join(dir, 'widget-cache.json'), JSON.stringify({ foo: 'bar' }));
  const store = createWidgetCacheStore({ dir });
  const cache = await store.load();
  assert.deepEqual(cache, { ranges: {} });
});

test('createWidgetCacheStore: save() then load() round-trips the data', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  const data = {
    ranges: {
      '2026-09-01|2026-09-08': {
        usedAt: '2026-09-13T12:00:00.000Z',
        providers: { microsoft: { syncedAt: '2026-09-13T12:00:00.000Z', events: [] } },
      },
    },
  };
  await store.save(data);
  const loaded = await store.load();
  assert.deepEqual(loaded, data);
});

test('createWidgetCacheStore: save() writes via a tmp file in the same dir, then renames (no leftover tmp files)', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  await store.save({ ranges: {} });
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['widget-cache.json']);
});

test('createWidgetCacheStore: save() removes the tmp file and rethrows when the rename fails', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  // A directory in place of the target file makes the final rename fail.
  await fs.mkdir(path.join(dir, 'widget-cache.json'));
  await assert.rejects(() => store.save({ ranges: {} }));
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ['widget-cache.json']);
  assert.ok((await fs.stat(path.join(dir, 'widget-cache.json'))).isDirectory());
});

test('createWidgetCacheStore: save() creates the directory if missing', async () => {
  const parent = await mkTmpDir();
  const dir = path.join(parent, 'nested', 'data-dir');
  const store = createWidgetCacheStore({ dir });
  await store.save({ ranges: {} });
  const stat = await fs.stat(path.join(dir, 'widget-cache.json'));
  assert.ok(stat.isFile());
});

test('createWidgetCacheStore: save() forces a pre-existing world-readable file back to 0o600', async () => {
  const dir = await mkTmpDir();
  const file = path.join(dir, 'widget-cache.json');
  await fs.writeFile(file, '{}');
  await fs.chmod(file, 0o644);
  const store = createWidgetCacheStore({ dir });
  await store.save({ ranges: {} });
  const mode = (await fs.stat(file)).mode & 0o777;
  // The README promises mode 0600 for this file; inheriting looser bits from an older build
  // quietly broke that promise on every install that already had one.
  assert.equal(mode.toString(8), '600');
});

test('createWidgetCacheStore: save() forces a pre-existing group-readable file back to 0o600', async () => {
  const dir = await mkTmpDir();
  const file = path.join(dir, 'widget-cache.json');
  await fs.writeFile(file, '{}');
  await fs.chmod(file, 0o640);
  const store = createWidgetCacheStore({ dir });
  await store.save({ ranges: {} });
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode.toString(8), '600');
});

test('createWidgetCacheStore: save() creates a new file with mode 0o600', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  await store.save({ ranges: {} });
  const mode = (await fs.stat(path.join(dir, 'widget-cache.json'))).mode & 0o777;
  assert.equal(mode.toString(8), '600');
});

test('createWidgetCacheStore: a second save() overwrites the first (final content wins)', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  await store.save({ ranges: { a: { usedAt: '2026-01-01T00:00:00.000Z', providers: {} } } });
  await store.save({ ranges: { b: { usedAt: '2026-01-02T00:00:00.000Z', providers: {} } } });
  const loaded = await store.load();
  assert.deepEqual(Object.keys(loaded.ranges), ['b']);
});

// ── mergeRange: atomic read-modify-write for one range key ──────────

test('createWidgetCacheStore: mergeRange adds a range key without disturbing existing ones', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  await store.save({ ranges: { a: { usedAt: '2026-01-01T00:00:00.000Z', providers: {} } } });
  const result = await store.mergeRange('b', { usedAt: '2026-01-02T00:00:00.000Z', providers: {} }, 24);
  assert.deepEqual(new Set(Object.keys(result.ranges)), new Set(['a', 'b']));
  const loaded = await store.load();
  assert.deepEqual(loaded, result);
});

test('createWidgetCacheStore: mergeRange prunes to maxRanges by usedAt', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  await store.save({
    ranges: {
      old: { usedAt: '2026-01-01T00:00:00.000Z', providers: {} },
      newer: { usedAt: '2026-01-02T00:00:00.000Z', providers: {} },
    },
  });
  const result = await store.mergeRange('newest', { usedAt: '2026-01-03T00:00:00.000Z', providers: {} }, 2);
  assert.deepEqual(new Set(Object.keys(result.ranges)), new Set(['newer', 'newest']));
});

// ── serialised-size cap ────────────────────────────────────────────

// A range entry whose serialised form is roughly `bytes` long, so size-cap tests can be exact about what fits.
function makeBulkyRange(usedAt, bytes) {
  return {
    usedAt,
    providers: { bulk: { syncedAt: usedAt, events: [{ id: 'x', title: 'y'.repeat(bytes) }] } },
  };
}

test('createWidgetCacheStore: the cache file is machine-read only — written without pretty-print indentation', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  await store.save({ ranges: { a: { usedAt: '2026-01-01T00:00:00.000Z', providers: {} } } });
  const raw = await fs.readFile(path.join(dir, 'widget-cache.json'), 'utf8');
  assert.equal(raw, JSON.stringify({ ranges: { a: { usedAt: '2026-01-01T00:00:00.000Z', providers: {} } } }));
  assert.doesNotMatch(raw, /\n/, 'the cache file should carry no pretty-print newlines');
});

test('createWidgetCacheStore: mergeRange drops least-recently-used ranges until the serialised cache fits maxBytes', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir, maxBytes: 4000 });
  await store.save({
    ranges: {
      oldest: makeBulkyRange('2026-01-01T00:00:00.000Z', 1500),
      middle: makeBulkyRange('2026-01-02T00:00:00.000Z', 1500),
    },
  });
  const result = await store.mergeRange('newest', makeBulkyRange('2026-01-03T00:00:00.000Z', 1500), 24);

  assert.ok(result.ranges.newest, 'the range just written must survive the size cap');
  assert.equal(result.ranges.oldest, undefined, 'the least-recently-used range should have been dropped');
  const raw = await fs.readFile(path.join(dir, 'widget-cache.json'), 'utf8');
  assert.ok(Buffer.byteLength(raw) <= 4000, `on-disk cache is ${Buffer.byteLength(raw)} bytes, over the 4000-byte cap`);
  assert.deepEqual(JSON.parse(raw), result, 'the returned cache must be what actually landed on disk');
});

test('createWidgetCacheStore: a single range bigger than the cap leaves an empty cache, not an oversized file', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir, maxBytes: 2000 });
  const result = await store.mergeRange('huge', makeBulkyRange('2026-01-03T00:00:00.000Z', 5000), 24);

  assert.deepEqual(result, { ranges: {} });
  const raw = await fs.readFile(path.join(dir, 'widget-cache.json'), 'utf8');
  assert.equal(raw, JSON.stringify({ ranges: {} }));
});

test('createWidgetCacheStore: save() enforces the cap too', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir, maxBytes: 2000 });
  await store.save({
    ranges: {
      oldest: makeBulkyRange('2026-01-01T00:00:00.000Z', 1200),
      newest: makeBulkyRange('2026-01-02T00:00:00.000Z', 1200),
    },
  });
  const loaded = await store.load();
  assert.deepEqual(Object.keys(loaded.ranges), ['newest']);
});

test('createWidgetCacheStore: the default cap is 1 MB', async () => {
  const dir = await mkTmpDir();
  assert.equal(MAX_CACHE_BYTES, 1024 * 1024);
  const store = createWidgetCacheStore({ dir });
  const ranges = {};
  // ~1.5 MB spread over 15 ranges, so the cap has to evict roughly a third of them.
  for (let i = 0; i < 15; i++) {
    ranges[`r${i}`] = makeBulkyRange(new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), 100000);
  }
  await store.save({ ranges });
  const raw = await fs.readFile(path.join(dir, 'widget-cache.json'), 'utf8');
  assert.ok(Buffer.byteLength(raw) <= MAX_CACHE_BYTES, `on-disk cache is ${Buffer.byteLength(raw)} bytes`);
  const loaded = await store.load();
  assert.ok(Object.keys(loaded.ranges).length > 0, 'some of the most recent ranges should still fit');
  assert.equal(loaded.ranges.r0, undefined, 'the least-recently-used range should have been dropped');
  assert.ok(loaded.ranges.r14, 'the most-recently-used range should have been kept');
});

// ── opt-in: null store + env flag ──────────────────────────────────

test('createNullCacheStore: load() resolves to an empty cache', async () => {
  const store = createNullCacheStore();
  assert.deepEqual(await store.load(), { ranges: {} });
});

test('createNullCacheStore: save()/mergeRange() are no-ops that keep no state and touch no disk', async () => {
  const dir = await mkTmpDir();
  const store = createNullCacheStore();
  await store.save({ ranges: { a: { usedAt: '2026-01-01T00:00:00.000Z', providers: {} } } });
  const merged = await store.mergeRange('a', { usedAt: '2026-01-01T00:00:00.000Z', providers: {} }, 24);
  assert.deepEqual(merged, { ranges: {} });
  assert.deepEqual(await store.load(), { ranges: {} });
  assert.deepEqual(await fs.readdir(dir), [], 'the null store must not write any file');
});

test('widgetCacheEnabled: off unless UNIFIED_CALENDAR_WIDGET_CACHE is explicitly truthy', () => {
  assert.equal(widgetCacheEnabled({}), false);
  assert.equal(widgetCacheEnabled({ UNIFIED_CALENDAR_WIDGET_CACHE: '' }), false);
  assert.equal(widgetCacheEnabled({ UNIFIED_CALENDAR_WIDGET_CACHE: '0' }), false);
  assert.equal(widgetCacheEnabled({ UNIFIED_CALENDAR_WIDGET_CACHE: 'false' }), false);
  assert.equal(widgetCacheEnabled({ UNIFIED_CALENDAR_WIDGET_CACHE: 'yes' }), false);
});

test('widgetCacheEnabled: on for "1" and "true" (any case, surrounding spaces ignored)', () => {
  assert.equal(widgetCacheEnabled({ UNIFIED_CALENDAR_WIDGET_CACHE: '1' }), true);
  assert.equal(widgetCacheEnabled({ UNIFIED_CALENDAR_WIDGET_CACHE: 'true' }), true);
  assert.equal(widgetCacheEnabled({ UNIFIED_CALENDAR_WIDGET_CACHE: 'TRUE' }), true);
  assert.equal(widgetCacheEnabled({ UNIFIED_CALENDAR_WIDGET_CACHE: ' 1 ' }), true);
});

test('createWidgetCacheStore: concurrent mergeRange calls for two different keys both persist (no lost update)', async () => {
  const dir = await mkTmpDir();
  const store = createWidgetCacheStore({ dir });
  // Fired without waiting for either first, so their load-modify-save cycles genuinely overlap.
  await Promise.all([
    store.mergeRange('x', { usedAt: '2026-01-01T00:00:00.000Z', providers: {} }, 24),
    store.mergeRange('y', { usedAt: '2026-01-01T00:00:01.000Z', providers: {} }, 24),
  ]);
  const loaded = await store.load();
  assert.deepEqual(
    new Set(Object.keys(loaded.ranges)),
    new Set(['x', 'y']),
    'one of the two concurrent mergeRange calls lost its write'
  );
});
