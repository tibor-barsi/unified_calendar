// Loads a QML JS resource's top-level var/function bindings into a plain object, like `import "Foo.js" as Foo` in QML; uses vm.compileFunction (not vm.createContext, a separate V8 realm) so returned arrays stay reference-comparable with node:assert's deep-equal.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Column-0 only, so a nested var/function (this style always indents function bodies) never matches.
const TOP_LEVEL_DECL_RE = /^(?:var|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

export function loadQmlScript(filePath) {
  const source = readFileSync(filePath, 'utf8');

  const names = new Set();
  for (const match of source.matchAll(TOP_LEVEL_DECL_RE)) names.add(match[1]);
  if (names.size === 0) {
    throw new Error(`loadQmlScript: found no top-level var/function declarations in ${filePath}`);
  }

  const returnObject = '{' + [...names].map((n) => `${n}: ${n}`).join(',') + '}';
  const body = source + '\n;return ' + returnObject + ';';

  const fn = vm.compileFunction(body, [], { filename: filePath });
  return fn();
}
