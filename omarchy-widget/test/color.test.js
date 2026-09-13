process.env.TZ = 'Europe/Ljubljana';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadQmlScript } from '../test-support/load-qml-script.js';

const modelPath = fileURLToPath(new URL('../plugin/CalendarModel.js', import.meta.url));
function load() {
  return loadQmlScript(modelPath);
}

test('relativeLuminance: black is 0, white is 1', () => {
  const m = load();
  assert.equal(m.relativeLuminance('#000000'), 0);
  assert.equal(m.relativeLuminance('#ffffff'), 1);
});

test('relativeLuminance: #rgb shorthand expands like #rrggbb', () => {
  const m = load();
  assert.equal(m.relativeLuminance('#fff'), m.relativeLuminance('#ffffff'));
  assert.equal(m.relativeLuminance('#000'), m.relativeLuminance('#000000'));
  assert.equal(m.relativeLuminance('#f7a'), m.relativeLuminance('#ff77aa'));
});

test('relativeLuminance: #aarrggbb ignores the leading alpha byte', () => {
  const m = load();
  assert.equal(m.relativeLuminance('#ff1a1b26'), m.relativeLuminance('#1a1b26'));
  assert.equal(m.relativeLuminance('#001a1b26'), m.relativeLuminance('#1a1b26'));
});

test('contrastRatio(#000, #fff) is exactly 21', () => {
  const m = load();
  assert.equal(m.contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(m.contrastRatio('#fff', '#000'), 21);
});

test('contrastRatio: order of arguments does not matter', () => {
  const m = load();
  assert.equal(m.contrastRatio('#1a1b26', '#f7768e'), m.contrastRatio('#f7768e', '#1a1b26'));
});

// ---- readableOn: real theme data ------------------------------------------------

test('readableOn: tokyo-night fill picks background', () => {
  const m = load();
  assert.equal(m.readableOn('#f7768e', '#1a1b26', '#a9b1d6'), 'background');
});

test('readableOn: miasma fill picks foreground', () => {
  const m = load();
  assert.equal(m.readableOn('#685742', '#222222', '#c2c2b0'), 'foreground');
});

test('readableOn: solitude fill picks foreground', () => {
  const m = load();
  assert.equal(m.readableOn('#565d60', '#101315', '#cacccc'), 'foreground');
});

test('readableOn: invalid colour on one side falls back to the other', () => {
  const m = load();
  assert.equal(m.readableOn('#1a1b26', 'not-a-color', '#a9b1d6'), 'foreground');
  assert.equal(m.readableOn('#1a1b26', '#a9b1d6', 'not-a-color'), 'background');
});

test('readableOn: invalid colour on both sides returns null', () => {
  const m = load();
  assert.equal(m.readableOn('#1a1b26', 'not-a-color', 'also-invalid'), null);
});

test('readableOn: accepts #aarrggbb and #rgb inputs', () => {
  const m = load();
  // Same tokyo-night case, expressed with a fully-opaque #aarrggbb fill.
  assert.equal(m.readableOn('#fff7768e', '#1a1b26', '#a9b1d6'), 'background');
  // #rgb-shorthand: a black fill contrasts white far more than mid-gray, so background wins.
  assert.equal(m.readableOn('#000', '#fff', '#888'), 'background');
  // Flipped: a near-white fill contrasts near-black far more than light-gray, so foreground wins.
  assert.equal(m.readableOn('#eee', '#ddd', '#111'), 'foreground');
});
