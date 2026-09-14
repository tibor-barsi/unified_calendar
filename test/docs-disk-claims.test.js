import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The docs make privacy claims about what reaches disk. Nothing enforces them at runtime, so
// these lint-style checks keep the claims honest when the code around them changes.
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Markdown wraps sentences at 80 columns, so claims are matched against unwrapped text. */
const unwrap = (source) => source.replace(/\s+/g, ' ');

/** The blank-line-separated block containing `needle`, so a claim is checked with its own context. */
function paragraphWith(source, needle) {
  const para = source.split(/\n\s*\n/).find((block) => block.includes(needle));
  assert.ok(para, `no paragraph mentions ${needle}`);
  return unwrap(para);
}

test('README does not claim the server cache is the only thing writing event data to disk', () => {
  assert.doesNotMatch(
    unwrap(read('../README.md')),
    /one feature that writes event data to disk/i,
    'the widget keeps its own unconditional ~/.cache copy, so the exclusivity claim is false'
  );
});

test('README names the widget-side cache and what it keeps there', () => {
  const para = paragraphWith(read('../README.md'), '~/.cache/unified-calendar-widget.json');
  assert.match(para, /notes|description/i, 'must say the widget cache keeps event descriptions');
  assert.match(para, /location/i, 'must say the widget cache keeps locations');
  assert.match(
    para,
    /unconditional|always|regardless|cannot be turned off/i,
    'must say the widget cache is not gated by UNIFIED_CALENDAR_WIDGET_CACHE'
  );
});

test('README qualifies "events are not written to disk" with the starred-event ids', () => {
  const para = paragraphWith(read('../README.md'), 'not written to');
  assert.match(
    para,
    // Word-bounded so "across restarts" in the same paragraph cannot satisfy it.
    /\bstars?\b|\bstarred\b|\bimportant\b/i,
    'setEventImportant() writes starred event ids to data/settings.json'
  );
});

test('store.js header comment does not claim it never writes event data', () => {
  const header = read('../src/store.js').slice(0, 1200);
  assert.doesNotMatch(header, /never event data/, 'setEventImportant() persists starred event ids');
  assert.match(header, /setEventImportant/, 'name the function that puts event ids on disk');
});

// Anchored on the section heading rather than on a paragraph containing the path: the path has
// moved once already, and a claim that survives only while the prose stays laid out one way is
// not a claim about the code.
function sectionWith(source, heading) {
  const at = source.indexOf(heading);
  assert.notEqual(at, -1, `no "${heading}" section`);
  const rest = source.slice(at + heading.length);
  const next = rest.search(/\n## /);
  return unwrap(next === -1 ? rest : rest.slice(0, next));
}

test('the widget README says what its offline cache file stores, and how it is kept private', () => {
  const section = sectionWith(read('../omarchy-widget/README.md'), '## Where the widget keeps things');
  assert.match(section, /notes|description/i, 'must say the file keeps event descriptions');
  assert.match(section, /location/i, 'must say the file keeps locations');
  // FileView cannot set a file mode, so the 0700 directory is the whole protection. If that
  // sentence goes, the reader is left thinking the file itself is locked down.
  assert.match(section, /0700/, 'must say the directory, not the file, is what keeps others out');
  assert.match(section, /\.cache\/unified-calendar-widget\/events\.json/, 'must name the cache path');
});
