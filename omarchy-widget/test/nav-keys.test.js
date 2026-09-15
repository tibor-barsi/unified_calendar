process.env.TZ = 'Europe/Ljubljana';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadQmlScript } from '../test-support/load-qml-script.js';

const modelPath = fileURLToPath(new URL('../plugin/CalendarModel.js', import.meta.url));

function load() {
  return loadQmlScript(modelPath);
}

const DEFAULTS = {
  letters: { horizontal: 'day', vertical: 'week' },
  arrows: { horizontal: 'month', vertical: 'year' },
};

test('parseNavKeys defaults hjkl to day/week and the arrows to month/year', () => {
  const m = load();
  assert.deepEqual(m.parseNavKeys(undefined), DEFAULTS);
  assert.deepEqual(m.parseNavKeys(null), DEFAULTS);
  assert.deepEqual(m.parseNavKeys({}), DEFAULTS);
});

test('parseNavKeys takes each axis on its own', () => {
  const m = load();
  const parsed = m.parseNavKeys({ arrows: { horizontal: 'week' } });
  assert.equal(parsed.arrows.horizontal, 'week');
  assert.equal(parsed.arrows.vertical, 'year', 'unset axis keeps its default');
  assert.deepEqual(parsed.letters, DEFAULTS.letters);
});

test('parseNavKeys accepts "none" to switch an axis off', () => {
  const m = load();
  assert.equal(m.parseNavKeys({ letters: { vertical: 'none' } }).letters.vertical, 'none');
});

test('parseNavKeys falls back per slot on junk rather than disabling the key', () => {
  const m = load();
  assert.deepEqual(m.parseNavKeys({ letters: { horizontal: 'fortnight' } }).letters, DEFAULTS.letters);
  assert.deepEqual(m.parseNavKeys({ letters: 'day' }), DEFAULTS);
  assert.deepEqual(m.parseNavKeys(['day']), DEFAULTS);
  assert.deepEqual(m.parseNavKeys({ arrows: [1, 2] }).arrows, DEFAULTS.arrows);
});

test('parseNavKeys is case- and space-insensitive', () => {
  const m = load();
  assert.equal(m.parseNavKeys({ letters: { horizontal: ' DAY ' } }).letters.horizontal, 'day');
});

test('cursorSeed starts on today when today is the month on screen', () => {
  const m = load();
  assert.equal(m.cursorSeed('2026-09-14', 2026, 8), '2026-09-14');
});

test('cursorSeed starts on the 1st when browsing another month', () => {
  const m = load();
  assert.equal(m.cursorSeed('2026-09-14', 2026, 11), '2026-12-01');
  assert.equal(m.cursorSeed('2026-09-14', 2025, 0), '2025-01-01');
});

test('stepDayKey walks days and weeks across month and year edges', () => {
  const m = load();
  assert.equal(m.stepDayKey('2026-09-14', 'day', 1), '2026-09-15');
  assert.equal(m.stepDayKey('2026-09-01', 'day', -1), '2026-08-31');
  assert.equal(m.stepDayKey('2026-09-14', 'week', 1), '2026-09-21');
  assert.equal(m.stepDayKey('2026-12-31', 'day', 1), '2027-01-01');
  assert.equal(m.stepDayKey('2026-09-28', 'week', 1), '2026-10-05');
});

test('stepDayKey clamps into short months instead of rolling over', () => {
  const m = load();
  assert.equal(m.stepDayKey('2026-01-31', 'month', 1), '2026-02-28');
  assert.equal(m.stepDayKey('2024-01-31', 'month', 1), '2024-02-29', 'leap year keeps the 29th');
  assert.equal(m.stepDayKey('2026-03-31', 'month', -1), '2026-02-28');
  assert.equal(m.stepDayKey('2024-02-29', 'year', 1), '2025-02-28');
});

test('stepDayKey steps months and years', () => {
  const m = load();
  assert.equal(m.stepDayKey('2026-09-14', 'month', -1), '2026-08-14');
  assert.equal(m.stepDayKey('2026-09-14', 'year', 1), '2027-09-14');
  assert.equal(m.stepDayKey('2026-09-14', 'year', -2), '2024-09-14');
});

test('stepDayKey returns "" for anything that cannot move', () => {
  const m = load();
  assert.equal(m.stepDayKey('2026-09-14', 'none', 1), '');
  assert.equal(m.stepDayKey('2026-09-14', 'day', 0), '');
  assert.equal(m.stepDayKey('not-a-date', 'day', 1), '');
  assert.equal(m.stepDayKey('2026-02-30', 'day', 1), '', 'a rolled-over date is not a date');
  assert.equal(m.stepDayKey('', 'day', 1), '');
  assert.equal(m.stepDayKey('2026-09-14', 'day', NaN), '');
});

test('navAction browses the month grid when no day is selected', () => {
  const m = load();
  assert.deepEqual(m.navAction('month', 1, false), { kind: 'view', months: 1 });
  assert.deepEqual(m.navAction('year', -1, false), { kind: 'view', months: -12 });
});

test('navAction summons the cursor on the first fine-grained press', () => {
  const m = load();
  assert.equal(m.navAction('day', 1, false).kind, 'seed');
  assert.equal(m.navAction('week', -1, false).kind, 'seed');
});

test('navAction moves the selection once there is one, coarse units included', () => {
  const m = load();
  for (const unit of ['day', 'week', 'month', 'year']) {
    assert.equal(m.navAction(unit, 1, true).kind, 'cursor', unit);
  }
});

test('navAction does nothing for a disabled axis, a zero step or a bad unit', () => {
  const m = load();
  assert.equal(m.navAction('none', 1, true).kind, 'none');
  assert.equal(m.navAction('day', 0, true).kind, 'none');
  assert.equal(m.navAction('fortnight', 1, true).kind, 'none');
});
