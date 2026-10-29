// Feedback in code (docs/node-authoring.md, gap 7): the quick fixes Expose as Blueprint node and
// Expose as pure Blueprint node, which add the marker to a declaration's documentation comment in
// its language's style, creating the comment when there is none.
import { ModuleScan, isMarked } from './symbols';

// How a language documents a declaration: a /** … */ block above it, a line prefix above it, or a
// Python docstring after it.
export type DocStyle = { kind: 'block' } | { kind: 'line'; prefix: string } | { kind: 'docstring' };

const STYLES: Record<string, DocStyle> = {
  typescript: { kind: 'block' },
  javascript: { kind: 'block' },
  java: { kind: 'block' },
  php: { kind: 'block' },
  csharp: { kind: 'line', prefix: '/// ' },
  cpp: { kind: 'line', prefix: '/// ' },
  rust: { kind: 'line', prefix: '/// ' },
  go: { kind: 'line', prefix: '// ' },
  lua: { kind: 'line', prefix: '---' },
  gdscript: { kind: 'line', prefix: '## ' },
  ruby: { kind: 'line', prefix: '# ' },
  python: { kind: 'docstring' }
};

export function docStyle(language: string): DocStyle | undefined {
  return STYLES[language];
}

// A declaration the quick fixes are offered on: an unmarked function, method, constructor or
// property the scanner can expose. Lines are 1-based, as the scanners give them.
export interface ExposeCandidate {
  name: string;
  line: number;
  kind: 'function' | 'method' | 'constructor' | 'property';
}

export function exposeCandidates(scan: ModuleScan, language: string): ExposeCandidate[] {
  const candidates: ExposeCandidate[] = scan.functions.filter((f) => !isMarked(f.doc)).map((f) => ({ name: f.name, line: f.line, kind: 'function' }));
  for (const cls of scan.classes ?? []) {
    if (cls.init && !isMarked(cls.init.doc)) candidates.push({ name: cls.init.name, line: cls.init.line, kind: 'constructor' });
    for (const m of cls.methods) if (!isMarked(m.doc)) candidates.push({ name: m.name, line: m.line, kind: 'method' });
    // A Lua field is marked in its ---@field annotation, which a line above can't do.
    if (language !== 'lua') for (const p of cls.properties) if (!isMarked(p.doc)) candidates.push({ name: p.name, line: p.line, kind: 'property' });
  }
  return candidates;
}

// Replaces lines [start, end) (0-based) with `lines`.
export interface LineEdit {
  start: number;
  end: number;
  lines: string[];
}

// The edit adding `marker` ("@blueprint" or "@blueprint pure") to the declaration at `line`
// (1-based) of `source`; undefined when it can't be placed (a one-line Python def).
export function markerEdit(source: string, line: number, marker: string, style: DocStyle): LineEdit | undefined {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const at = line - 1;
  const indent = /^\s*/.exec(lines[at] ?? '')![0];
  if (style.kind === 'docstring') return docstringEdit(lines, at, indent, marker);
  // Attributes, annotations and decorators sit between the documentation and the declaration.
  let top = at;
  while (top > 0 && /^\s*(@|\[|#\[)/.test(lines[top - 1]) && !/^\s*#\s/.test(lines[top - 1])) top--;
  if (style.kind === 'line') return { start: top, end: top, lines: [`${indent}${style.prefix}${marker}`] };
  // A /** … */ block right above: the marker goes in it.
  const above = top - 1;
  if (above >= 0 && lines[above].trimEnd().endsWith('*/')) {
    let start = above;
    while (start > 0 && !lines[start].includes('/*')) start--;
    if (lines[start].trimStart().startsWith('/**')) {
      const blockIndent = /^\s*/.exec(lines[start])![0];
      if (start === above) {
        // /** Text. */ becomes a block of lines.
        const text = lines[above].trim().replace(/^\/\*\*\s*/, '').replace(/\s*\*\/$/, '');
        return { start: above, end: above + 1, lines: [`${blockIndent}/**`, ...(text ? [`${blockIndent} * ${text}`] : []), `${blockIndent} * ${marker}`, `${blockIndent} */`] };
      }
      if (lines[above].trim() === '*/') return { start: above, end: above, lines: [`${blockIndent} * ${marker}`] };
      const before = lines[above].replace(/\s*\*\/\s*$/, '');
      return { start: above, end: above + 1, lines: [before, `${blockIndent} * ${marker}`, `${blockIndent} */`] };
    }
  }
  return { start: top, end: top, lines: [`${indent}/** ${marker} */`] };
}

// Python: the docstring after the header (a def's, or an attribute's), in which the marker goes.
function docstringEdit(lines: string[], at: number, indent: string, marker: string): LineEdit | undefined {
  // The header ends at the line whose colon closes it, outside brackets.
  const isDef = /^\s*(async\s+)?def\b/.test(lines[at]);
  let end = at;
  if (isDef) {
    let depth = 0;
    for (; end < lines.length; end++) {
      const code = lines[end].replace(/#.*$/, '');
      for (const ch of code) depth += '([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0;
      if (depth <= 0 && /:\s*$/.test(code)) break;
      // A one-line def (`def f(): pass`) has no room for a docstring.
      if (depth <= 0 && /:\s*\S/.test(code.slice(code.lastIndexOf(')') + 1))) return undefined;
    }
  }
  let first = end + 1;
  while (first < lines.length && !lines[first].trim()) first++;
  const bodyIndent = isDef ? (first < lines.length && lines[first].length - lines[first].trimStart().length > indent.length ? /^\s*/.exec(lines[first])![0] : `${indent}    `) : indent;
  const quote = /^\s*[rRuU]?("""|''')/.exec(lines[first] ?? '')?.[1];
  if (!quote) return { start: end + 1, end: end + 1, lines: [`${bodyIndent}"""${marker}"""`] };
  const opening = lines[first].indexOf(quote);
  const closing = lines[first].indexOf(quote, opening + 3);
  if (closing >= 0) {
    // """Text.""" on one line: the marker on a line of its own before the closing quotes.
    return { start: first, end: first + 1, lines: [lines[first].slice(0, closing).trimEnd(), `${bodyIndent}${marker}${lines[first].slice(closing)}`] };
  }
  let last = first + 1;
  while (last < lines.length && !lines[last].includes(quote)) last++;
  if (last >= lines.length) return undefined;
  if (lines[last].trim() === quote) return { start: last, end: last, lines: [`${bodyIndent}${marker}`] };
  const close = lines[last].lastIndexOf(quote);
  return { start: last, end: last + 1, lines: [lines[last].slice(0, close).trimEnd(), `${bodyIndent}${marker}${lines[last].slice(close)}`] };
}
