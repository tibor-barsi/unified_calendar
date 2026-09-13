import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// public/ has no build step and no DOM test harness, so these are lint-style checks on the
// source: the browser client must star one id at a time (whole-array saves lose the widget's
// stars), and public/ is cache-first, so a change there is invisible without a CACHE_NAME bump.
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** The body of a named function declaration, up to the next top-level `}`. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `public/app.js has no function ${name}()`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `could not find the end of ${name}()`);
  return source.slice(start, end);
}

test('public/app.js: toggleImportant() posts a single id to /api/settings/important', () => {
  const body = functionBody(read('../public/app.js'), 'toggleImportant');
  assert.match(body, /'\/api\/settings\/important'/, 'toggleImportant must call the single-id endpoint');
  assert.match(body, /method:\s*'POST'/);
  assert.match(body, /JSON\.stringify\(\{\s*id,\s*important\s*\}\)/, 'the body must be the single { id, important } pair');
});

test('public/app.js: toggleImportant() no longer PUTs the whole importantEvents array', () => {
  const body = functionBody(read('../public/app.js'), 'toggleImportant');
  assert.doesNotMatch(body, /method:\s*'PUT'/, 'a whole-array PUT discards every star made in the widget');
  assert.doesNotMatch(body, /importantEvents:\s*list/);
});

test('public/app.js: nothing else sends importantEvents as a whole-array save', () => {
  const src = read('../public/app.js');
  assert.doesNotMatch(src, /importantEvents:\s*list/);
});

test('public/sw.js: CACHE_NAME was bumped past cal-v7, or the browser keeps serving the old app.js', () => {
  const match = /CACHE_NAME\s*=\s*'([^']+)'/.exec(read('../public/sw.js'));
  assert.ok(match, 'public/sw.js has no CACHE_NAME');
  const version = /^cal-v(\d+)$/.exec(match[1]);
  assert.ok(version, `unexpected CACHE_NAME format: ${match[1]}`);
  assert.ok(Number(version[1]) > 7, `CACHE_NAME is still ${match[1]} — bump it after changing public/`);
});
