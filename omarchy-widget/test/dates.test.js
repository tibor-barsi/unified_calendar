process.env.TZ = 'Europe/Ljubljana';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadQmlScript } from '../test-support/load-qml-script.js';

const modelPath = fileURLToPath(new URL('../plugin/CalendarModel.js', import.meta.url));
const OMARCHY_MODEL_PATH = '/usr/share/omarchy/shell/plugins/panels/clock/Model.js';
// Cross-checking against Omarchy's own Model.js needs Omarchy installed. Skip
// elsewhere (CI, a non-Omarchy dev box) instead of failing the whole suite.
const NO_OMARCHY = existsSync(OMARCHY_MODEL_PATH)
  ? false
  : `Omarchy not installed (${OMARCHY_MODEL_PATH} missing)`;

function load() {
  return loadQmlScript(modelPath);
}

test('dayKey formats a local date as YYYY-MM-DD, zero-padded', () => {
  const m = load();
  assert.equal(m.dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(m.dayKey(new Date(2026, 9, 25)), '2026-10-25');
  assert.equal(m.dayKey(new Date(2026, 11, 31)), '2026-12-31');
});

test('parseEventDate: YYYY-MM-DD becomes local midnight', () => {
  const m = load();
  const d = m.parseEventDate('2026-10-25');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 25);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test('parseEventDate: full ISO string becomes an instant', () => {
  const m = load();
  const d = m.parseEventDate('2026-10-25T07:30:00.000Z');
  assert.equal(d.getTime(), Date.parse('2026-10-25T07:30:00.000Z'));
});

test('parseEventDate: ISO string with no offset is local (per ES date-time-string spec)', () => {
  const m = load();
  const d = m.parseEventDate('2026-10-01T22:00:00');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 22);
});

test('parseEventDate: invalid inputs return null', () => {
  const m = load();
  assert.equal(m.parseEventDate('not-a-date'), null);
  assert.equal(m.parseEventDate('2026-02-30'), null); // Feb has no 30th
  assert.equal(m.parseEventDate(''), null);
  assert.equal(m.parseEventDate(null), null);
  assert.equal(m.parseEventDate(undefined), null);
  assert.equal(m.parseEventDate(12345), null);
});

// ---- eventDayKeys ---------------------------------------------------------

test('eventDayKeys: all-day end is exclusive', () => {
  const m = load();
  const keys = m.eventDayKeys({ allDay: true, start: '2026-10-01', end: '2026-10-04' });
  assert.deepEqual(keys, ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('eventDayKeys: all-day with missing end is one day', () => {
  const m = load();
  const keys = m.eventDayKeys({ allDay: true, start: '2026-10-01' });
  assert.deepEqual(keys, ['2026-10-01']);
});

test('eventDayKeys: all-day with end <= start is one day', () => {
  const m = load();
  const same = m.eventDayKeys({ allDay: true, start: '2026-10-05', end: '2026-10-05' });
  assert.deepEqual(same, ['2026-10-05']);
  const before = m.eventDayKeys({ allDay: true, start: '2026-10-05', end: '2026-10-01' });
  assert.deepEqual(before, ['2026-10-05']);
});

test('eventDayKeys: timed event ending exactly at local midnight excludes that day', () => {
  const m = load();
  const keys = m.eventDayKeys({
    allDay: false,
    start: '2026-10-01T22:00:00',
    end: '2026-10-02T00:00:00',
  });
  assert.deepEqual(keys, ['2026-10-01']);
});

test('eventDayKeys: timed event ending after local midnight includes the next day', () => {
  const m = load();
  const keys = m.eventDayKeys({
    allDay: false,
    start: '2026-10-01T22:00:00',
    end: '2026-10-02T00:30:00',
  });
  assert.deepEqual(keys, ['2026-10-01', '2026-10-02']);
});

test('eventDayKeys: timed event ending exactly at midnight but on the same day (zero-length) is one day', () => {
  const m = load();
  // Guards against subtracting a day when end === start, both at midnight.
  const keys = m.eventDayKeys({
    allDay: false,
    start: '2026-10-01T00:00:00',
    end: '2026-10-01T00:00:00',
  });
  assert.deepEqual(keys, ['2026-10-01']);
});

test('eventDayKeys: multi-day timed event spans local start date to local end date', () => {
  const m = load();
  const keys = m.eventDayKeys({
    allDay: false,
    start: '2026-10-01T09:00:00',
    end: '2026-10-03T17:00:00',
  });
  assert.deepEqual(keys, ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('eventDayKeys: caps at 62 keys for very long spans', () => {
  const m = load();
  const keys = m.eventDayKeys({ allDay: true, start: '2026-01-01', end: '2027-06-01' });
  assert.equal(keys.length, 62);
  assert.equal(keys[0], '2026-01-01');
});

test('eventDayKeys: DST fall-back 2026-10-25 -- multi-day span crosses it cleanly', () => {
  const m = load();
  const keys = m.eventDayKeys({
    allDay: false,
    start: '2026-10-24T09:00:00',
    end: '2026-10-26T09:00:00',
  });
  assert.deepEqual(keys, ['2026-10-24', '2026-10-25', '2026-10-26']);
});

test('eventDayKeys: DST fall-back 2026-10-25 -- timed event ending at local midnight on the DST day', () => {
  const m = load();
  const keys = m.eventDayKeys({
    allDay: false,
    start: '2026-10-24T22:00:00',
    end: '2026-10-25T00:00:00',
  });
  assert.deepEqual(keys, ['2026-10-24']);
});

test('eventDayKeys: DST spring-forward 2026-03-29 -- multi-day span crosses it cleanly', () => {
  const m = load();
  const keys = m.eventDayKeys({
    allDay: false,
    start: '2026-03-28T09:00:00',
    end: '2026-03-30T09:00:00',
  });
  assert.deepEqual(keys, ['2026-03-28', '2026-03-29', '2026-03-30']);
});

test('eventDayKeys: DST spring-forward 2026-03-29 -- all-day event on the DST day itself', () => {
  const m = load();
  const keys = m.eventDayKeys({ allDay: true, start: '2026-03-29', end: '2026-03-30' });
  assert.deepEqual(keys, ['2026-03-29']);
});

test('eventDayKeys: an unparsable end is treated as no end (timed and all-day both collapse to one day)', () => {
  const m = load();
  const timed = m.eventDayKeys({ allDay: false, start: '2026-10-01T09:00:00', end: 'not-a-date' });
  assert.deepEqual(timed, ['2026-10-01']);
  const allDay = m.eventDayKeys({ allDay: true, start: '2026-10-01', end: 'not-a-date' });
  assert.deepEqual(allDay, ['2026-10-01']);
});

test('eventDayKeys: invalid inputs return an empty array', () => {
  const m = load();
  assert.deepEqual(m.eventDayKeys(null), []);
  assert.deepEqual(m.eventDayKeys(undefined), []);
  assert.deepEqual(m.eventDayKeys({}), []);
  assert.deepEqual(m.eventDayKeys({ start: 'garbage' }), []);
});

// ---- gridRange cross-check against Omarchy's own Model.js -----------------

test('gridRange matches Omarchy Model.monthGrid exactly for every month of 2026-2027, both week starts', { skip: NO_OMARCHY }, () => {
  const m = load();
  const omarchy = loadQmlScript(OMARCHY_MODEL_PATH);

  for (const year of [2026, 2027]) {
    for (let month = 0; month < 12; month++) {
      for (const weekStart of [0, 1]) {
        const weeks = omarchy.monthGrid(year, month, weekStart, '');
        const firstCell = weeks[0].days[0];
        const lastCell = weeks[weeks.length - 1].days[6];
        const expectedStartKey = firstCell.key;
        const dayAfterLast = new Date(lastCell.year, lastCell.month, lastCell.day + 1);
        const expectedEndKey = m.dayKey(dayAfterLast);

        const range = m.gridRange(year, month, weekStart);
        assert.equal(
          m.dayKey(range.start),
          expectedStartKey,
          `start mismatch ${year}-${month}-ws${weekStart}`
        );
        assert.equal(
          m.dayKey(range.end),
          expectedEndKey,
          `end mismatch ${year}-${month}-ws${weekStart}`
        );
      }
    }
  }
});
