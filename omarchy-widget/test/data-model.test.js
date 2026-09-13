process.env.TZ = 'Europe/Ljubljana';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadQmlScript } from '../test-support/load-qml-script.js';
import { ev } from '../test-support/fixtures.js';

const modelPath = fileURLToPath(new URL('../plugin/DataModel.js', import.meta.url));
function load() {
  return loadQmlScript(modelPath);
}

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

// ---- rangeKey ----------------------------------------------------------------

test('rangeKey: joins start and end with a pipe', () => {
  const m = load();
  assert.equal(m.rangeKey('2026-10-01', '2026-10-08'), '2026-10-01|2026-10-08');
});

test('rangeKey: missing/null values become empty strings', () => {
  const m = load();
  assert.equal(m.rangeKey(undefined, null), '|');
});

// ---- buildEventsUrl / buildImportantUrl ---------------------------------------

test('buildEventsUrl: builds the widget events query URL', () => {
  const m = load();
  assert.equal(
    m.buildEventsUrl('http://127.0.0.1:3000', '2026-10-01', '2026-10-08'),
    'http://127.0.0.1:3000/api/widget/events?start=2026-10-01&end=2026-10-08'
  );
});

test('buildEventsUrl: strips a trailing slash from serverUrl', () => {
  const m = load();
  assert.equal(
    m.buildEventsUrl('http://127.0.0.1:3000/', '2026-10-01', '2026-10-08'),
    'http://127.0.0.1:3000/api/widget/events?start=2026-10-01&end=2026-10-08'
  );
});

test('buildImportantUrl: builds the toggle-important URL', () => {
  const m = load();
  assert.equal(m.buildImportantUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/api/widget/important');
  assert.equal(m.buildImportantUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/api/widget/important');
});

// ---- isSafeHttpsUrl ------------------------------------------------------------

test('isSafeHttpsUrl: accepts a plain https URL', () => {
  const m = load();
  assert.equal(m.isSafeHttpsUrl('https://meet.google.com/abc-defg-hij'), true);
});

test('isSafeHttpsUrl: rejects http (not https)', () => {
  const m = load();
  assert.equal(m.isSafeHttpsUrl('http://meet.google.com/abc-defg-hij'), false);
});

test('isSafeHttpsUrl: rejects whitespace or control characters', () => {
  const m = load();
  assert.equal(m.isSafeHttpsUrl('https://example.com/ path'), false);
  assert.equal(m.isSafeHttpsUrl('https://example.com/\tpath'), false);
  assert.equal(m.isSafeHttpsUrl('https://example.com/\npath'), false);
  assert.equal(m.isSafeHttpsUrl('https://example.com/path'), false);
});

test('isSafeHttpsUrl: rejects non-string, empty, schemeless or hostless values', () => {
  const m = load();
  assert.equal(m.isSafeHttpsUrl(null), false);
  assert.equal(m.isSafeHttpsUrl(undefined), false);
  assert.equal(m.isSafeHttpsUrl(''), false);
  assert.equal(m.isSafeHttpsUrl('not a url'), false);
  assert.equal(m.isSafeHttpsUrl('https://'), false);
  assert.equal(m.isSafeHttpsUrl('javascript:alert(1)'), false);
});

// ---- parseSettings --------------------------------------------------------------

test('parseSettings: missing/null settings returns every default', () => {
  const m = load();
  const expected = {
    serverUrl: 'http://127.0.0.1:3000',
    calendars: [],
    reminders: ['1d', '15m'],
    allDayReminderTime: '08:00',
    upcomingDays: 30,
    upcomingMax: 5,
    refreshMinutes: 15,
  };
  assert.deepEqual(m.parseSettings(undefined), expected);
  assert.deepEqual(m.parseSettings(null), expected);
  assert.deepEqual(m.parseSettings({}), expected);
});

test('parseSettings: keeps a valid custom serverUrl and strips a trailing slash', () => {
  const m = load();
  assert.equal(m.parseSettings({ serverUrl: 'https://cal.example.com/' }).serverUrl, 'https://cal.example.com');
});

test('parseSettings: an invalid serverUrl (wrong scheme, whitespace) falls back to the default', () => {
  const m = load();
  assert.equal(m.parseSettings({ serverUrl: 'ftp://127.0.0.1:3000' }).serverUrl, 'http://127.0.0.1:3000');
  assert.equal(m.parseSettings({ serverUrl: 'http://exa mple.com' }).serverUrl, 'http://127.0.0.1:3000');
  assert.equal(m.parseSettings({ serverUrl: 123 }).serverUrl, 'http://127.0.0.1:3000');
});

test('parseSettings: calendars must be an array, and is copied rather than aliased', () => {
  const m = load();
  assert.deepEqual(m.parseSettings({ calendars: 'f1' }).calendars, []);
  const input = { calendars: ['f1', 'Outlook'] };
  const parsed = m.parseSettings(input);
  assert.deepEqual(parsed.calendars, ['f1', 'Outlook']);
  parsed.calendars.push('mutated');
  assert.deepEqual(input.calendars, ['f1', 'Outlook']);
});

test('parseSettings: reminders default when missing, empty or not an array', () => {
  const m = load();
  assert.deepEqual(m.parseSettings({}).reminders, ['1d', '15m']);
  assert.deepEqual(m.parseSettings({ reminders: [] }).reminders, ['1d', '15m']);
  assert.deepEqual(m.parseSettings({ reminders: 'nope' }).reminders, ['1d', '15m']);
});

test('parseSettings: a non-empty reminders array is kept as given', () => {
  const m = load();
  assert.deepEqual(m.parseSettings({ reminders: ['30m'] }).reminders, ['30m']);
});

test('parseSettings: allDayReminderTime falls back only when missing/empty/non-string', () => {
  const m = load();
  assert.equal(m.parseSettings({}).allDayReminderTime, '08:00');
  assert.equal(m.parseSettings({ allDayReminderTime: '' }).allDayReminderTime, '08:00');
  assert.equal(m.parseSettings({ allDayReminderTime: '09:30' }).allDayReminderTime, '09:30');
  // Deliberately not validated as HH:MM here -- CalendarModel.reminderBase
  // already falls back safely on an invalid time.
  assert.equal(m.parseSettings({ allDayReminderTime: 'garbage' }).allDayReminderTime, 'garbage');
});

test('parseSettings: upcomingDays clamps to 1..60 and defaults to 30', () => {
  const m = load();
  assert.equal(m.parseSettings({}).upcomingDays, 30);
  assert.equal(m.parseSettings({ upcomingDays: 0 }).upcomingDays, 1);
  assert.equal(m.parseSettings({ upcomingDays: -5 }).upcomingDays, 1);
  assert.equal(m.parseSettings({ upcomingDays: 90 }).upcomingDays, 60);
  assert.equal(m.parseSettings({ upcomingDays: 14 }).upcomingDays, 14);
  assert.equal(m.parseSettings({ upcomingDays: 'nope' }).upcomingDays, 30);
});

test('parseSettings: upcomingMax clamps to 1..20 and defaults to 5', () => {
  const m = load();
  assert.equal(m.parseSettings({}).upcomingMax, 5);
  assert.equal(m.parseSettings({ upcomingMax: 0 }).upcomingMax, 1);
  assert.equal(m.parseSettings({ upcomingMax: 100 }).upcomingMax, 20);
  assert.equal(m.parseSettings({ upcomingMax: 12 }).upcomingMax, 12);
});

test('parseSettings: refreshMinutes clamps to 5..240 and defaults to 15', () => {
  const m = load();
  assert.equal(m.parseSettings({}).refreshMinutes, 15);
  assert.equal(m.parseSettings({ refreshMinutes: 1 }).refreshMinutes, 5);
  assert.equal(m.parseSettings({ refreshMinutes: 1000 }).refreshMinutes, 240);
  assert.equal(m.parseSettings({ refreshMinutes: 20 }).refreshMinutes, 20);
});

// ---- mergeLoadedRanges -----------------------------------------------------------

test('mergeLoadedRanges: invalid/empty input returns an empty array', () => {
  const m = load();
  assert.deepEqual(m.mergeLoadedRanges(undefined), []);
  assert.deepEqual(m.mergeLoadedRanges(null), []);
  assert.deepEqual(m.mergeLoadedRanges({}), []);
});

test('mergeLoadedRanges: concatenates events from every range', () => {
  const m = load();
  const a = ev({ id: 'a', start: '2026-10-01T09:00:00' });
  const b = ev({ id: 'b', start: '2026-10-02T09:00:00' });
  const ranges = {
    '2026-10-01|2026-10-02': { fetchedAt: 1000, usedAt: 1000, data: { events: [a] } },
    '2026-10-02|2026-10-03': { fetchedAt: 1000, usedAt: 1000, data: { events: [b] } },
  };
  const out = m.mergeLoadedRanges(ranges);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.id).sort(), ['a', 'b']);
});

test('mergeLoadedRanges: dedupes by id+start, keeping the copy from the most recently fetched range', () => {
  const m = load();
  const stale = ev({ id: 'x', start: '2026-10-01T09:00:00', title: 'Stale title' });
  const fresh = ev({ id: 'x', start: '2026-10-01T09:00:00', title: 'Fresh title' });
  const ranges = {
    old: { fetchedAt: 1000, usedAt: 1000, data: { events: [stale] } },
    new: { fetchedAt: 2000, usedAt: 2000, data: { events: [fresh] } },
  };
  const out = m.mergeLoadedRanges(ranges);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Fresh title');
});

test('mergeLoadedRanges: same id but a different start is kept as a distinct event', () => {
  const m = load();
  const moved = ev({ id: 'x', start: '2026-10-01T09:00:00' });
  const original = ev({ id: 'x', start: '2026-10-05T09:00:00' });
  const ranges = {
    a: { fetchedAt: 1000, usedAt: 1000, data: { events: [moved, original] } },
  };
  assert.equal(m.mergeLoadedRanges(ranges).length, 2);
});

test('mergeLoadedRanges: tolerates a range with no/malformed data.events', () => {
  const m = load();
  const ranges = {
    a: { fetchedAt: 1000, usedAt: 1000, data: {} },
    b: { fetchedAt: 1000, usedAt: 1000 },
    c: null,
  };
  assert.deepEqual(m.mergeLoadedRanges(ranges), []);
});

// ---- pruneRanges ------------------------------------------------------------------

test('pruneRanges: keeps the max most-recently-used ranges', () => {
  const m = load();
  const ranges = {
    a: { usedAt: 1000 },
    b: { usedAt: 3000 },
    c: { usedAt: 2000 },
  };
  const out = m.pruneRanges(ranges, 2, []);
  assert.deepEqual(Object.keys(out).sort(), ['b', 'c']);
});

test('pruneRanges: never drops a pinned key, even if it is the least recently used', () => {
  const m = load();
  const ranges = {
    home: { usedAt: 1 },
    a: { usedAt: 5000 },
    b: { usedAt: 4000 },
  };
  const out = m.pruneRanges(ranges, 2, ['home']);
  assert.ok(out.home);
  assert.equal(Object.keys(out).length, 2);
  assert.ok(out.a);
});

test('pruneRanges: within the limit, nothing is dropped', () => {
  const m = load();
  const ranges = { a: { usedAt: 1 }, b: { usedAt: 2 } };
  assert.deepEqual(Object.keys(m.pruneRanges(ranges, 12, [])).sort(), ['a', 'b']);
});

test('pruneRanges: invalid/negative max keeps only pinned keys', () => {
  const m = load();
  const ranges = { home: { usedAt: 1 }, a: { usedAt: 2 } };
  assert.deepEqual(Object.keys(m.pruneRanges(ranges, -1, ['home'])), ['home']);
  assert.deepEqual(Object.keys(m.pruneRanges(ranges, NaN, ['home'])), ['home']);
});

// ---- isRangeStale -----------------------------------------------------------------

test('isRangeStale: a missing range is stale', () => {
  const m = load();
  assert.equal(m.isRangeStale(null, 1000, 15), true);
  assert.equal(m.isRangeStale(undefined, 1000, 15), true);
});

test('isRangeStale: a non-finite fetchedAt is stale', () => {
  const m = load();
  assert.equal(m.isRangeStale({ fetchedAt: 'nope' }, 1000, 15), true);
  assert.equal(m.isRangeStale({}, 1000, 15), true);
});

test('isRangeStale: younger than refreshMinutes is not stale', () => {
  const m = load();
  const now = Date.parse('2026-10-01T09:00:00');
  assert.equal(m.isRangeStale({ fetchedAt: now - 5 * MIN }, now, 15), false);
});

test('isRangeStale: exactly refreshMinutes old is stale (boundary is inclusive)', () => {
  const m = load();
  const now = Date.parse('2026-10-01T09:00:00');
  assert.equal(m.isRangeStale({ fetchedAt: now - 15 * MIN }, now, 15), true);
});

test('isRangeStale: older than refreshMinutes is stale', () => {
  const m = load();
  const now = Date.parse('2026-10-01T09:00:00');
  assert.equal(m.isRangeStale({ fetchedAt: now - HOUR }, now, 15), true);
});

test('isRangeStale: a non-finite nowMs or refreshMinutes is treated as stale', () => {
  const m = load();
  assert.equal(m.isRangeStale({ fetchedAt: 1000 }, NaN, 15), true);
  assert.equal(m.isRangeStale({ fetchedAt: 1000 }, 2000, NaN), true);
});

// ---- reminderSince -------------------------------------------------------------------

test('reminderSince: a recent lastCheckMs is returned unchanged', () => {
  const m = load();
  const now = Date.parse('2026-10-01T09:00:00');
  assert.equal(m.reminderSince(now - 5 * MIN, now), now - 5 * MIN);
});

test('reminderSince: clamps to at most 10 minutes back', () => {
  const m = load();
  const now = Date.parse('2026-10-01T09:00:00');
  assert.equal(m.reminderSince(now - HOUR, now), now - 10 * MIN);
});

test('reminderSince: an invalid lastCheckMs starts the window 1 minute back', () => {
  const m = load();
  const now = Date.parse('2026-10-01T09:00:00');
  assert.equal(m.reminderSince(undefined, now), now - MIN);
  assert.equal(m.reminderSince(NaN, now), now - MIN);
  assert.equal(m.reminderSince('garbage', now), now - MIN);
});

test('reminderSince: a lastCheckMs in the future clamps to now', () => {
  const m = load();
  const now = Date.parse('2026-10-01T09:00:00');
  assert.equal(m.reminderSince(now + HOUR, now), now);
});

// ---- pruneFired -----------------------------------------------------------------------

test('pruneFired: drops entries older than 3 days, keeps the rest', () => {
  const m = load();
  const now = Date.parse('2026-10-10T00:00:00');
  const fired = {
    old: now - 4 * DAY,
    recent: now - 1 * DAY,
  };
  assert.deepEqual(m.pruneFired(fired, now), { recent: now - 1 * DAY });
});

test('pruneFired: exactly 3 days old is kept (only strictly older than 3 days is dropped)', () => {
  const m = load();
  const now = Date.parse('2026-10-10T00:00:00');
  const fired = { boundary: now - 3 * DAY };
  assert.deepEqual(m.pruneFired(fired, now), { boundary: now - 3 * DAY });
});

test('pruneFired: non-finite base values are dropped', () => {
  const m = load();
  const now = Date.parse('2026-10-10T00:00:00');
  assert.deepEqual(m.pruneFired({ bad: 'nope' }, now), {});
});

test('pruneFired: invalid/empty input returns an empty object', () => {
  const m = load();
  assert.deepEqual(m.pruneFired(undefined, 0), {});
  assert.deepEqual(m.pruneFired(null, 0), {});
});

// ---- composeStatus ---------------------------------------------------------------------

test('composeStatus: clean fetch with nothing stale returns an empty string', () => {
  const m = load();
  assert.equal(
    m.composeStatus({ lastFetchOk: true, serverReachable: true, stale: [], errors: [], calendars: [], syncedLabel: 'synced just now' }),
    ''
  );
});

test('composeStatus: server unreachable puts "calendar server unavailable" first, then the synced label', () => {
  const m = load();
  assert.equal(
    m.composeStatus({ lastFetchOk: false, serverReachable: false, stale: [], errors: [], calendars: [], syncedLabel: 'synced 3 h ago' }),
    'calendar server unavailable · synced 3 h ago'
  );
});

test('composeStatus: server unreachable with no synced label yet', () => {
  const m = load();
  assert.equal(
    m.composeStatus({ lastFetchOk: false, serverReachable: false, stale: [], errors: [], calendars: [], syncedLabel: '' }),
    'calendar server unavailable'
  );
});

test('composeStatus: a reachable server with a stale provider puts the synced label first, then "<Name> unavailable"', () => {
  const m = load();
  const calendars = [{ id: 'microsoft', name: 'Outlook', color: '#000000' }];
  assert.equal(
    m.composeStatus({
      lastFetchOk: true,
      serverReachable: true,
      stale: [{ provider: 'microsoft', syncedAt: '2026-10-01T07:00:00.000Z' }],
      errors: [],
      calendars,
      syncedLabel: 'synced 2 h ago',
    }),
    'synced 2 h ago · Outlook unavailable'
  );
});

test('composeStatus: an ics/caldav provider key is shown by the name after its prefix', () => {
  const m = load();
  assert.equal(
    m.composeStatus({
      lastFetchOk: true,
      serverReachable: true,
      stale: [],
      errors: [{ provider: 'ics:Team Feed', message: 'timed out' }],
      calendars: [],
      syncedLabel: 'synced just now',
    }),
    'synced just now · Team Feed unavailable'
  );
});

test('composeStatus: multiple unavailable providers are joined, deduped between stale and errors', () => {
  const m = load();
  const calendars = [{ id: 'microsoft', name: 'Outlook' }];
  assert.equal(
    m.composeStatus({
      lastFetchOk: true,
      serverReachable: true,
      stale: [{ provider: 'microsoft' }],
      errors: [{ provider: 'microsoft' }, { provider: 'ics:Team Feed' }],
      calendars,
      syncedLabel: 'synced 1 h ago',
    }),
    'synced 1 h ago · Outlook unavailable, Team Feed unavailable'
  );
});

test('composeStatus: an unknown provider key with no calendar match falls back to the raw key', () => {
  const m = load();
  assert.equal(
    m.composeStatus({
      lastFetchOk: true,
      serverReachable: true,
      stale: [{ provider: 'gcal_unknown@group.calendar.google.com' }],
      errors: [],
      calendars: [],
      syncedLabel: '',
    }),
    'gcal_unknown@group.calendar.google.com unavailable'
  );
});

// ---- parseResponse ----------------------------------------------------------------------

function validResponse(overrides = {}) {
  return {
    generatedAt: '2026-10-01T09:00:00.000Z',
    range: { start: '2026-10-01', end: '2026-10-08' },
    calendars: [{ id: 'f1', name: 'Outlook', color: '#9333ea' }],
    events: [
      {
        id: 'ev-1',
        title: 'Standup',
        start: '2026-10-01T09:00:00.000Z',
        end: '2026-10-01T09:15:00.000Z',
        allDay: false,
        calId: 'f1',
        calendar: 'Outlook',
        color: '#9333ea',
        location: '',
        notes: '',
        meetingUrl: null,
        url: null,
        important: false,
      },
    ],
    errors: [],
    stale: [],
    syncedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

test('parseResponse: a valid response round-trips its documented fields', () => {
  const m = load();
  const out = m.parseResponse(JSON.stringify(validResponse()));
  assert.equal(out.generatedAt, '2026-10-01T09:00:00.000Z');
  assert.deepEqual(out.range, { start: '2026-10-01', end: '2026-10-08' });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].id, 'ev-1');
  assert.equal(out.syncedAt, '2026-10-01T09:00:00.000Z');
});

test('parseResponse: drops events missing id or start rather than failing the whole response', () => {
  const m = load();
  const response = validResponse({
    events: [
      { id: 'ok', title: 'Kept', start: '2026-10-01T09:00:00.000Z' },
      { title: 'No id', start: '2026-10-01T09:00:00.000Z' },
      { id: 'no-start', title: 'No start' },
      null,
    ],
  });
  const out = m.parseResponse(JSON.stringify(response));
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].id, 'ok');
});

test('parseResponse: invalid JSON returns null', () => {
  const m = load();
  assert.equal(m.parseResponse('{not json'), null);
  assert.equal(m.parseResponse(''), null);
  assert.equal(m.parseResponse(undefined), null);
});

test('parseResponse: a non-object top level (array, string, number) returns null', () => {
  const m = load();
  assert.equal(m.parseResponse('[]'), null);
  assert.equal(m.parseResponse('"hello"'), null);
  assert.equal(m.parseResponse('42'), null);
  assert.equal(m.parseResponse('null'), null);
});

test('parseResponse: missing/mistyped required fields return null', () => {
  const m = load();
  assert.equal(m.parseResponse(JSON.stringify(validResponse({ generatedAt: undefined }))), null);
  assert.equal(m.parseResponse(JSON.stringify(validResponse({ syncedAt: 5 }))), null);
  assert.equal(m.parseResponse(JSON.stringify(validResponse({ range: { start: '2026-10-01' } }))), null);
  assert.equal(m.parseResponse(JSON.stringify(validResponse({ range: 'nope' }))), null);
  assert.equal(m.parseResponse(JSON.stringify(validResponse({ calendars: {} }))), null);
  assert.equal(m.parseResponse(JSON.stringify(validResponse({ events: {} }))), null);
  assert.equal(m.parseResponse(JSON.stringify(validResponse({ errors: 'none' }))), null);
  assert.equal(m.parseResponse(JSON.stringify(validResponse({ stale: null }))), null);
});

// ---- composeStatus: failed star save --------------------------------------------------

test('composeStatus: a failed star save is shown even when the fetch was clean', () => {
  const m = load();
  assert.equal(
    m.composeStatus({ lastFetchOk: true, serverReachable: true, stale: [], errors: [], calendars: [], syncedLabel: 'synced just now', toggleFailed: true }),
    'star not saved'
  );
});

test('composeStatus: a failed star save comes first, ahead of the server status', () => {
  const m = load();
  assert.equal(
    m.composeStatus({ lastFetchOk: false, serverReachable: false, stale: [], errors: [], calendars: [], syncedLabel: 'synced 3 h ago', toggleFailed: true }),
    'star not saved · calendar server unavailable · synced 3 h ago'
  );
  assert.equal(
    m.composeStatus({
      lastFetchOk: true,
      serverReachable: true,
      stale: [{ provider: 'microsoft' }],
      errors: [],
      calendars: [{ id: 'microsoft', name: 'Outlook' }],
      syncedLabel: 'synced 2 h ago',
      toggleFailed: true,
    }),
    'star not saved · synced 2 h ago · Outlook unavailable'
  );
});

test('composeStatus: toggleFailed only counts when it is exactly true', () => {
  const m = load();
  assert.equal(
    m.composeStatus({ lastFetchOk: true, serverReachable: true, stale: [], errors: [], calendars: [], syncedLabel: '', toggleFailed: 'yes' }),
    ''
  );
});

// ---- escapeStyledText ---------------------------------------------------------------------

test('escapeStyledText: escapes &, < and > so markup in user text is shown literally', () => {
  const m = load();
  assert.equal(m.escapeStyledText('<Room 5> & <b>Hall</b>'), '&lt;Room 5&gt; &amp; &lt;b&gt;Hall&lt;/b&gt;');
});

test('escapeStyledText: & is escaped first, so an existing entity is not decoded', () => {
  const m = load();
  assert.equal(m.escapeStyledText('&lt;br&gt;'), '&amp;lt;br&amp;gt;');
});

test('escapeStyledText: missing values become an empty string, others are stringified', () => {
  const m = load();
  assert.equal(m.escapeStyledText(undefined), '');
  assert.equal(m.escapeStyledText(null), '');
  assert.equal(m.escapeStyledText(42), '42');
});

// ---- reminderNotification -------------------------------------------------------------------

const NOTIFY = ['omarchy-notification-send', '-u', 'normal', '-g', '󰃭'];

test('reminderNotification: the heading is the time label followed by the event title', () => {
  const m = load();
  const out = m.reminderNotification({ title: 'In 15 min', body: '09:00–10:30' }, ev({ title: 'Design review' }), '');
  assert.deepEqual(out.argv, [...NOTIFY, 'In 15 min · Design review', '09:00–10:30']);
  assert.equal(out.label, 'In 15 min');
  assert.equal(out.hasMeeting, false);
});

test('reminderNotification: a prefix goes in front of the label, and the label never carries the title', () => {
  const m = load();
  const out = m.reminderNotification({ title: 'In 2 days', body: 'All day' }, ev({ title: 'Kickoff' }), 'Test: ');
  assert.equal(out.argv[5], 'Test: In 2 days · Kickoff');
  assert.equal(out.label, 'Test: In 2 days');
});

test('reminderNotification: the body is escaped for the StyledText notification body', () => {
  const m = load();
  const e = ev({ title: 'Visit', location: '<Room 5> & Co' });
  const out = m.reminderNotification({ title: 'Tomorrow', body: '09:00–10:30 · <Room 5> & Co' }, e, '');
  assert.equal(out.argv[6], '09:00–10:30 · &lt;Room 5&gt; &amp; Co');
});

test('reminderNotification: the heading is not escaped, because Omarchy renders it as plain text', () => {
  const m = load();
  const out = m.reminderNotification({ title: 'Now', body: '09:00–09:30' }, ev({ title: 'R&D <sync>' }), '');
  assert.equal(out.argv[5], 'Now · R&D <sync>');
});

test('reminderNotification: whitespace in the title collapses to single spaces', () => {
  const m = load();
  const out = m.reminderNotification({ title: 'Today', body: 'All day' }, ev({ title: '  Line one\n\tline two  ' }), '');
  assert.equal(out.argv[5], 'Today · Line one line two');
});

test('reminderNotification: an event with no title gets the label alone as its heading', () => {
  const m = load();
  const out = m.reminderNotification({ title: 'In 1 h', body: '10:00–11:00' }, ev({ title: '' }), '');
  assert.equal(out.argv[5], 'In 1 h');
});

test('reminderNotification: a dash-leading title stays behind the label, so it is never read as an option', () => {
  const m = load();
  const out = m.reminderNotification({ title: 'In 15 min', body: '09:00–10:00' }, ev({ title: '-u' }), '');
  assert.equal(out.argv.length, 7);
  assert.equal(out.argv[5], 'In 15 min · -u');
});

test('reminderNotification: no time label, or a label starting with a dash, sends nothing', () => {
  const m = load();
  assert.equal(m.reminderNotification({ title: '', body: 'Room 1' }, ev(), ''), null);
  assert.equal(m.reminderNotification({ title: '', body: 'Room 1' }, ev(), 'Test: '), null);
  assert.equal(m.reminderNotification(null, ev(), 'Test: '), null);
  assert.equal(m.reminderNotification({ title: 'Now', body: '' }, ev(), '-u '), null);
});

test('reminderNotification: a safe https meeting link becomes the click action, anything else is ignored', () => {
  const m = load();
  const text = { title: 'In 15 min', body: '09:00–10:00' };

  const withLink = m.reminderNotification(text, ev({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), '');
  assert.deepEqual(withLink.argv.slice(7), ['--exec', 'xdg-open', 'https://meet.google.com/abc-defg-hij']);
  assert.equal(withLink.hasMeeting, true);

  const insecure = m.reminderNotification(text, ev({ meetingUrl: 'http://meet.google.com/abc-defg-hij' }), '');
  assert.equal(insecure.argv.length, 7);
  assert.equal(insecure.hasMeeting, false);

  const spaced = m.reminderNotification(text, ev({ meetingUrl: 'https://example.com/ --exec rm' }), '');
  assert.equal(spaced.argv.length, 7);
});

// ---- isPrimaryInstance ---------------------------------------------------------------------

test('isPrimaryInstance: only the first live instance is primary', () => {
  const m = load();
  const a = { name: 'a' };
  const b = { name: 'b' };
  assert.equal(m.isPrimaryInstance([a, b], a), true);
  assert.equal(m.isPrimaryInstance([a, b], b), false);
});

test('isPrimaryInstance: with no peer list an instance acts alone and is primary', () => {
  const m = load();
  const a = {};
  assert.equal(m.isPrimaryInstance([], a), true);
  assert.equal(m.isPrimaryInstance(undefined, a), true);
  assert.equal(m.isPrimaryInstance(null, a), true);
});

test('isPrimaryInstance: an instance missing from a non-empty list is not primary', () => {
  const m = load();
  assert.equal(m.isPrimaryInstance([{}, {}], {}), false);
});

// ---- retryDelayMs ---------------------------------------------------------------------

test('retryDelayMs: backs off 30s, 60s, 120s, 300s for the first four failures', () => {
  const m = load();
  assert.equal(m.retryDelayMs(1, 15), 30000);
  assert.equal(m.retryDelayMs(2, 15), 60000);
  assert.equal(m.retryDelayMs(3, 15), 120000);
  assert.equal(m.retryDelayMs(4, 15), 300000);
});

test('retryDelayMs: the fifth failure onward uses refreshMinutes', () => {
  const m = load();
  assert.equal(m.retryDelayMs(5, 15), 15 * MIN);
  assert.equal(m.retryDelayMs(9, 15), 15 * MIN);
});

test('retryDelayMs: never exceeds refreshMinutes * 60000, even for an early step', () => {
  const m = load();
  assert.equal(m.retryDelayMs(4, 1), 1 * MIN);
  assert.equal(m.retryDelayMs(3, 1), 1 * MIN);
});

test('retryDelayMs: invalid consecutiveFailures falls back to 30s', () => {
  const m = load();
  assert.equal(m.retryDelayMs(0, 15), 30000);
  assert.equal(m.retryDelayMs(-1, 15), 30000);
  assert.equal(m.retryDelayMs(NaN, 15), 30000);
  assert.equal(m.retryDelayMs('nope', 15), 30000);
  assert.equal(m.retryDelayMs(undefined, 15), 30000);
});

// ---- nextRetry ------------------------------------------------------------------------

test('nextRetry: the first failure counts and schedules a 30s retry', () => {
  const m = load();
  assert.deepEqual(m.nextRetry(0, false, 15), { failures: 1, schedule: true, delayMs: 30000 });
});

test('nextRetry: a failure while a retry is already scheduled leaves the count and the timer alone', () => {
  const m = load();
  assert.deepEqual(m.nextRetry(2, true, 15), { failures: 2, schedule: false, delayMs: 0 });
});

test('nextRetry: a refresh round with two failing ranges counts once, so retries still step 30s, 60s, 120s, 300s, then refreshMinutes', () => {
  const m = load();
  let failures = 0;
  const delays = [];
  for (let round = 0; round < 6; round += 1) {
    let scheduled = false;
    for (let range = 0; range < 2; range += 1) {
      const next = m.nextRetry(failures, scheduled, 15);
      failures = next.failures;
      if (next.schedule) {
        scheduled = true;
        delays.push(next.delayMs);
      }
    }
  }
  assert.deepEqual(delays, [30000, 60000, 120000, 300000, 15 * MIN, 15 * MIN]);
  assert.equal(failures, 6);
});

test('nextRetry: an invalid count starts again from the first step', () => {
  const m = load();
  for (const bad of [NaN, -3, 'nope', undefined, null]) {
    assert.deepEqual(m.nextRetry(bad, false, 15), { failures: 1, schedule: true, delayMs: 30000 }, String(bad));
  }
});

// ---- enqueueRange ---------------------------------------------------------------------

test('enqueueRange: an empty queue gets the new entry', () => {
  const m = load();
  const entry = { start: '2026-10-01', end: '2026-11-12', key: 'home' };
  assert.deepEqual(m.enqueueRange([], entry, 'home'), [entry]);
});

test('enqueueRange: a newly queued range drops other queued ranges that are not the home range', () => {
  const m = load();
  const home = { start: '2026-10-01', end: '2026-11-12', key: 'home' };
  const stale = { start: '2026-09-01', end: '2026-10-13', key: 'sep' };
  const fresh = { start: '2026-11-01', end: '2026-12-13', key: 'nov' };
  const queue = [home, stale];
  const out = m.enqueueRange(queue, fresh, 'home');
  assert.deepEqual(out.map((r) => r.key), ['home', 'nov']);
});

test('enqueueRange: re-enqueueing the home range keeps it and drops any other pending range', () => {
  const m = load();
  const home = { start: '2026-10-01', end: '2026-11-12', key: 'home' };
  const other = { start: '2026-11-01', end: '2026-12-13', key: 'nov' };
  const out = m.enqueueRange([home, other], home, 'home');
  assert.deepEqual(out.map((r) => r.key), ['home']);
});

test('enqueueRange: re-enqueueing an already-queued key does not duplicate it', () => {
  const m = load();
  const entry = { start: '2026-11-01', end: '2026-12-13', key: 'nov' };
  const out = m.enqueueRange([entry], entry, 'home');
  assert.deepEqual(out, [entry]);
});

test('enqueueRange: a malformed queue is treated as empty', () => {
  const m = load();
  const entry = { start: '2026-10-01', end: '2026-11-12', key: 'home' };
  assert.deepEqual(m.enqueueRange(null, entry, 'home'), [entry]);
  assert.deepEqual(m.enqueueRange(undefined, entry, 'home'), [entry]);
});

// ---- touchUsedAt ---------------------------------------------------------------------

test('touchUsedAt: sets usedAt to nowMs, keeping every other field', () => {
  const m = load();
  const range = { fetchedAt: 1000, usedAt: 1000, data: { events: [] } };
  const out = m.touchUsedAt(range, 5000);
  assert.equal(out.usedAt, 5000);
  assert.equal(out.fetchedAt, 1000);
  assert.equal(out.data, range.data);
});

test('touchUsedAt: does not mutate the input range', () => {
  const m = load();
  const range = { fetchedAt: 1000, usedAt: 1000 };
  m.touchUsedAt(range, 5000);
  assert.equal(range.usedAt, 1000);
});

test('touchUsedAt: a non-finite nowMs leaves usedAt unchanged', () => {
  const m = load();
  const range = { fetchedAt: 1000, usedAt: 1000 };
  assert.equal(m.touchUsedAt(range, NaN).usedAt, 1000);
  assert.equal(m.touchUsedAt(range, undefined).usedAt, 1000);
});

test('touchUsedAt: a non-object range is returned as-is', () => {
  const m = load();
  assert.equal(m.touchUsedAt(null, 5000), null);
  assert.equal(m.touchUsedAt(undefined, 5000), undefined);
});
