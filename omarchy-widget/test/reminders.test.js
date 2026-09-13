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

// ---- parseOffset -------------------------------------------------------------

test('parseOffset: recognized suffixes', () => {
  const m = load();
  assert.equal(m.parseOffset('15m'), 15 * MIN);
  assert.equal(m.parseOffset('1h'), 1 * HOUR);
  assert.equal(m.parseOffset('1d'), 1 * DAY);
  assert.equal(m.parseOffset('2d'), 2 * DAY);
});

test('parseOffset: plain integer means minutes', () => {
  const m = load();
  assert.equal(m.parseOffset('45'), 45 * MIN);
  assert.equal(m.parseOffset('0'), 0);
});

test('parseOffset: invalid inputs return null', () => {
  const m = load();
  assert.equal(m.parseOffset(''), null);
  assert.equal(m.parseOffset(null), null);
  assert.equal(m.parseOffset(undefined), null);
  assert.equal(m.parseOffset('abc'), null);
  assert.equal(m.parseOffset('-5m'), null);
  assert.equal(m.parseOffset('1.5h'), null);
  assert.equal(m.parseOffset('5x'), null);
  assert.equal(m.parseOffset('  '), null);
});

// ---- parseOffsets --------------------------------------------------------------

test('parseOffsets: unique, descending, invalid dropped', () => {
  const m = load();
  assert.deepEqual(m.parseOffsets(['15m', '1d', '15m', 'garbage', '1h']), [DAY, HOUR, 15 * MIN]);
});

test('parseOffsets: empty or not an array falls back to the default', () => {
  const m = load();
  assert.deepEqual(m.parseOffsets([]), [DAY, 15 * MIN]);
  assert.deepEqual(m.parseOffsets(null), [DAY, 15 * MIN]);
  assert.deepEqual(m.parseOffsets(undefined), [DAY, 15 * MIN]);
});

test('parseOffsets: all-invalid list also falls back to the default', () => {
  const m = load();
  assert.deepEqual(m.parseOffsets(['nope', '-3m']), [DAY, 15 * MIN]);
});

// ---- reminderBase ----------------------------------------------------------------

test('reminderBase: timed event uses its start', () => {
  const m = load();
  const e = ev({ allDay: false, start: '2026-10-01T09:30:00' });
  const base = m.reminderBase(e, '08:00');
  assert.equal(base.getTime(), new Date(2026, 9, 1, 9, 30, 0).getTime());
});

test('reminderBase: all-day event uses its start day at the configured time', () => {
  const m = load();
  const e = ev({ allDay: true, start: '2026-10-01', end: '2026-10-02' });
  const base = m.reminderBase(e, '07:15');
  assert.equal(base.getTime(), new Date(2026, 9, 1, 7, 15, 0).getTime());
});

test('reminderBase: invalid allDayTime falls back to 08:00', () => {
  const m = load();
  const e = ev({ allDay: true, start: '2026-10-01', end: '2026-10-02' });
  for (const bad of ['25:99', 'nope', '', null, undefined, '8:1']) {
    const base = m.reminderBase(e, bad);
    assert.equal(
      base.getTime(),
      new Date(2026, 9, 1, 8, 0, 0).getTime(),
      `allDayTime=${JSON.stringify(bad)}`
    );
  }
});

test('reminderBase: invalid event start returns null', () => {
  const m = load();
  assert.equal(m.reminderBase(ev({ start: 'garbage' }), '08:00'), null);
  assert.equal(m.reminderBase(null, '08:00'), null);
});

// ---- dueReminders -------------------------------------------------------------

test('dueReminders: fires when fireAt falls in (sinceMs, nowMs] and base is still in the future', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime(); // event starts 09:00
  const e = ev({ id: 'due-1', important: true, start: new Date(start).toISOString() });
  const offsets = [15 * MIN];

  const fireAt = start - 15 * MIN; // 08:45
  const sinceMs = fireAt - 1000;
  const nowMs = fireAt;

  const due = m.dueReminders([e], offsets, '08:00', sinceMs, nowMs, {});
  assert.equal(due.length, 1);
  assert.equal(due[0].ev.id, 'due-1');
  assert.equal(due[0].offsetMs, 15 * MIN);
  assert.equal(due[0].fireAtMs, fireAt);
  assert.equal(due[0].baseMs, start);
  assert.equal(due[0].key, `due-1|${new Date(start).toISOString()}|${15 * MIN}`);
});

test('dueReminders: sinceMs is exclusive, nowMs is inclusive', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'edge', important: true, start: new Date(start).toISOString() });
  const offsets = [15 * MIN];
  const fireAt = start - 15 * MIN;

  // fireAt === sinceMs -> excluded (exclusive lower bound)
  assert.equal(m.dueReminders([e], offsets, '08:00', fireAt, fireAt + 1000, {}).length, 0);
  // fireAt === nowMs -> included (inclusive upper bound)
  assert.equal(m.dueReminders([e], offsets, '08:00', fireAt - 1000, fireAt, {}).length, 1);
});

test('dueReminders: not due yet when fireAt is still after nowMs', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'not-yet', important: true, start: new Date(start).toISOString() });
  const fireAt = start - 15 * MIN;
  const nowMs = fireAt - 1;
  assert.equal(m.dueReminders([e], [15 * MIN], '08:00', nowMs - 1000, nowMs, {}).length, 0);
});

test('dueReminders: excluded once the base event has already passed', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'passed', important: true, start: new Date(start).toISOString() });
  const nowMs = start + 1; // base already passed
  const due = m.dueReminders([e], [15 * MIN], '08:00', nowMs - DAY, nowMs, {});
  assert.equal(due.length, 0);
});

test('dueReminders: non-important events never fire', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'unimportant', important: false, start: new Date(start).toISOString() });
  const fireAt = start - 15 * MIN;
  const due = m.dueReminders([e], [15 * MIN], '08:00', fireAt - 1000, fireAt, {});
  assert.equal(due.length, 0);
});

test('dueReminders: keys already in firedKeys are skipped (dedupe)', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'dedupe', important: true, start: new Date(start).toISOString() });
  const fireAt = start - 15 * MIN;
  const key = `dedupe|${new Date(start).toISOString()}|${15 * MIN}`;

  const due = m.dueReminders([e], [15 * MIN], '08:00', fireAt - 1000, fireAt, { [key]: true });
  assert.equal(due.length, 0);
});

// ---- coveredKeys: several due offsets of the same occurrence collapse ------

test('dueReminders: a single due offset reports coveredKeys with just its own key', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'single', important: true, start: new Date(start).toISOString() });
  const fireAt = start - 15 * MIN;
  const due = m.dueReminders([e], [15 * MIN], '08:00', fireAt - 1000, fireAt, {});
  assert.equal(due.length, 1);
  assert.deepEqual(due[0].coveredKeys, [due[0].key]);
});

test('dueReminders: a long gap covering both the 1d and 15m offsets returns one entry (the smaller offset) with both keys covered', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'long-gap', important: true, start: new Date(start).toISOString() });
  const keyDay = `long-gap|${new Date(start).toISOString()}|${DAY}`;
  const key15m = `long-gap|${new Date(start).toISOString()}|${15 * MIN}`;

  // Poll resumes after both the 1d and 15m fireAt instants, before the event starts.
  const sinceMs = start - DAY - 1000;
  const nowMs = start - 5 * MIN;
  const due = m.dueReminders([e], [DAY, 15 * MIN], '08:00', sinceMs, nowMs, {});

  assert.equal(due.length, 1);
  assert.equal(due[0].offsetMs, 15 * MIN);
  assert.equal(due[0].key, key15m);
  assert.equal(due[0].coveredKeys.length, 2);
  assert.ok(due[0].coveredKeys.includes(keyDay));
  assert.ok(due[0].coveredKeys.includes(key15m));
});

// ---- offset 0 ("at start") fires at the start instant itself --------------

test('dueReminders: offset 0 ("at start") fires once the start itself falls in the poll window', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'at-start', important: true, start: new Date(start).toISOString() });

  // Poll window entirely before the start instant: not due yet.
  const before = m.dueReminders([e], [0], '08:00', start - 2000, start - 1000, {});
  assert.equal(before.length, 0);

  // Poll window whose upper edge is exactly the start instant: due.
  const due = m.dueReminders([e], [0], '08:00', start - 1000, start, {});
  assert.equal(due.length, 1);
  assert.equal(due[0].ev.id, 'at-start');
  assert.equal(due[0].offsetMs, 0);
  assert.equal(due[0].fireAtMs, start);
  assert.equal(due[0].baseMs, start);
  assert.equal(due[0].key, `at-start|${new Date(start).toISOString()}|0`);

  // The next poll window starts exactly at the start instant (sinceMs exclusive), so not due again.
  const after = m.dueReminders([e], [0], '08:00', start, start + 1000, {});
  assert.equal(after.length, 0);
});

test('dueReminders: offset 0 and a positive offset on the same event fire independently', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'mixed', important: true, start: new Date(start).toISOString() });
  const offsets = [15 * MIN, 0];

  // 15 min before start: only the 15m offset is due (the 0 offset's fireAt is still in the future).
  const preStart = m.dueReminders([e], offsets, '08:00', start - 15 * MIN - 1000, start - 15 * MIN, {});
  assert.equal(preStart.length, 1);
  assert.equal(preStart[0].offsetMs, 15 * MIN);

  // At the start instant: only the 0 offset is due (the 15m offset fired in an earlier window).
  const atStart = m.dueReminders([e], offsets, '08:00', start - 1000, start, {});
  assert.equal(atStart.length, 1);
  assert.equal(atStart[0].offsetMs, 0);
});

// ---- DST coverage: dueReminders is pure ms arithmetic across both 2026 changes --

test('dueReminders: all-day 1-day reminder window crossing the 2026-10-25 fall-back', () => {
  const m = load();
  const e = ev({
    id: 'dst-fallback',
    allDay: true,
    important: true,
    start: '2026-10-26',
    end: '2026-10-27',
  });
  const expectedBase = new Date(2026, 9, 26, 8, 0, 0).getTime();
  assert.equal(m.reminderBase(e, '08:00').getTime(), expectedBase);

  const fireAtMs = expectedBase - DAY; // 1-day offset, pure ms subtraction across the fall-back
  const before = new Date(2026, 9, 25, 0, 0, 0).getTime(); // a few hours before the ~03:00 transition
  assert.equal(m.dueReminders([e], [DAY], '08:00', before - 1000, before, {}).length, 0);
  // fireAt itself (a few hours after the transition): due, upper bound inclusive.
  assert.equal(m.dueReminders([e], [DAY], '08:00', fireAtMs - 1000, fireAtMs, {}).length, 1);
  const after = new Date(2026, 9, 25, 12, 0, 0).getTime();
  assert.equal(m.dueReminders([e], [DAY], '08:00', fireAtMs + 1, after, {}).length, 0);
});

test('dueReminders: all-day 1-day reminder window crossing the 2026-03-29 spring-forward', () => {
  const m = load();
  const e = ev({
    id: 'dst-springfwd',
    allDay: true,
    important: true,
    start: '2026-03-30',
    end: '2026-03-31',
  });
  const expectedBase = new Date(2026, 2, 30, 8, 0, 0).getTime();
  assert.equal(m.reminderBase(e, '08:00').getTime(), expectedBase);

  const fireAtMs = expectedBase - DAY;
  const before = new Date(2026, 2, 29, 0, 0, 0).getTime(); // a few hours before the ~03:00 transition
  assert.equal(m.dueReminders([e], [DAY], '08:00', before - 1000, before, {}).length, 0);
  assert.equal(m.dueReminders([e], [DAY], '08:00', fireAtMs - 1000, fireAtMs, {}).length, 1);
  const after = new Date(2026, 2, 29, 12, 0, 0).getTime();
  assert.equal(m.dueReminders([e], [DAY], '08:00', fireAtMs + 1, after, {}).length, 0);
});

// ---- reminderText --------------------------------------------------------------

test('reminderText: "In 15 min" example with a room location', () => {
  const m = load();
  const e = ev({
    start: '2026-10-01T09:00:00',
    end: '2026-10-01T10:30:00',
    location: 'Room 1',
  });
  const nowMs = new Date(2026, 9, 1, 8, 45, 0).getTime();
  const { title, body } = m.reminderText(e, 15 * MIN, '08:00', nowMs);
  assert.equal(title, 'In 15 min');
  assert.equal(body, '09:00–10:30 · Room 1');
});

test('reminderText: "Tomorrow" example, no location', () => {
  const m = load();
  const e = ev({ start: '2026-10-02T09:00:00', end: '2026-10-02T10:30:00', location: '' });
  const nowMs = new Date(2026, 9, 1, 9, 0, 0).getTime(); // today is Oct 1, event is Oct 2
  const { title, body } = m.reminderText(e, DAY, '08:00', nowMs);
  assert.equal(title, 'Tomorrow');
  assert.equal(body, '09:00–10:30');
});

test('reminderText: "Today · All day" example', () => {
  const m = load();
  const e = ev({ allDay: true, start: '2026-10-01', end: '2026-10-02', location: '' });
  const nowMs = new Date(2026, 9, 1, 7, 45, 0).getTime();
  const { title, body } = m.reminderText(e, 15 * MIN, '08:00', nowMs);
  assert.equal(title, 'Today');
  assert.equal(body, 'All day');
});

test('reminderText: hour-scale offset formats as "In N h"', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T09:00:00', end: '2026-10-01T10:00:00' });
  const nowMs = new Date(2026, 9, 1, 8, 0, 0).getTime();
  const { title } = m.reminderText(e, HOUR, '08:00', nowMs);
  assert.equal(title, 'In 1 h');
});

test('reminderText: day-scale offset several days out reads "In N days"', () => {
  const m = load();
  const e = ev({ start: '2026-10-04T09:00:00', end: '2026-10-04T10:00:00' });
  const nowMs = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const { title } = m.reminderText(e, DAY, '08:00', nowMs);
  assert.equal(title, 'In 3 days');
});

// ---- reminderText: label reflects time actually left, not the offset -----

test('reminderText: offset 0 for a timed event reads "Now"', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T09:00:00', end: '2026-10-01T10:30:00', location: 'Room 1' });
  const nowMs = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const { title, body } = m.reminderText(e, 0, '08:00', nowMs);
  assert.equal(title, 'Now');
  assert.equal(body, '09:00–10:30 · Room 1');
});

test('reminderText: offset 0 for an all-day event reads "Today · All day"', () => {
  const m = load();
  const e = ev({ allDay: true, start: '2026-10-01', end: '2026-10-02', location: '' });
  const nowMs = new Date(2026, 9, 1, 8, 0, 0).getTime(); // reminderBase for '08:00'
  const { title, body } = m.reminderText(e, 0, '08:00', nowMs);
  assert.equal(title, 'Today');
  assert.equal(body, 'All day');
});

test('reminderText: a 15-min reminder delivered late (2 min before start) reads "In 2 min"', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T09:00:00', end: '2026-10-01T10:30:00', location: '' });
  const nowMs = new Date(2026, 9, 1, 8, 58, 0).getTime(); // 2 min before start
  const { title } = m.reminderText(e, 15 * MIN, '08:00', nowMs);
  assert.equal(title, 'In 2 min');
});

test('reminderText: a 1-day reminder delivered late on the event\'s own day reads "Today"', () => {
  const m = load();
  const e = ev({ allDay: true, start: '2026-10-01', end: '2026-10-02', location: '' });
  const nowMs = new Date(2026, 9, 1, 15, 0, 0).getTime(); // well after the 08:00 base, still the event's own day
  const { title, body } = m.reminderText(e, DAY, '08:00', nowMs);
  assert.equal(title, 'Today');
  assert.equal(body, 'All day');
});

test('reminderText: "Now" also covers slightly past start', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T09:00:00', end: '2026-10-01T10:30:00', location: '' });
  const nowMs = new Date(2026, 9, 1, 9, 0, 30).getTime(); // 30s past start
  const { title } = m.reminderText(e, 0, '08:00', nowMs);
  assert.equal(title, 'Now');
});

test('reminderText: a timed reminder delivered days late reads "Overdue" (matches the all-day path)', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T09:00:00', end: '2026-10-01T10:00:00', location: '' });
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const nowMs = start + 3 * DAY;
  const { title, body } = m.reminderText(e, 0, '08:00', nowMs);
  assert.equal(title, 'Overdue');
  assert.equal(body, '09:00–10:00');
});

test('reminderText: a timed reminder delivered well past start but still the same day reads "Today"', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T09:00:00', end: '2026-10-01T10:00:00', location: '' });
  const nowMs = new Date(2026, 9, 1, 20, 0, 0).getTime(); // 11h after start, still Oct 1
  const { title } = m.reminderText(e, 0, '08:00', nowMs);
  assert.equal(title, 'Today');
});

test('reminderText: remaining time crossing midnight reads "Tomorrow" even under 24h', () => {
  const m = load();
  const e = ev({ start: '2026-10-02T01:00:00', end: '2026-10-02T02:00:00', location: '' });
  const nowMs = new Date(2026, 9, 1, 23, 0, 0).getTime(); // 2h left, but the event is tomorrow
  const { title } = m.reminderText(e, DAY, '08:00', nowMs);
  assert.equal(title, 'Tomorrow');
});

// ---- intradayHourLabel: real (non-exact) poll delays must still round sensibly ---

test('intradayHourLabel: rounds to the nearest whole hour or minute for real (non-exact) delays', () => {
  const m = load();
  // +/- 20s around 1h
  assert.equal(m.intradayHourLabel(HOUR - 20 * 1000), 'In 1 h');
  assert.equal(m.intradayHourLabel(HOUR + 20 * 1000), 'In 1 h');
  // +/- 20s around 2h
  assert.equal(m.intradayHourLabel(2 * HOUR - 20 * 1000), 'In 2 h');
  assert.equal(m.intradayHourLabel(2 * HOUR + 20 * 1000), 'In 2 h');
  // 59m50s left -- rounding to 60 min must bump to the next hour, not read "In 60 min"
  assert.equal(m.intradayHourLabel(59 * MIN + 50 * 1000), 'In 1 h');
  // 5h03m left
  assert.equal(m.intradayHourLabel(5 * HOUR + 3 * MIN), 'In 5 h');
});

test('reminderText: a late same-day 1-day reminder rounds remaining time to whole hours ("In 9 h")', () => {
  const m = load();
  const e = ev({ start: '2026-10-01T18:00:00', end: '2026-10-01T19:00:00', location: '' });
  const nowMs = new Date(2026, 9, 1, 9, 0, 13).getTime(); // 8h59m47s left
  const { title } = m.reminderText(e, DAY, '08:00', nowMs);
  assert.equal(title, 'In 9 h');
});

// ---- dueReminders: offset 0 alongside a positive offset must not double-notify ---

test('dueReminders: resuming 20s before start covers the offset-0 key so "Now" is not sent again after start', () => {
  const m = load();
  const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
  const e = ev({ id: 'resume-case', important: true, start: new Date(start).toISOString() });
  const offsets = [15 * MIN, 0];
  const key15m = `resume-case|${new Date(start).toISOString()}|${15 * MIN}`;
  const key0 = `resume-case|${new Date(start).toISOString()}|0`;

  // Poll 1: widget resumes 20s before start, having been suspended well before the 15m offset fired.
  const nowMs1 = start - 20 * 1000;
  const due1 = m.dueReminders([e], offsets, '08:00', start - 2 * DAY, nowMs1, {});
  assert.equal(due1.length, 1);
  assert.equal(due1[0].offsetMs, 15 * MIN);
  assert.ok(due1[0].coveredKeys.includes(key15m));
  assert.ok(due1[0].coveredKeys.includes(key0));

  // Simulate the caller marking every covered key as fired.
  const fired = {};
  for (const k of due1[0].coveredKeys) fired[k] = true;

  // Poll 2: crosses the start instant -- the 0-offset key must not fire a second time.
  const due2 = m.dueReminders([e], offsets, '08:00', nowMs1, start + 5000, fired);
  assert.equal(due2.length, 0);
});

// ---- reminderText: trimming a long location must stay linear, not quadratic --------

test('reminderText: a long inner whitespace run in the location stays fast (median of several runs)', () => {
  const m = load();
  const location = 'a' + ' '.repeat(20000) + 'b';
  const e = ev({ start: '2026-10-01T09:00:00', end: '2026-10-01T10:30:00', location });
  const nowMs = new Date(2026, 9, 1, 8, 45, 0).getTime();

  const durations = [];
  for (let i = 0; i < 7; i++) {
    const t0 = process.hrtime.bigint();
    m.reminderText(e, 15 * MIN, '08:00', nowMs);
    durations.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  assert.ok(median < 5, `median ${median}ms was not under 5ms`);
});
