process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWidgetTestApp } from '../test-support/http-test-app.js';
import { makeDeps, makeMemoryCacheStore, makeEvent } from '../test-support/widget-fixtures.js';
import { createWidgetCacheStore } from '../src/widget-cache-store.js';

const NOW_ISO = '2026-09-13T12:00:00.000Z';

async function getJson(baseUrl, pathAndQuery) {
  const res = await fetch(`${baseUrl}${pathAndQuery}`);
  const body = await res.json();
  return { res, body };
}

// ── GET /api/widget/events: response shape ──────────────────────

test('GET /api/widget/events: full response shape, field by field', async () => {
  const icsEvent = makeEvent({
    id: 'ics-f1-a-2026-09-15T09:00:00.000Z',
    title: 'Standup',
    start: '2026-09-15T09:00:00.000Z',
    end: '2026-09-15T09:30:00.000Z',
    allDay: false,
    color: '#9333ea',
    calId: 'f1',
    source: 'Outlook',
    originalUrl: 'https://outlook.office.com/owa/x',
    location: 'Room 1',
    description: '<p>Daily sync. Join: https://meet.google.com/abc-defg-hij</p>',
  });
  const deps = makeDeps({
    getUnifiedEvents: async () => ({ events: [icsEvent], errors: [] }),
    listCalendars: () => [{ id: 'f1', name: 'Outlook', color: '#9333ea' }],
  });
  deps._state.settings.importantEvents = ['ics-f1-a-2026-09-15T09:00:00.000Z'];
  deps.now = () => new Date(NOW_ISO);

  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('set-cookie'), null);

    assert.deepEqual(Object.keys(body).sort(), [
      'calendars', 'errors', 'events', 'generatedAt', 'range', 'stale', 'syncedAt',
    ].sort());
    assert.equal(body.generatedAt, NOW_ISO);
    assert.deepEqual(body.range, { start: '2026-09-15', end: '2026-09-16' });
    assert.deepEqual(body.calendars, [{ id: 'f1', name: 'Outlook', color: '#9333ea' }]);
    assert.deepEqual(body.errors, []);
    assert.deepEqual(body.stale, []);
    assert.equal(body.syncedAt, NOW_ISO);

    assert.equal(body.events.length, 1);
    const ev = body.events[0];
    assert.deepEqual(Object.keys(ev).sort(), [
      'id', 'title', 'start', 'end', 'allDay', 'calId', 'calendar', 'color',
      'location', 'notes', 'meetingUrl', 'url', 'important',
    ].sort());
    assert.equal(ev.id, 'ics-f1-a-2026-09-15T09:00:00.000Z');
    assert.equal(ev.title, 'Standup');
    assert.equal(ev.start, '2026-09-15T09:00:00.000Z');
    assert.equal(ev.end, '2026-09-15T09:30:00.000Z');
    assert.equal(ev.allDay, false);
    assert.equal(ev.calId, 'f1');
    assert.equal(ev.calendar, 'Outlook');
    assert.equal(ev.color, '#9333ea');
    assert.equal(ev.location, 'Room 1');
    assert.equal(ev.notes, 'Daily sync. Join: https://meet.google.com/abc-defg-hij');
    assert.equal(ev.meetingUrl, 'https://meet.google.com/abc-defg-hij');
    assert.equal(ev.url, 'https://outlook.office.com/owa/x');
    assert.equal(ev.important, true);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: important flag is false when the id is not marked', async () => {
  const ev = makeEvent({ id: 'ics-f1-z' });
  const deps = makeDeps({ getUnifiedEvents: async () => ({ events: [ev], errors: [] }) });
  const app = await startWidgetTestApp(deps);
  try {
    const { body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(body.events[0].important, false);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: calendar name falls back to source when unknown', async () => {
  const ev = makeEvent({ calId: 'f-unknown', source: 'Mystery Feed' });
  const deps = makeDeps({
    getUnifiedEvents: async () => ({ events: [ev], errors: [] }),
    listCalendars: () => [],
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(body.events[0].calendar, 'Mystery Feed');
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: calendars field keeps only id/name/color even if listCalendars returns more', async () => {
  const deps = makeDeps({
    listCalendars: () => [{ id: 'f1', name: 'Outlook', color: '#9333ea', kind: 'ics', visible: true }],
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.deepEqual(body.calendars, [{ id: 'f1', name: 'Outlook', color: '#9333ea' }]);
  } finally {
    await app.close();
  }
});

// ── 400 validation ──────────────────────────────────────────────

test('GET /api/widget/events: 400 on malformed start date', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-9-1&end=2026-09-10');
    assert.equal(res.status, 400);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: 400 on a calendar-invalid date (Feb 30)', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/events?start=2026-02-30&end=2026-03-05');
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: 400 on missing end', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15');
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: 400 when end equals start (zero-length range)', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-15');
    assert.equal(res.status, 400);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: 400 when end is before start', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-10');
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: 400 when the range exceeds 100 days', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/events?start=2026-01-01&end=2026-04-30'); // 119 days
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: a 100-day range is accepted (inclusive boundary)', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/events?start=2026-01-01&end=2026-04-11'); // 100 days
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: a 1-day range is accepted', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

// ── 401 ──────────────────────────────────────────────────────────

test('GET /api/widget/events: 401 when isAuthorized returns false', async () => {
  const deps = makeDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 401);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: 401 when isAuthorized returns false', async () => {
  const deps = makeDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const res = await fetch(`${app.baseUrl}/api/widget/important`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x', important: true }),
    });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: 200 when isAuthorized returns true', async () => {
  const deps = makeDeps({ isAuthorized: () => true });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

// ── stale fallback / throw handling ──────────────────────────────

test('GET /api/widget/events: one erroring provider falls back to its cached events; syncedAt = oldest', async () => {
  const cachedEv = makeEvent({ id: 'ics-f1-old', calId: 'f1', source: 'Outlook' });
  const freshEv = makeEvent({ id: 'g-1', calId: 'gcal_primary', source: 'Google' });
  const cacheStore = makeMemoryCacheStore({
    ranges: {
      '2026-09-15|2026-09-16': {
        usedAt: '2026-09-13T11:00:00.000Z',
        providers: {
          'ics:Outlook': { syncedAt: '2026-09-13T11:00:00.000Z', events: [cachedEv] },
        },
      },
    },
  });
  const deps = makeDeps({
    cacheStore,
    getUnifiedEvents: async () => ({
      events: [freshEv],
      errors: [{ provider: 'ics:Outlook', message: 'feed timed out' }],
    }),
  });
  deps.now = () => new Date(NOW_ISO);
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 200);
    assert.deepEqual(new Set(body.events.map((e) => e.id)), new Set(['g-1', 'ics-f1-old']));
    assert.deepEqual(body.stale, [{ provider: 'ics:Outlook', syncedAt: '2026-09-13T11:00:00.000Z' }]);
    assert.equal(body.syncedAt, '2026-09-13T11:00:00.000Z');
    assert.deepEqual(body.errors, [{ provider: 'ics:Outlook', message: 'feed timed out' }]);

    const saved = cacheStore._current();
    assert.ok(saved.ranges['2026-09-15|2026-09-16']);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: 200 with every cached provider marked stale when getUnifiedEvents throws', async () => {
  const cachedEv1 = makeEvent({ id: 'ics-f1-old', calId: 'f1', source: 'Outlook' });
  const cachedEv2 = makeEvent({ id: 'g-old', calId: 'gcal_primary', source: 'Google' });
  const cacheStore = makeMemoryCacheStore({
    ranges: {
      '2026-09-15|2026-09-16': {
        usedAt: '2026-09-13T11:00:00.000Z',
        providers: {
          'ics:Outlook': { syncedAt: '2026-09-13T11:00:00.000Z', events: [cachedEv1] },
          gcal_primary: { syncedAt: '2026-09-13T09:00:00.000Z', events: [cachedEv2] },
        },
      },
    },
  });
  const deps = makeDeps({
    cacheStore,
    getUnifiedEvents: async () => { throw new Error('network is down'); },
  });
  deps.now = () => new Date(NOW_ISO);
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 200);
    assert.deepEqual(new Set(body.events.map((e) => e.id)), new Set(['ics-f1-old', 'g-old']));
    assert.deepEqual(
      new Set(body.stale.map((s) => s.provider)),
      new Set(['ics:Outlook', 'gcal_primary'])
    );
    assert.equal(body.syncedAt, '2026-09-13T09:00:00.000Z');
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: 502 when getUnifiedEvents throws and no cache exists for the range', async () => {
  const deps = makeDeps({
    getUnifiedEvents: async () => { throw new Error('network is down'); },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 502);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

// ── cache write concurrency ───────────────────────────────────────

test('GET /api/widget/events: two overlapping requests for different ranges both end up cached (no lost update)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'widget-routes-concurrency-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const realCacheStore = createWidgetCacheStore({ dir });

  // Deterministic stand-in for two requests genuinely overlapping in time.
  let firstLoadDone;
  const firstLoadPromise = new Promise((resolve) => { firstLoadDone = resolve; });
  let loadCount = 0;
  const trackingCacheStore = {
    load: async () => {
      const result = await realCacheStore.load();
      loadCount += 1;
      if (loadCount === 1) firstLoadDone();
      return result;
    },
    save: (cache) => realCacheStore.save(cache),
    mergeRange: (rangeKey, entry, maxRanges) => realCacheStore.mergeRange(rangeKey, entry, maxRanges),
  };

  let callCount = 0;
  let releaseSlow;
  const gateSlow = new Promise((resolve) => { releaseSlow = resolve; });
  const deps = makeDeps({
    cacheStore: trackingCacheStore,
    getUnifiedEvents: async () => {
      callCount += 1;
      if (callCount === 1) await gateSlow; // the first request hangs here
      return { events: [], errors: [] };
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const slowRequest = getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    await firstLoadPromise; // the slow request has read the cache and is now "fetching"

    const { res: fastRes } = await getJson(app.baseUrl, '/api/widget/events?start=2026-10-01&end=2026-10-02');
    assert.equal(fastRes.status, 200);

    releaseSlow();
    const { res: slowRes } = await slowRequest;
    assert.equal(slowRes.status, 200);

    const finalCache = await realCacheStore.load();
    assert.ok(
      finalCache.ranges['2026-09-15|2026-09-16'],
      "the slow request's range is missing from the cache after both requests completed"
    );
    assert.ok(
      finalCache.ranges['2026-10-01|2026-10-02'],
      "the fast request's range was overwritten by the slow request's stale snapshot"
    );
  } finally {
    await app.close();
  }
});

// ── cache read/write failures must not crash the process or hang ────────

test('GET /api/widget/events: cacheStore.load() throwing does not crash the process and still returns the fresh events', async () => {
  const rejections = [];
  const onUnhandledRejection = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandledRejection);
  const deps = makeDeps({
    cacheStore: {
      load: async () => { throw new Error('disk full (load)'); },
      save: async () => {},
      mergeRange: async () => { throw new Error('disk full (mergeRange)'); },
    },
    getUnifiedEvents: async () => ({ events: [makeEvent({ id: 'ics-f1-a' })], errors: [] }),
  });
  const app = await startWidgetTestApp(deps);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let res;
    let body;
    try {
      res = await fetch(`${app.baseUrl}/api/widget/events?start=2026-09-15&end=2026-09-16`, {
        signal: controller.signal,
      });
      body = await res.json();
    } catch (err) {
      assert.fail(
        `request never completed — a cache failure left an unhandled rejection instead of a response (${err.message})`
      );
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(res.status, 200);
    assert.deepEqual(body.events.map((e) => e.id), ['ics-f1-a']);
    assert.deepEqual(rejections, [], 'an unhandled promise rejection escaped the route handler');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await app.close();
  }
});

test('GET /api/widget/events: cacheStore.mergeRange() throwing (a save failure) still returns 200 with the fresh events', async () => {
  const rejections = [];
  const onUnhandledRejection = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandledRejection);
  const deps = makeDeps({
    cacheStore: {
      load: async () => ({ ranges: {} }),
      save: async () => {},
      mergeRange: async () => { throw new Error('disk full (mergeRange)'); },
    },
    getUnifiedEvents: async () => ({ events: [makeEvent({ id: 'ics-f1-b' })], errors: [] }),
  });
  const app = await startWidgetTestApp(deps);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let res;
    let body;
    try {
      res = await fetch(`${app.baseUrl}/api/widget/events?start=2026-09-15&end=2026-09-16`, {
        signal: controller.signal,
      });
      body = await res.json();
    } catch (err) {
      assert.fail(
        `request never completed — a cache save failure left an unhandled rejection instead of a response (${err.message})`
      );
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(res.status, 200);
    assert.deepEqual(body.events.map((e) => e.id), ['ics-f1-b']);
    assert.deepEqual(rejections, [], 'an unhandled promise rejection escaped the route handler');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await app.close();
  }
});

// ── malformed entities must never crash the process ──────────────

test('GET /api/widget/events: an out-of-range numeric HTML entity in location/description does not crash the process', async () => {
  const rejections = [];
  const onUnhandledRejection = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandledRejection);
  const ev = makeEvent({
    id: 'ics-f1-bad-entity',
    location: 'Room &#x110000; A',
    description: 'Notes &#1114112; more &#99999999999; text',
  });
  const deps = makeDeps({ getUnifiedEvents: async () => ({ events: [ev], errors: [] }) });
  const app = await startWidgetTestApp(deps);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let res;
    let body;
    try {
      res = await fetch(`${app.baseUrl}/api/widget/events?start=2026-09-15&end=2026-09-16`, {
        signal: controller.signal,
      });
      body = await res.json();
    } catch (err) {
      assert.fail(`request never completed — the process likely crashed (${err.message})`);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(res.status, 200);
    assert.equal(body.events.length, 1);
    assert.deepEqual(rejections, [], 'an unhandled promise rejection escaped the route handler');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await app.close();
  }
});

test('GET /api/widget/events: 500 JSON (not a crash) when something after query validation throws, e.g. listCalendars', async () => {
  const rejections = [];
  const onUnhandledRejection = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandledRejection);
  const deps = makeDeps({ listCalendars: () => { throw new Error('boom'); } });
  const app = await startWidgetTestApp(deps);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let res;
    let body;
    try {
      res = await fetch(`${app.baseUrl}/api/widget/events?start=2026-09-15&end=2026-09-16`, {
        signal: controller.signal,
      });
      body = await res.json();
    } catch (err) {
      assert.fail(
        `request never completed — a throw after query validation left the request hanging forever instead of a 500 response (${err.message})`
      );
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(res.status, 500);
    assert.equal(typeof body.error, 'string');
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await app.close();
  }
});

// ── getUnifiedEvents call args / timeMin-timeMax / session-like object ──

test('GET /api/widget/events: getUnifiedEvents receives a session-like object and local-midnight timeMin/timeMax', async () => {
  let captured = null;
  const deps = makeDeps({
    getUnifiedEvents: async (session, timeMin, timeMax) => {
      captured = { session, timeMin, timeMax };
      return { events: [], errors: [] };
    },
  });
  deps._state.tokens = { google: { accessToken: 'abc' } };
  const app = await startWidgetTestApp(deps);
  try {
    await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-20');
    assert.deepEqual(captured.session, { tokens: { google: { accessToken: 'abc' } } });
    assert.equal(captured.timeMin, new Date(2026, 8, 15, 0, 0, 0, 0).toISOString());
    assert.equal(captured.timeMax, new Date(2026, 8, 20, 0, 0, 0, 0).toISOString());
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: never touches req.session and never sets a cookie', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const res = await fetch(`${app.baseUrl}/api/widget/events?start=2026-09-15&end=2026-09-16`);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: correctly spans the 2026-10-25 DST fall-back with no off-by-one', async () => {
  let captured = null;
  const deps = makeDeps({
    getUnifiedEvents: async (session, timeMin, timeMax) => {
      captured = { timeMin, timeMax };
      return { events: [], errors: [] };
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-10-20&end=2026-10-30');
    assert.equal(res.status, 200);
    assert.deepEqual(body.range, { start: '2026-10-20', end: '2026-10-30' });
    // Ground truth from the system tzdata for Europe/Ljubljana (CEST -> CET on 2026-10-25).
    assert.equal(captured.timeMin, '2026-10-19T22:00:00.000Z');
    assert.equal(captured.timeMax, '2026-10-29T23:00:00.000Z');
  } finally {
    await app.close();
  }
});

// ── saveTokens only when changed ─────────────────────────────────

test('GET /api/widget/events: saveTokens is not called when tokens are unchanged', async () => {
  let saveCalls = 0;
  const deps = makeDeps({
    getUnifiedEvents: async () => ({ events: [], errors: [] }),
    saveTokens: () => { saveCalls++; },
  });
  deps._state.tokens = { google: { accessToken: 'abc' } };
  const app = await startWidgetTestApp(deps);
  try {
    await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(saveCalls, 0);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: saveTokens is called with the updated tokens when getUnifiedEvents refreshes them', async () => {
  let savedWith = null;
  const deps = makeDeps({
    getUnifiedEvents: async (session) => {
      session.tokens.google.accessToken = 'refreshed';
      return { events: [], errors: [] };
    },
    saveTokens: (tokens) => { savedWith = tokens; },
  });
  deps._state.tokens = { google: { accessToken: 'abc' } };
  const app = await startWidgetTestApp(deps);
  try {
    await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.deepEqual(savedWith, { google: { accessToken: 'refreshed' } });
  } finally {
    await app.close();
  }
});

// ── POST /api/widget/important ──────────────────────────────────

async function postImportant(baseUrl, payload, { raw } = {}) {
  const res = await fetch(`${baseUrl}/api/widget/important`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(payload),
  });
  const body = await res.json();
  return { res, body };
}

test('POST /api/widget/important: marks an event important and returns {id, important}', async () => {
  let calledWith = null;
  const deps = makeDeps({ setEventImportant: (id, important) => { calledWith = { id, important }; } });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postImportant(app.baseUrl, { id: 'ics-f1-a', important: true });
    assert.equal(res.status, 200);
    assert.deepEqual(body, { id: 'ics-f1-a', important: true });
    assert.deepEqual(calledWith, { id: 'ics-f1-a', important: true });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: unmarking sends important: false through', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postImportant(app.baseUrl, { id: 'ics-f1-a', important: false });
    assert.equal(res.status, 200);
    assert.deepEqual(body, { id: 'ics-f1-a', important: false });
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: 400 when id is missing', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postImportant(app.baseUrl, { important: true });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: 400 when id is not a string', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postImportant(app.baseUrl, { id: 123, important: true });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: 400 when id is empty', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postImportant(app.baseUrl, { id: '', important: true });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: 400 when id is longer than 1000 characters', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postImportant(app.baseUrl, { id: 'x'.repeat(1001), important: true });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: an id of exactly 1000 characters is accepted', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postImportant(app.baseUrl, { id: 'x'.repeat(1000), important: true });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: 400 when important is not a boolean', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postImportant(app.baseUrl, { id: 'ics-f1-a', important: 'true' });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: 400 when important is missing', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postImportant(app.baseUrl, { id: 'ics-f1-a' });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: 400 when the body is not an object', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postImportant(app.baseUrl, null, { raw: '"just a string"' });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: a malformed JSON body still gets Cache-Control: no-store', async () => {
  const deps = makeDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const res = await fetch(`${app.baseUrl}/api/widget/important`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json',
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/important: an unauthorized request with a malformed body is rejected 401 (auth is checked before the body is parsed)', async () => {
  const deps = makeDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const res = await fetch(`${app.baseUrl}/api/widget/important`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not valid json',
    });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

// ── what may land in the cache ────────────────────────────────────

const FORBIDDEN_CACHE_FIELDS = ['description', 'location', 'originalUrl', 'caldavCalUrl', 'caldavEventUid'];

test('GET /api/widget/events: the cache write holds reduced events only, while the response keeps full detail', async () => {
  const cacheStore = makeMemoryCacheStore();
  const ev = makeEvent({
    id: 'cdav-1-a',
    calId: 'cdav_1',
    source: 'Work DAV',
    location: 'Room 1',
    description: 'Private minutes. Join: https://meet.google.com/abc-defg-hij',
    originalUrl: 'https://dav.example.org/cal/uid-123.ics',
    caldavCalUrl: 'https://dav.example.org/cal/',
    caldavEventUid: 'uid-123',
    caldavAccountId: 'acct-1',
  });
  const deps = makeDeps({
    cacheStore,
    getUnifiedEvents: async () => ({ events: [ev], errors: [] }),
    listCalendars: () => [{ id: 'cdav_1', name: 'Work DAV', color: '#9333ea' }],
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 200);

    // The live response is built from the fresh fetch and keeps everything.
    assert.equal(body.events[0].location, 'Room 1');
    assert.equal(body.events[0].meetingUrl, 'https://meet.google.com/abc-defg-hij');
    assert.equal(body.events[0].url, 'https://dav.example.org/cal/uid-123.ics');

    const written = JSON.stringify(cacheStore._current());
    for (const field of FORBIDDEN_CACHE_FIELDS) {
      assert.doesNotMatch(written, new RegExp(field), `"${field}" must never reach the cache`);
    }
    assert.doesNotMatch(written, /Private minutes/);
    const cachedEvent = cacheStore._current().ranges['2026-09-15|2026-09-16'].providers['caldav:Work DAV'].events[0];
    assert.deepEqual(Object.keys(cachedEvent).sort(), [
      'id', 'title', 'start', 'end', 'allDay', 'calId', 'color', 'source',
    ].sort());
  } finally {
    await app.close();
  }
});

test('GET /api/widget/events: a stale fallback built from a reduced cached event still renders', async () => {
  const cacheStore = makeMemoryCacheStore({
    ranges: {
      '2026-09-15|2026-09-16': {
        usedAt: '2026-09-13T11:00:00.000Z',
        providers: {
          'ics:Outlook': {
            syncedAt: '2026-09-13T11:00:00.000Z',
            events: [{
              id: 'ics-f1-old',
              title: 'Standup',
              start: '2026-09-15T09:00:00.000Z',
              end: '2026-09-15T09:30:00.000Z',
              allDay: false,
              calId: 'f1',
              color: '#9333ea',
              source: 'Outlook',
            }],
          },
        },
      },
    },
  });
  const deps = makeDeps({
    cacheStore,
    getUnifiedEvents: async () => { throw new Error('network is down'); },
  });
  deps.now = () => new Date(NOW_ISO);
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/events?start=2026-09-15&end=2026-09-16');
    assert.equal(res.status, 200);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].id, 'ics-f1-old');
    assert.equal(body.events[0].title, 'Standup');
    assert.equal(body.events[0].calendar, 'Outlook');
    assert.equal(body.events[0].location, '');
    assert.equal(body.events[0].notes, '');
    assert.equal(body.events[0].meetingUrl, null);
    assert.equal(body.events[0].url, null);
    assert.deepEqual(body.stale, [{ provider: 'ics:Outlook', syncedAt: '2026-09-13T11:00:00.000Z' }]);
  } finally {
    await app.close();
  }
});
