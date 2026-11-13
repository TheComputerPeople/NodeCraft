// Expose Functions as Nodes on a C or C++ source file (docs/code-as-nodes.md): its functions become
// nodes through their declarations in its header, which generated code includes. A function whose
// header declares it is marked there; one it doesn't is declared there, marked; a missing header is
// made, with extern "C" for a C file, so C++ calls link to its C functions.
import { ExposeCandidate, withMarkers } from './expose';
import { scanCpp } from './cpp-scanner';
import { isMarked } from './symbols';

const SOURCE = /\.(c|cpp|cc|cxx)$/i;

export function isCSource(file: string): boolean {
  return SOURCE.test(file);
}

// A function the source defines, with what its header has of it.
export interface SourceFunction {
  name: string;
  // 1-based, in the source.
  line: number;
  // Its namespace (C++), as the scanner gives it ("app", "a::b").
  container?: string;
  // The declaration for the header, from the definition: "double add(double a, double b);".
  declaration: string;
  // In the header: declared and marked (already a node), declared (the marker goes there), or not.
  header: { state: 'marked' | 'declared'; line: number } | { state: 'missing' };
}

// The header a source's functions are declared in: the one beside it of its name that exists (.h,
// then .hpp, .hh, .hxx), else (to make) .h.
export function headerFor(source: string, exists: (file: string) => boolean): string {
  const stem = source.replace(SOURCE, '');
  return ['.h', '.hpp', '.hh', '.hxx'].map((ext) => stem + ext).find(exists) ?? `${stem}.h`;
}

// The functions a source defines that can be nodes (not static, not main, not a class's members).
export function sourceFunctions(source: string, header: string | undefined): SourceFunction[] {
  const declared = header === undefined ? [] : scanCpp(header).functions;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  return scanCpp(source).functions.filter((f) => f.name !== 'main').map((f) => {
    const found = declared.find((d) => d.name === f.name && (d.container ?? undefined) === (f.container ?? undefined));
    return {
      name: f.name, line: f.line, ...(f.container ? { container: f.container } : {}),
      declaration: declarationOf(lines, f.line),
      header: found ? { state: isMarked(found.doc) ? 'marked' as const : 'declared' as const, line: found.line } : { state: 'missing' as const }
    };
  });
}

// The definition's head, up to its body's brace, as a declaration.
function declarationOf(lines: string[], line: number): string {
  let text = '';
  for (let i = line - 1; i < lines.length; i++) {
    const brace = lines[i].indexOf('{');
    text += ` ${brace >= 0 ? lines[i].slice(0, brace) : lines[i]}`;
    if (brace >= 0) break;
  }
  return `${text.replace(/\s+/g, ' ').trim()};`;
}

// The header's new text with the chosen functions marked (declared ones) or declared, marked (the
// others); and the source's, when the header is new (it then includes it). `c`: a C source, whose new
// header has extern "C" for C++.
export function withDeclarations(source: { path: string; text: string }, header: { path: string; text?: string }, chosen: SourceFunction[], marker: string, c: boolean): { header: string; source?: string } {
  const eol = (header.text ?? source.text).includes('\r\n') ? '\r\n' : '\n';
  const declared = chosen.filter((f) => f.header.state === 'declared').map((f): ExposeCandidate => ({ name: f.name, line: (f.header as { line: number }).line, kind: 'function' }));
  let text = header.text === undefined ? newHeader(source.path, c, chosen) : withMarkers(header.text, declared, marker, { kind: 'line', prefix: '/// ' });
  const missing = chosen.filter((f) => f.header.state === 'missing');
  if (missing.length) {
    const block = declarations(missing, marker);
    text = insertDeclarations(text.replace(/\r\n/g, '\n'), block).split('\n').join(eol);
  } else text = text.split(/\r?\n/).join(eol);
  if (header.text !== undefined) return { header: text };
  // A new header: the source includes it, so its declarations and definitions are checked together.
  const name = header.path.split(/[\\/]/).pop()!;
  const sourceLines = source.text.split(/\r?\n/);
  const at = Math.max(0, sourceLines.findIndex((l) => /^\s*#\s*include\b/.test(l)));
  const sourceEol = source.text.includes('\r\n') ? '\r\n' : '\n';
  return { header: text, source: [...sourceLines.slice(0, at), `#include "${name}"`, ...sourceLines.slice(at)].join(sourceEol) };
}

function declarations(functions: SourceFunction[], marker: string): string[] {
  const lines: string[] = [];
  for (const [container, group] of groupBy(functions, (f) => f.container ?? '')) {
    if (container) lines.push(`namespace ${container} {`);
    for (const f of group) lines.push(`/// ${marker}`, f.declaration);
    if (container) lines.push(`}  // namespace ${container}`);
    lines.push('');
  }
  return lines;
}

// Before a C header's closing extern "C" guard, else its include guard's #endif, else at the end.
function insertDeclarations(text: string, block: string[]): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  const guardClose = lines.map((l) => /^\s*#\s*ifdef\s+__cplusplus\b/.test(l)).lastIndexOf(true);
  const opensExternC = guardClose >= 0 && lines.slice(guardClose, guardClose + 3).some((l) => /^\s*}\s*$/.test(l));
  const endif = lines.map((l) => /^\s*#\s*endif\b/.test(l)).lastIndexOf(true);
  const includeGuard = lines.some((l) => /^\s*#\s*ifndef\s+\w+/.test(l));
  const at = opensExternC ? guardClose : includeGuard && endif >= 0 ? endif : lines.length;
  return [...lines.slice(0, at), ...(at > 0 && lines[at - 1].trim() ? [''] : []), ...block, ...lines.slice(at)].join('\n') + '\n';
}

function newHeader(sourcePath: string, c: boolean, functions: SourceFunction[]): string {
  const file = sourcePath.split(/[\\/]/).pop()!;
  const text = functions.map((f) => f.declaration).join('\n');
  // The standard headers its declarations name.
  const includes = [['std::string', '<string>'], ['std::vector', '<vector>'], ['std::map', '<map>'], ['std::tuple', '<tuple>'], ['std::pair', '<utility>'], ['std::future', '<future>'], ['bool', c ? '<stdbool.h>' : '']]
    .filter(([name, header]) => header && new RegExp(`\\b${name.replace(/:/g, '\\:')}\\b`).test(text)).map(([, header]) => `#include ${header}`);
  return [
    '#pragma once', `// The functions ${file} defines, for the code that calls them.`, ...(includes.length ? ['', ...includes] : []), '',
    ...(c ? ['#ifdef __cplusplus', 'extern "C" {', '#endif', '', '#ifdef __cplusplus', '}', '#endif'] : []), ''
  ].join('\n');
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
