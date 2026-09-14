import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const modelPath = fileURLToPath(new URL('../plugin/CalendarModel.js', import.meta.url));

// Strips comments before linting: only real code is a syntax-subset violation, not prose mentioning it.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('CalendarModel.js stays within the QML JavaScript resource syntax subset', () => {
  const code = stripComments(readFileSync(modelPath, 'utf8'));

  assert.doesNotMatch(code, /\bimport\b/, 'no import statements (QML script resource style)');
  assert.doesNotMatch(code, /\bexport\b/, 'no export statements');
  assert.doesNotMatch(code, /\brequire\s*\(/, 'no require(...)');
  assert.doesNotMatch(code, /\bclass\s+\w/, 'no class declarations');
  assert.doesNotMatch(code, /Date\.now\s*\(/, 'no Date.now() -- callers pass nowMs');
  assert.doesNotMatch(
    code,
    /new\s+Date\s*\(\s*\)/,
    'no argument-less new Date() -- callers pass nowMs'
  );
  assert.doesNotMatch(code, /\bIntl\./, 'no Intl');
  assert.doesNotMatch(code, /\.toLocale\w*/, 'no toLocale*');
});
