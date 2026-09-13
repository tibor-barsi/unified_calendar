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

const MS_PER_DAY = 86400000;

// ---- upcomingImportant ------------------------------------------------------

test('upcomingImportant: only important, not-ended events within the window are counted', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 1, 12, 0, 0).getTime(); // 2026-10-01 12:00 local

  const events = [
    ev({ id: 'not-important', important: false, start: '2026-10-02T09:00:00' }),
    ev({
      id: 'already-ended',
      important: true,
      start: '2026-10-01T08:00:00',
      end: '2026-10-01T09:00:00',
    }),
    ev({
      id: 'ongoing',
      important: true,
      start: '2026-10-01T11:00:00',
      end: '2026-10-01T13:00:00',
    }),
    ev({
      id: 'soon',
      important: true,
      start: '2026-10-02T09:00:00',
      end: '2026-10-02T10:00:00',
    }),
    ev({
      id: 'far-future',
      important: true,
      start: '2026-12-01T09:00:00',
      end: '2026-12-01T10:00:00',
    }),
  ];

  const { total, items } = m.upcomingImportant(events, nowMs, 30, 5);
  const ids = items.map((e) => e.id);
  assert.ok(ids.includes('ongoing'));
  assert.ok(ids.includes('soon'));
  assert.ok(!ids.includes('not-important'));
  assert.ok(!ids.includes('already-ended'));
  assert.ok(!ids.includes('far-future'));
  assert.equal(total, 2);
});

test('upcomingImportant: sorts by start ascending', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 1, 0, 0, 0).getTime();
  const events = [
    ev({ id: 'later', important: true, start: '2026-10-05T09:00:00' }),
    ev({ id: 'earlier', important: true, start: '2026-10-02T09:00:00' }),
  ];
  const { items } = m.upcomingImportant(events, nowMs, 30, 5);
  assert.deepEqual(
    items.map((e) => e.id),
    ['earlier', 'later']
  );
});

test('upcomingImportant: respects the max cap but reports the full total', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 1, 0, 0, 0).getTime();
  const events = [1, 2, 3, 4, 5].map((n) =>
    ev({ id: `e${n}`, important: true, start: `2026-10-0${n}T09:00:00` })
  );
  const { total, items } = m.upcomingImportant(events, nowMs, 30, 2);
  assert.equal(total, 5);
  assert.equal(items.length, 2);
});

test('upcomingImportant: window edge -- start exactly at now+days is excluded, 1ms before is included', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 1, 0, 0, 0).getTime();
  const cutoff = nowMs + 5 * MS_PER_DAY;

  const atEdge = ev({
    id: 'at-edge',
    important: true,
    start: new Date(cutoff).toISOString(),
  });
  const justInside = ev({
    id: 'just-inside',
    important: true,
    start: new Date(cutoff - 1).toISOString(),
  });

  const { items } = m.upcomingImportant([atEdge, justInside], nowMs, 5, 10);
  const ids = items.map((e) => e.id);
  assert.ok(!ids.includes('at-edge'));
  assert.ok(ids.includes('just-inside'));
});

// ---- a NaN/negative "days" must not silently disable the window filter ----

test('upcomingImportant: NaN/undefined "days" does not let an arbitrarily-far-future event count as upcoming', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 1, 0, 0, 0).getTime();
  const farFuture = ev({ id: 'far-future', important: true, start: '2030-01-01T09:00:00' });
  assert.equal(m.upcomingImportant([farFuture], nowMs, NaN, 10).total, 0);
  assert.equal(m.upcomingImportant([farFuture], nowMs, undefined, 10).total, 0);
});

test('upcomingImportant: a negative "days" is clamped to 0, not left to push the cutoff further into the past', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 1, 12, 0, 0).getTime(); // 2026-10-01 12:00 local
  const ongoing = ev({
    id: 'ongoing',
    important: true,
    start: '2026-10-01T10:00:00', // started 2h before now
    end: '2026-10-01T14:00:00', // still running
  });
  // An unclamped negative days would push the cutoff into the past and wrongly drop this event.
  assert.equal(m.upcomingImportant([ongoing], nowMs, -5, 10).total, 1);
});

test('upcomingImportant: all-day event counts as not-ended until the end of its last day', () => {
  const m = load();
  const allDay = ev({
    id: 'allday',
    allDay: true,
    important: true,
    start: '2026-10-01',
    end: '2026-10-02',
  });

  const beforeEnd = new Date(2026, 9, 1, 23, 0, 0).getTime();
  const afterEnd = new Date(2026, 9, 2, 0, 0, 1).getTime();

  assert.equal(m.upcomingImportant([allDay], beforeEnd, 30, 5).items.length, 1);
  assert.equal(m.upcomingImportant([allDay], afterEnd, 30, 5).items.length, 0);
});

test('upcomingImportant: an invalid "max" (NaN, undefined, -1) yields no items but the total is still correct', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 1, 0, 0, 0).getTime();
  const events = [1, 2].map((n) =>
    ev({ id: `e${n}`, important: true, start: `2026-10-0${n}T09:00:00` })
  );
  for (const badMax of [NaN, undefined, -1]) {
    const { total, items } = m.upcomingImportant(events, nowMs, 30, badMax);
    assert.equal(total, 2, `max=${badMax}`);
    assert.equal(items.length, 0, `max=${badMax}`);
  }
});

// ---- clockMarkVisible --------------------------------------------------------

test('clockMarkVisible: true for an important all-day event covering today, before day end', () => {
  const m = load();
  const allDay = ev({ allDay: true, important: true, start: '2026-10-01', end: '2026-10-02' });
  const nowMs = new Date(2026, 9, 1, 10, 0, 0).getTime();
  assert.equal(m.clockMarkVisible([allDay], nowMs), true);
});

test('clockMarkVisible: false once the all-day event day has ended', () => {
  const m = load();
  const allDay = ev({ allDay: true, important: true, start: '2026-10-01', end: '2026-10-02' });
  const nowMs = new Date(2026, 9, 2, 0, 0, 1).getTime();
  assert.equal(m.clockMarkVisible([allDay], nowMs), false);
});

test('clockMarkVisible: true for a timed important event today before it ends, false after', () => {
  const m = load();
  const timed = ev({
    important: true,
    start: '2026-10-01T09:00:00',
    end: '2026-10-01T10:00:00',
  });
  const before = new Date(2026, 9, 1, 9, 30, 0).getTime();
  const after = new Date(2026, 9, 1, 10, 0, 1).getTime();
  assert.equal(m.clockMarkVisible([timed], before), true);
  assert.equal(m.clockMarkVisible([timed], after), false);
});

test('clockMarkVisible: false for a non-important event even if today and ongoing', () => {
  const m = load();
  const timed = ev({
    important: false,
    start: '2026-10-01T09:00:00',
    end: '2026-10-01T10:00:00',
  });
  const now = new Date(2026, 9, 1, 9, 30, 0).getTime();
  assert.equal(m.clockMarkVisible([timed], now), false);
});

test('clockMarkVisible: false for an important event that does not touch today', () => {
  const m = load();
  const timed = ev({
    important: true,
    start: '2026-10-05T09:00:00',
    end: '2026-10-05T10:00:00',
  });
  const now = new Date(2026, 9, 1, 9, 30, 0).getTime();
  assert.equal(m.clockMarkVisible([timed], now), false);
});

// ---- eventEndMs must not derive from the capped eventDayKeys array --------

test('clockMarkVisible: true for a long all-day event still running well past the 62-day day-key cap', () => {
  const m = load();
  // Real span: 2026-01-01 .. 2026-06-01 (151 days), far beyond the 62-day cap.
  const milestone = ev({
    id: 'milestone',
    allDay: true,
    important: true,
    start: '2026-01-01',
    end: '2026-06-01',
  });
  const nowMs = new Date(2026, 3, 1, 12, 0, 0).getTime(); // April 1st: past day 62, well before the real end
  assert.equal(m.clockMarkVisible([milestone], nowMs), true);
});

test('clockMarkVisible: false once a long all-day event has actually ended', () => {
  const m = load();
  const milestone = ev({
    id: 'milestone',
    allDay: true,
    important: true,
    start: '2026-01-01',
    end: '2026-06-01',
  });
  const afterRealEnd = new Date(2026, 5, 1, 0, 0, 1).getTime();
  assert.equal(m.clockMarkVisible([milestone], afterRealEnd), false);
});

test('upcomingImportant: a long all-day event still counts as not-ended well past the 62-day cap', () => {
  const m = load();
  const milestone = ev({
    id: 'milestone',
    allDay: true,
    important: true,
    start: '2026-01-01',
    end: '2026-06-01',
  });
  const nowMs = new Date(2026, 3, 1, 12, 0, 0).getTime();
  const { total, items } = m.upcomingImportant([milestone], nowMs, 30, 5);
  assert.equal(total, 1);
  assert.equal(items[0].id, 'milestone');
});

test('upcomingImportant: a long all-day event drops off once it actually ends', () => {
  const m = load();
  const milestone = ev({
    id: 'milestone',
    allDay: true,
    important: true,
    start: '2026-01-01',
    end: '2026-06-01',
  });
  const afterRealEnd = new Date(2026, 5, 1, 0, 0, 1).getTime();
  assert.equal(m.upcomingImportant([milestone], afterRealEnd, 30, 5).total, 0);
});

// clockMarkVisible's "touches today" check must also skip the same cap for timed events, not just all-day ones.
test('clockMarkVisible: true for a long TIMED event still running well past the 62-day day-key cap', () => {
  const m = load();
  const longMeeting = ev({
    id: 'long-timed',
    allDay: false,
    important: true,
    start: '2026-01-01T09:00:00',
    end: '2026-06-01T10:00:00',
  });
  const nowMs = new Date(2026, 3, 1, 12, 0, 0).getTime();
  assert.equal(m.clockMarkVisible([longMeeting], nowMs), true);
});

// ---- DST coverage: clockMarkVisible / upcomingImportant across both 2026 changes --

test('clockMarkVisible: all-day event on the 2026-10-25 fall-back day stays marked through the transition', () => {
  const m = load();
  const allDay = ev({ allDay: true, important: true, start: '2026-10-25', end: '2026-10-26' });
  const withinAmbiguousHour = new Date(2026, 9, 25, 2, 30, 0).getTime(); // the repeated 02:00-03:00 hour
  const justAfterTransition = new Date(2026, 9, 25, 3, 30, 0).getTime();
  const lateInDay = new Date(2026, 9, 25, 23, 30, 0).getTime();
  const afterMidnight = new Date(2026, 9, 26, 0, 0, 1).getTime();
  assert.equal(m.clockMarkVisible([allDay], withinAmbiguousHour), true);
  assert.equal(m.clockMarkVisible([allDay], justAfterTransition), true);
  assert.equal(m.clockMarkVisible([allDay], lateInDay), true);
  assert.equal(m.clockMarkVisible([allDay], afterMidnight), false);
});

test('upcomingImportant: the "days" window cutoff is pure ms math across the 2026-03-29 spring-forward (23h day)', () => {
  const m = load();
  const nowMs = new Date(2026, 2, 28, 12, 0, 0).getTime(); // one day before the short day
  // now + 2*MS_PER_DAY lands at 2026-03-30 13:00 local, not 12:00, crossing the 23-hour day.
  const justInside = ev({ id: 'inside', important: true, start: '2026-03-30T09:00:00' });
  const justOutside = ev({ id: 'outside', important: true, start: '2026-03-31T09:00:00' });
  const { items } = m.upcomingImportant([justInside, justOutside], nowMs, 2, 10);
  const ids = items.map((e) => e.id);
  assert.ok(ids.includes('inside'));
  assert.ok(!ids.includes('outside'));
});

// ---- homeRange ---------------------------------------------------------------

test('homeRange: unions the current month grid with today..today+upcomingDays+1', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 15, 12, 0, 0).getTime(); // mid-October, upcoming window fits inside grid
  const grid = m.gridRange(2026, 9, 1);
  const range = m.homeRange(nowMs, 1, 5);
  assert.equal(m.dayKey(range.start), m.dayKey(grid.start));
  assert.equal(m.dayKey(range.end), m.dayKey(grid.end));
});

test('homeRange: extends past the month grid when upcomingDays reaches beyond it', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 15, 12, 0, 0).getTime();
  const range = m.homeRange(nowMs, 1, 60); // 60 days from Oct 15 reaches well past October's grid
  const grid = m.gridRange(2026, 9, 1);
  assert.ok(range.end.getTime() > grid.end.getTime());
  const expectedEnd = new Date(2026, 9, 15 + 60 + 1);
  assert.equal(m.dayKey(range.end), m.dayKey(expectedEnd));
});

// ---- homeRange: the server rejects ranges over 100 days -------------------

test('homeRange: span never exceeds 100 days for every day of 2026-2027, both week starts, several upcomingDays', () => {
  const m = load();
  for (const year of [2026, 2027]) {
    for (let month = 0; month < 12; month++) {
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      for (let day = 1; day <= daysInMonth; day++) {
        const nowMs = new Date(year, month, day, 12, 0, 0).getTime();
        for (const weekStart of [0, 1]) {
          const grid = m.gridRange(year, month, weekStart);
          for (const upcomingDays of [30, 63, 90, 365]) {
            const range = m.homeRange(nowMs, weekStart, upcomingDays);
            const spanDays = Math.round((range.end.getTime() - range.start.getTime()) / MS_PER_DAY);
            assert.ok(
              spanDays <= 100,
              `span ${spanDays} > 100 for ${year}-${month}-${day} ws${weekStart} up${upcomingDays}`
            );
            assert.equal(
              m.dayKey(range.start),
              m.dayKey(grid.start),
              `start mismatch ${year}-${month}-${day} ws${weekStart} up${upcomingDays}`
            );
          }
        }
      }
    }
  }
});

// ---- clampUpcomingDays ------------------------------------------------------

test('clampUpcomingDays: valid in-range values pass through as integers', () => {
  const m = load();
  assert.equal(m.clampUpcomingDays(30), 30);
  assert.equal(m.clampUpcomingDays(1), 1);
  assert.equal(m.clampUpcomingDays(60), 60);
  assert.equal(m.clampUpcomingDays(45.6), 46);
});

test('clampUpcomingDays: below 1 clamps to 1, above 60 clamps to 60', () => {
  const m = load();
  assert.equal(m.clampUpcomingDays(0), 1);
  assert.equal(m.clampUpcomingDays(-5), 1);
  assert.equal(m.clampUpcomingDays(61), 60);
  assert.equal(m.clampUpcomingDays(365), 60);
});

// ---- homeRange: absurdly large upcomingDays must not overflow Date arithmetic ------

test('homeRange: huge upcomingDays values are capped before date arithmetic so the range stays valid', () => {
  const m = load();
  const nowMs = new Date(2026, 9, 15, 12, 0, 0).getTime();
  for (const upcomingDays of [1e9, Number.MAX_SAFE_INTEGER]) {
    const range = m.homeRange(nowMs, 1, upcomingDays);
    assert.ok(isFinite(range.start.getTime()), `start invalid for upcomingDays=${upcomingDays}`);
    assert.ok(isFinite(range.end.getTime()), `end invalid for upcomingDays=${upcomingDays}`);
    assert.match(m.dayKey(range.start), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(m.dayKey(range.end), /^\d{4}-\d{2}-\d{2}$/);
    const spanDays = Math.round((range.end.getTime() - range.start.getTime()) / MS_PER_DAY);
    assert.ok(spanDays <= 100, `span ${spanDays} > 100 for upcomingDays=${upcomingDays}`);
  }
});

test('clampUpcomingDays: non-finite/non-numeric input defaults to 30', () => {
  const m = load();
  assert.equal(m.clampUpcomingDays(NaN), 30);
  assert.equal(m.clampUpcomingDays(undefined), 30);
  assert.equal(m.clampUpcomingDays(Infinity), 30);
  assert.equal(m.clampUpcomingDays(-Infinity), 30);
  assert.equal(m.clampUpcomingDays('nope'), 30);
});
