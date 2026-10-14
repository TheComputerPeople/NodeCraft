// How generated code names the project modules it imports (docs/code-as-nodes.md, "Generated
// imports"). Paths are relative to the workspace folder, with "/" separators.

// A relative specifier from a folder to a file: "./combat.ts", "../lib/math.js".
export function relativeSpecifier(fromDir: string, to: string): string {
  const from = segments(fromDir);
  const target = segments(to);
  let shared = 0;
  while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared]) shared++;
  const rest = target.slice(shared).join('/');
  const up = from.length - shared;
  return up ? '../'.repeat(up) + rest : `./${rest}`;
}

// A TypeScript import of a module. TypeScript modules end as the project's configuration expects:
// ".ts" (Node.js and allowImportingTsExtensions), ".js" (node16/nodenext) or nothing (bundlers).
// JavaScript modules always keep their own extension.
export function typescriptSpecifier(fromDir: string, to: string, extension: 'ts' | 'js' | 'none'): string {
  const specifier = relativeSpecifier(fromDir, to);
  const match = /\.([mc]?)ts$/.exec(specifier);
  if (!match || extension === 'ts') return specifier;
  const stem = specifier.slice(0, -match[0].length);
  // .mts and .cts modules can't be imported without an extension.
  return extension === 'js' || match[1] ? `${stem}.${match[1]}js` : stem;
}

// A Python module's import name when nothing better is known: its path as a dotted name.
export function pythonModuleName(path: string): string {
  return segments(path.replace(/\.py$/i, '')).filter((s, i, all) => !(s === '__init__' && i === all.length - 1)).join('.');
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s && s !== '.');
}

// The folder Python must have on sys.path to import `module` from `path` (both as in
// FunctionImplementation): "src/game/combat.py" as "game.combat" needs "src".
export function pythonImportRoot(path: string, module: string): string {
  const parts = segments(path.replace(/\.py$/i, ''));
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts.slice(0, Math.max(0, parts.length - module.split('.').length)).join('/');
}
