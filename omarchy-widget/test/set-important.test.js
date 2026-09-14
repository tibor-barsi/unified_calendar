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

test('setImportant: returns a new array with only the matching event replaced', () => {
  const m = load();
  const a = ev({ id: 'a', important: false });
  const b = ev({ id: 'b', important: false });
  const c = ev({ id: 'c', important: false });
  const events = [a, b, c];

  const out = m.setImportant(events, 'b', true);

  assert.notEqual(out, events);
  assert.equal(out[0], a);
  assert.equal(out[2], c);
  assert.notEqual(out[1], b);
  assert.equal(out[1].important, true);
  assert.equal(out[1].id, 'b');
  assert.equal(b.important, false); // original untouched
});

test('setImportant: can also flip a flag back to false', () => {
  const m = load();
  const a = ev({ id: 'a', important: true });
  const out = m.setImportant([a], 'a', false);
  assert.equal(out[0].important, false);
});

test('setImportant: id not found leaves all objects as the same references', () => {
  const m = load();
  const a = ev({ id: 'a' });
  const b = ev({ id: 'b' });
  const out = m.setImportant([a, b], 'nope', true);
  assert.notEqual(out, [a, b]);
  assert.equal(out[0], a);
  assert.equal(out[1], b);
});

test('setImportant: invalid input returns an empty array', () => {
  const m = load();
  assert.deepEqual(m.setImportant(null, 'a', true), []);
  assert.deepEqual(m.setImportant(undefined, 'a', true), []);
});
