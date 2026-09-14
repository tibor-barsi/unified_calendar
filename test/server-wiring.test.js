process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

test('server.js: registerWidgetRoutes(app is called before app.use(session(', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf8');
  const widgetCallIdx = src.indexOf('registerWidgetRoutes(app');
  // Tolerant of the house style that breaks this call across lines: app.use(\n  session(...) ...).
  const sessionCallMatch = /app\.use\(\s*session\(/.exec(src);
  const sessionCallIdx = sessionCallMatch ? sessionCallMatch.index : -1;
  assert.notEqual(widgetCallIdx, -1, 'server.js never calls registerWidgetRoutes(app...)');
  assert.notEqual(sessionCallIdx, -1, 'server.js never calls app.use(session(...)');
  assert.ok(
    widgetCallIdx < sessionCallIdx,
    `registerWidgetRoutes(app...) (at ${widgetCallIdx}) must appear before app.use(session(...) (at ${sessionCallIdx})`
  );
});

test('server.js: imports registerWidgetRoutes from ./src/widget-routes.js', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf8');
  assert.match(src, /registerWidgetRoutes/);
  assert.match(src, /widget-routes\.js/);
});

test('server.js: the widget event cache is opt-in — the null store is used unless UNIFIED_CALENDAR_WIDGET_CACHE is set', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf8');
  assert.match(src, /createNullCacheStore/, 'server.js never imports/uses the null cache store');
  assert.match(
    src,
    /cacheStore:\s*widgetCacheEnabled\(\)\s*\?\s*createWidgetCacheStore\([^)]*\)\s*:\s*createNullCacheStore\(\)/,
    'server.js must pick the disk-backed store only when widgetCacheEnabled() says so'
  );
});

test('server.js: the widget cache lives in the same DATA_DIR as the rest of the persisted state', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf8');
  assert.match(src, /createWidgetCacheStore\(\{\s*dir:\s*DATA_DIR\s*\}\)/);
  assert.doesNotMatch(
    src,
    /createWidgetCacheStore\(\{\s*dir:\s*path\.join\(__dirname,\s*'data'\)/,
    'the widget cache dir must not be hardcoded — it has to honour UNIFIED_CALENDAR_DATA_DIR'
  );
});

test('src/store.js: exports DATA_DIR, honouring UNIFIED_CALENDAR_DATA_DIR', async () => {
  process.env.UNIFIED_CALENDAR_DATA_DIR = path.join(REPO_ROOT, 'test-only-data-dir');
  const { DATA_DIR } = await import('../src/store.js');
  assert.equal(DATA_DIR, path.join(REPO_ROOT, 'test-only-data-dir'));
});

test('package.json: "test" script runs the server test suite', async () => {
  const raw = await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);
  const tokens = String(pkg.scripts?.test || '').split(/\s+/);
  assert.ok(tokens.includes('test/*.test.js'));
});
