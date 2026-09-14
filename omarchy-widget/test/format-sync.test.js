process.env.TZ = 'Europe/Ljubljana';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadQmlScript } from '../test-support/load-qml-script.js';
import { ev } from '../test-support/fixtures.js';

const modelPath = fileURLToPath(new URL('../plugin/CalendarModel.js', import.meta.url));
function load() {
  return loadQmlScript(modelPath);
}

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

// ---- formatTimeRange -----------------------------------------------------------

test('formatTimeRange: single-day timed event with start and end', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T09:00:00', end: '2026-10-01T10:30:00' });
  assert.equal(m.formatTimeRange(e, '2026-10-01'), '09:00–10:30');
});

test('formatTimeRange: all-day event', () => {
  const m = load();
  const e = ev({ allDay: true, start: '2026-10-01', end: '2026-10-02' });
  assert.equal(m.formatTimeRange(e, '2026-10-01'), 'All day');
});

test('formatTimeRange: single-day timed event with no end shows just the start time', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T09:00:00', end: null });
  assert.equal(m.formatTimeRange(e, '2026-10-01'), '09:00');
});

test('formatTimeRange: an unparsable end is treated as no end, for both timed and all-day events', () => {
  const m = load();
  const timed = ev({ start: '2026-10-01T09:00:00', end: 'not-a-date' });
  assert.equal(m.formatTimeRange(timed, '2026-10-01'), '09:00');
  const allDay = ev({ allDay: true, start: '2026-10-01', end: 'not-a-date' });
  assert.equal(m.formatTimeRange(allDay, '2026-10-01'), 'All day');
});

test('formatTimeRange: multi-day timed event -- "From" on the first day, "Until" on the last, "All day" between', () => {
  const m = load();
  const e = ev({
    start: '2026-10-01T14:00:00',
    end: '2026-10-03T12:00:00',
  });
  assert.equal(m.formatTimeRange(e, '2026-10-01'), 'From 14:00');
  assert.equal(m.formatTimeRange(e, '2026-10-02'), 'All day');
  assert.equal(m.formatTimeRange(e, '2026-10-03'), 'Until 12:00');
});

// ---- DST coverage: formatTimeRange / syncedAgoLabel across both 2026 changes ---

test('formatTimeRange: multi-day timed event crossing the 2026-10-25 fall-back', () => {
  const m = load();
  const e = ev({ start: '2026-10-24T14:00:00', end: '2026-10-26T12:00:00' });
  assert.equal(m.formatTimeRange(e, '2026-10-24'), 'From 14:00');
  assert.equal(m.formatTimeRange(e, '2026-10-25'), 'All day');
  assert.equal(m.formatTimeRange(e, '2026-10-26'), 'Until 12:00');
});

test('formatTimeRange: multi-day timed event crossing the 2026-03-29 spring-forward', () => {
  const m = load();
  const e = ev({ start: '2026-03-28T14:00:00', end: '2026-03-30T12:00:00' });
  assert.equal(m.formatTimeRange(e, '2026-03-28'), 'From 14:00');
  assert.equal(m.formatTimeRange(e, '2026-03-29'), 'All day');
  assert.equal(m.formatTimeRange(e, '2026-03-30'), 'Until 12:00');
});

// ---- formatTimeRange must use the uncapped eventDaySpan for first/last day -

test('formatTimeRange: a timed event past the 62-day cap still shows "From"/"Until" on its real first/last day', () => {
  const m = load();
  const e = ev({ start: '2026-01-01T09:00:00', end: '2026-06-01T10:00:00' });
  assert.equal(m.formatTimeRange(e, '2026-01-01'), 'From 09:00');
  assert.equal(m.formatTimeRange(e, '2026-06-01'), 'Until 10:00');
  // A day well inside the span (also past the cap) still reads "All day".
  assert.equal(m.formatTimeRange(e, '2026-04-15'), 'All day');
});

test('syncedAgoLabel: hours bucket is raw ms difference, unaffected by the 2026-10-25 fall-back', () => {
  const m = load();
  const syncedAt = new Date(2026, 9, 25, 1, 30, 0); // shortly before the ~03:00 transition
  const nowMs = syncedAt.getTime() + 2 * HOUR;
  assert.equal(m.syncedAgoLabel(syncedAt.toISOString(), nowMs), 'synced 2 h ago');
});

// ---- syncedAgoLabel -------------------------------------------------------------

test('syncedAgoLabel: empty/invalid iso returns an empty string', () => {
  const m = load();
  assert.equal(m.syncedAgoLabel('', 0), '');
  assert.equal(m.syncedAgoLabel(null, 0), '');
  assert.equal(m.syncedAgoLabel('garbage', 0), '');
});

test('syncedAgoLabel: under a minute reads "synced just now"', () => {
  const m = load();
  const syncedAt = new Date(2026, 9, 1, 12, 0, 0);
  const nowMs = syncedAt.getTime() + 59999;
  assert.equal(m.syncedAgoLabel(syncedAt.toISOString(), nowMs), 'synced just now');
  assert.equal(m.syncedAgoLabel(syncedAt.toISOString(), syncedAt.getTime()), 'synced just now');
});

test('syncedAgoLabel: minutes bucket, including the lower boundary', () => {
  const m = load();
  const syncedAt = new Date(2026, 9, 1, 12, 0, 0);
  assert.equal(m.syncedAgoLabel(syncedAt.toISOString(), syncedAt.getTime() + MIN), 'synced 1 min ago');
  assert.equal(
    m.syncedAgoLabel(syncedAt.toISOString(), syncedAt.getTime() + HOUR - 1),
    'synced 59 min ago'
  );
});

test('syncedAgoLabel: hours bucket, including the lower boundary', () => {
  const m = load();
  const syncedAt = new Date(2026, 9, 1, 12, 0, 0);
  assert.equal(m.syncedAgoLabel(syncedAt.toISOString(), syncedAt.getTime() + HOUR), 'synced 1 h ago');
  assert.equal(
    m.syncedAgoLabel(syncedAt.toISOString(), syncedAt.getTime() + DAY - 1),
    'synced 23 h ago'
  );
});

test('syncedAgoLabel: days bucket at the lower boundary', () => {
  const m = load();
  const syncedAt = new Date(2026, 9, 1, 12, 0, 0);
  assert.equal(m.syncedAgoLabel(syncedAt.toISOString(), syncedAt.getTime() + DAY), 'synced 1 d ago');
});

test('syncedAgoLabel: clock skew (sync appears in the future) reads "synced just now"', () => {
  const m = load();
  const syncedAt = new Date(2026, 9, 1, 12, 0, 0);
  assert.equal(
    m.syncedAgoLabel(syncedAt.toISOString(), syncedAt.getTime() - 5000),
    'synced just now'
  );
});
