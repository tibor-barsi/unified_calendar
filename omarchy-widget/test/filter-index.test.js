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

// ---- filterByCalendars -----------------------------------------------------

test('filterByCalendars: missing/empty/non-array setting returns all events', () => {
  const m = load();
  const events = [ev({ calId: 'f1' }), ev({ calId: 'f2' })];
  assert.equal(m.filterByCalendars(events, undefined, []).length, 2);
  assert.equal(m.filterByCalendars(events, [], []).length, 2);
  assert.equal(m.filterByCalendars(events, 'f1', []).length, 2);
  assert.equal(m.filterByCalendars(events, null, []).length, 2);
});

test('filterByCalendars: matches by calId, case-insensitively', () => {
  const m = load();
  const events = [ev({ calId: 'f1' }), ev({ calId: 'f2' })];
  const out = m.filterByCalendars(events, ['F1'], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].calId, 'f1');
});

test('filterByCalendars: matches by calendar name, case-insensitively', () => {
  const m = load();
  const events = [
    ev({ calId: 'f1', calendar: 'Outlook' }),
    ev({ calId: 'f2', calendar: 'Home' }),
  ];
  const out = m.filterByCalendars(events, ['outlook'], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].calendar, 'Outlook');
});

test('filterByCalendars: resolves a setting name against the calendars list to also match by id', () => {
  const m = load();
  // ev.calendar fell back to the raw provider source; the calendars list is what still resolves it by name.
  const events = [ev({ calId: 'f2', calendar: 'raw-source-label' })];
  const calendars = [{ id: 'f2', name: 'Team' }];
  const out = m.filterByCalendars(events, ['team'], calendars);
  assert.equal(out.length, 1);
});

test('filterByCalendars: non-matching entries are dropped', () => {
  const m = load();
  const events = [ev({ calId: 'f1' }), ev({ calId: 'f2' })];
  const out = m.filterByCalendars(events, ['nope'], []);
  assert.equal(out.length, 0);
});

// ---- a literal "__proto__" calId/name must not alias Object.prototype -----

test('filterByCalendars: an event calId literally "__proto__" is not treated as an inherited match', () => {
  const m = load();
  const events = [ev({ id: 'wanted', calId: 'f1' }), ev({ id: 'leaked', calId: '__proto__' })];
  const out = m.filterByCalendars(events, ['f1'], []);
  assert.deepEqual(
    out.map((e) => e.id),
    ['wanted']
  );
});

test('filterByCalendars: a calendar name literally "__proto__" does not leak through allowedCalIds', () => {
  const m = load();
  const events = [ev({ id: 'leaked', calId: 'f2', calendar: 'raw-source-label' })];
  const calendars = [{ id: 'f2', name: '__proto__' }];
  // Nothing in `setting` names "__proto__" or "f2" -- this must match nothing.
  const out = m.filterByCalendars(events, ['team'], calendars);
  assert.equal(out.length, 0);
});

// ---- indexByDay -------------------------------------------------------------

test('indexByDay: groups by every day key an event occupies', () => {
  const m = load();
  const multiDay = ev({
    id: 'multi',
    allDay: false,
    start: '2026-10-01T09:00:00',
    end: '2026-10-02T17:00:00',
  });
  const index = m.indexByDay([multiDay]);
  assert.ok(Array.isArray(index['2026-10-01']));
  assert.ok(Array.isArray(index['2026-10-02']));
});

test('indexByDay: sorts all-day before timed, then by start time, then by title', () => {
  const m = load();
  const timedLate = ev({
    id: 'timed-late',
    title: 'Zzz',
    allDay: false,
    start: '2026-10-01T14:00:00',
    end: '2026-10-01T15:00:00',
  });
  const timedEarlyB = ev({
    id: 'timed-early-b',
    title: 'Bravo',
    allDay: false,
    start: '2026-10-01T09:00:00',
    end: '2026-10-01T10:00:00',
  });
  const timedEarlyA = ev({
    id: 'timed-early-a',
    title: 'Alpha',
    allDay: false,
    start: '2026-10-01T09:00:00',
    end: '2026-10-01T10:00:00',
  });
  const allDay = ev({
    id: 'allday',
    title: 'Zzz all day',
    allDay: true,
    start: '2026-10-01',
    end: '2026-10-02',
  });

  const index = m.indexByDay([timedLate, timedEarlyB, timedEarlyA, allDay]);
  const ids = index['2026-10-01'].map((e) => e.id);
  assert.deepEqual(ids, ['allday', 'timed-early-a', 'timed-early-b', 'timed-late']);
});

test('indexByDay: invalid input returns an empty index', () => {
  const m = load();
  assert.deepEqual(m.indexByDay(null), {});
  assert.deepEqual(m.indexByDay(undefined), {});
});

// ---- dayInfo -----------------------------------------------------------------

test('dayInfo: counts, caps dots at 3, flags important, flags spent', () => {
  const m = load();
  const events = [
    ev({ id: 'a', allDay: true, start: '2026-10-01', end: '2026-10-02' }),
    ev({ id: 'b', allDay: true, start: '2026-10-01', end: '2026-10-02' }),
    ev({ id: 'c', allDay: true, start: '2026-10-01', end: '2026-10-02', important: true }),
    ev({ id: 'd', allDay: true, start: '2026-10-01', end: '2026-10-02' }),
  ];
  const index = m.indexByDay(events);

  const info = m.dayInfo(index, '2026-10-01', '2026-10-05');
  assert.equal(info.key, '2026-10-01');
  assert.equal(info.count, 4);
  assert.equal(info.dots, 3);
  assert.equal(info.important, true);
  assert.equal(info.spent, true);

  const future = m.dayInfo(index, '2026-10-01', '2026-09-30');
  assert.equal(future.spent, false);
});

test('dayInfo: empty day has zero count, zero dots, not important, not spent when today', () => {
  const m = load();
  const index = m.indexByDay([]);
  const info = m.dayInfo(index, '2026-10-01', '2026-10-01');
  assert.equal(info.count, 0);
  assert.equal(info.dots, 0);
  assert.equal(info.important, false);
  assert.equal(info.spent, false);
});
