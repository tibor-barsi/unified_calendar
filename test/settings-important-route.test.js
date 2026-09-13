process.env.TZ = 'Europe/Ljubljana';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The widget stars one id at a time (POST /api/widget/important) while the web app used to PUT
// the whole importantEvents array from a page-load snapshot, silently dropping every star made in
// the widget meanwhile. These tests drive the real server.js — both routes, one store — so the
// race is exercised exactly as it happens in the running app, not just at the store level.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-calendar-server-test-'));
const settingsFile = path.join(dataDir, 'settings.json');
// An existing install's settings.json: world-readable, and already holding a star.
await fs.writeFile(settingsFile, JSON.stringify({ importantEvents: ['pre-existing'] }), { mode: 0o644 });
await fs.chmod(settingsFile, 0o644);

process.env.UNIFIED_CALENDAR_DATA_DIR = dataDir;
process.env.PORT = '0'; // OS-assigned, so the test never collides with the running service
process.env.AUTH_PASSWORD = 'test-only-password';
process.env.SESSION_SECRET = 'test-only-secret';

const { server } = await import('../server.js');
if (!server.listening) {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

// The password gate hands out a cal_auth cookie; every /api call below carries it.
const loginRes = await fetch(`${baseUrl}/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'password=test-only-password',
  redirect: 'manual',
});
const cookie = String(loginRes.headers.get('set-cookie') || '').split(';')[0];

function post(pathname, body, { auth = true, raw } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { cookie } : {}) },
    body: raw === undefined ? JSON.stringify(body) : raw,
  });
}

async function readSettings() {
  const res = await fetch(`${baseUrl}/api/settings`, { headers: { cookie } });
  return res.json();
}

test('login handed out an auth cookie (test setup)', () => {
  assert.match(cookie, /^cal_auth=/);
});

// ── the lost-update race ──────────────────────────────────────────

test('POST /api/settings/important: a star made in the widget survives a later star in the web app', async () => {
  // 1. The web app loads and snapshots settings.importantEvents.
  const snapshot = (await readSettings()).importantEvents;
  assert.ok(Array.isArray(snapshot));

  // 2. The widget stars an event server-side, behind the web app's back.
  const widgetRes = await post('/api/widget/important', { id: 'race-widget-star', important: true });
  assert.equal(widgetRes.status, 200);

  // 3. The web app stars a different event while still holding its stale snapshot.
  const webRes = await post('/api/settings/important', { id: 'race-web-star', important: true });
  assert.equal(webRes.status, 200);

  // 4. Both stars must survive.
  const merged = (await readSettings()).importantEvents;
  assert.ok(merged.includes('race-widget-star'), 'the widget star was discarded by the web-app star');
  assert.ok(merged.includes('race-web-star'), 'the web-app star was not saved');
  assert.ok(merged.includes('pre-existing'), 'a star from before this session was dropped');
});

test('PUT /api/settings replaces the whole list, which is exactly why the client must not star through it', async () => {
  // The bug this fix removes, reproduced against the endpoint the web app used to call: a
  // page-load snapshot plus one new star, PUT as a whole array, wipes anything starred meanwhile.
  const snapshot = (await readSettings()).importantEvents;
  await post('/api/widget/important', { id: 'legacy-widget-star', important: true });
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ importantEvents: [...snapshot, 'legacy-web-star'] }),
  });
  assert.equal(res.status, 200);
  const list = (await readSettings()).importantEvents;
  assert.ok(list.includes('legacy-web-star'));
  assert.ok(
    !list.includes('legacy-widget-star'),
    'PUT /api/settings is a whole-array replace; if it ever starts merging, the client comment about it is stale'
  );
});

test('POST /api/settings/important: the response carries the updated list, so the client can reconcile', async () => {
  await post('/api/widget/important', { id: 'reconcile-widget', important: true });
  const res = await post('/api/settings/important', { id: 'reconcile-web', important: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.importantEvents), 'the response must include importantEvents');
  assert.ok(body.importantEvents.includes('reconcile-web'));
  assert.ok(
    body.importantEvents.includes('reconcile-widget'),
    'the returned list must include stars the client never saw, or it cannot reconcile'
  );
});

test('POST /api/settings/important: important:false unstars just that id', async () => {
  await post('/api/settings/important', { id: 'unstar-me', important: true });
  await post('/api/settings/important', { id: 'keep-me', important: true });
  const res = await post('/api/settings/important', { id: 'unstar-me', important: false });
  assert.equal(res.status, 200);
  const list = (await readSettings()).importantEvents;
  assert.ok(!list.includes('unstar-me'));
  assert.ok(list.includes('keep-me'));
});

test('POST /api/settings/important: the star reaches data/settings.json', async () => {
  await post('/api/settings/important', { id: 'persisted-through-http', important: true });
  const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.ok(saved.importantEvents.includes('persisted-through-http'));
});

test('a settings.json that predates the 0600 hardening is rewritten as 0600, not left 0644', async () => {
  await post('/api/settings/important', { id: 'mode-check', important: true });
  const mode = (await fs.stat(settingsFile)).mode & 0o777;
  assert.equal(mode.toString(8), '600', 'settings.json holds OAuth tokens and a CalDAV password in plaintext');
});

test('PUT /api/settings still accepts a whole importantEvents array (back-compat)', async () => {
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ importantEvents: ['compat-a', 'compat-b'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.importantEvents, ['compat-a', 'compat-b']);
});

// ── auth ──────────────────────────────────────────────────────────

test('POST /api/settings/important: 401 without the auth cookie, and nothing is starred', async () => {
  const res = await post('/api/settings/important', { id: 'unauthorized-star', important: true }, { auth: false });
  assert.equal(res.status, 401);
  const list = (await readSettings()).importantEvents;
  assert.ok(!list.includes('unauthorized-star'));
});

// ── body validation: identical to the widget route ────────────────

const BAD_BODIES = [
  ['id missing', { important: true }],
  ['id not a string', { id: 123, important: true }],
  ['id empty', { id: '', important: true }],
  ['id longer than 1000 characters', { id: 'x'.repeat(1001), important: true }],
  ['important missing', { id: 'ics-f1-a' }],
  ['important not a boolean', { id: 'ics-f1-a', important: 'true' }],
];

for (const [label, body] of BAD_BODIES) {
  test(`POST /api/settings/important: 400 when ${label} — same as POST /api/widget/important`, async () => {
    const web = await post('/api/settings/important', body);
    const widget = await post('/api/widget/important', body);
    assert.equal(web.status, 400, `web route accepted a body with ${label}`);
    assert.equal(widget.status, 400);
  });
}

test('POST /api/settings/important: an id of exactly 1000 characters is accepted, like the widget route', async () => {
  const res = await post('/api/settings/important', { id: 'y'.repeat(1000), important: true });
  assert.equal(res.status, 200);
});

test('POST /api/settings/important: 400 when the body is not an object', async () => {
  const res = await post('/api/settings/important', null, { raw: '"just a string"' });
  assert.equal(res.status, 400);
});

test('POST /api/settings/important: 400 on malformed JSON', async () => {
  const res = await post('/api/settings/important', null, { raw: '{ not valid json' });
  assert.equal(res.status, 400);
});
