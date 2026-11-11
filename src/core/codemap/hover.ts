// What hovering a type or function shows on the Codebase Map and in its tree (docs/codebase-map.md,
// Part 3): its signature (the declaration's head, up to its body) and its doc comment (the comment
// right above it, or Python's docstring), read from the file's text in any of the map's languages.
// The index keeps neither, so a hover reads them when it's asked for.

export interface DeclarationSummary {
  signature: string;
  doc?: string;
}

const MAX_SIGNATURE_LINES = 8;
const MAX_SIGNATURE_CHARS = 300;
const MAX_DOC_LINES = 12;
const MAX_DOC_CHARS = 800;
const MAX_BLOCK_LINES = 80;

// Decorators, attributes and annotations, on lines of their own.
const DECORATOR = /^\s*(@[\w.]+(\(.*\))?|#\[.*\]|\[[A-Za-z][\w.]*(\(.*\))?(,\s*[A-Za-z][\w.]*(\(.*\))?)*\])\s*$/;

// Each language's line comments (C, C++, C#, Go, Java, JavaScript, Rust, TypeScript: //).
const LINE_COMMENTS: Record<string, string[]> = {
  python: ['#'], ruby: ['#'], gdscript: ['#'], lua: ['--'], php: ['//', '#']
};

// The declaration at `line` (1-based) of `text`; undefined when there's no code there.
export function declarationSummary(text: string, line: number, language?: string): DeclarationSummary | undefined {
  const lines = text.split(/\r?\n/);
  let start = line - 1;
  if (start < 0 || start >= lines.length) return undefined;
  // Decorators above it, and on the lines it starts with.
  let top = start;
  while (top > 0 && DECORATOR.test(lines[top - 1])) top--;
  while (start < lines.length - 1 && DECORATOR.test(lines[start])) start++;
  const head = signatureLines(lines, start);
  if (!head) return undefined;
  const signature = clip(cleanSignature(head.text, language), MAX_SIGNATURE_CHARS);
  if (!signature) return undefined;
  const doc = (language === 'python' ? docstring(lines, head.end + 1) : undefined) ?? commentAbove(lines, top, language);
  return doc ? { signature, doc } : { signature };
}

// The declaration's lines up to where its brackets close (a parameter list over several lines).
function signatureLines(lines: string[], start: number): { text: string; end: number } | undefined {
  const parts: string[] = [];
  let depth = 0;
  let end = start;
  for (let i = start; i < lines.length && i < start + MAX_SIGNATURE_LINES; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed && !parts.length) return undefined;
    parts.push(trimmed);
    depth += bracketDepth(trimmed);
    end = i;
    if (depth <= 0) break;
  }
  return { text: parts.join(' '), end };
}

// How much a line opens ( and [ minus what it closes, outside quotes.
function bracketDepth(line: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === '\'' || c === '`') {
      quote = c;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    }
  }
  return depth;
}

// The head without its body: up to the brace that opens it, without Python's and GDScript's
// colon, an arrow function's arrow or Lua's and Ruby's trailing words.
function cleanSignature(text: string, language?: string): string {
  let s = text.replace(/\s+/g, ' ').trim();
  if (s.endsWith('{')) {
    s = s.slice(0, -1);
  } else {
    const brace = topLevelBrace(s);
    if (brace >= 0) s = s.slice(0, brace);
  }
  s = s.trim();
  if (language === 'python' || language === 'gdscript') s = s.replace(/:\s*(#.*)?$/, '').replace(/:\s*(pass|\.\.\.)$/, '');
  s = s.replace(/\s*=>$/, '').replace(/\s*(\bdo|\bthen)$/, '');
  return s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+,/g, ',').trim();
}

// The first { outside brackets and quotes (a body on the declaration's own line).
function topLevelBrace(s: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === '\'' || c === '`') {
      quote = c;
    } else if (c === '(' || c === '[' || c === '<') {
      depth++;
    } else if (c === ')' || c === ']' || (c === '>' && s[i - 1] !== '=' && s[i - 1] !== '-')) {
      depth = Math.max(0, depth - 1);
    } else if (c === '{' && depth === 0) {
      return i;
    }
  }
  return -1;
}

// The comment right above line `top` (0-based): a /** … */ block, or line comments.
function commentAbove(lines: string[], top: number, language?: string): string | undefined {
  let i = top - 1;
  if (i < 0) return undefined;
  const last = lines[i].trim();
  if (last.endsWith('*/')) {
    let first = i;
    while (first > 0 && first > i - MAX_BLOCK_LINES && !lines[first].includes('/*')) first--;
    if (!lines[first].includes('/*')) return undefined;
    return docText(lines.slice(first, i + 1).map(blockLine));
  }
  const prefixes = LINE_COMMENTS[language ?? ''] ?? ['//'];
  const found: string[] = [];
  while (i >= 0 && found.length < MAX_BLOCK_LINES) {
    const trimmed = lines[i].trim();
    const prefix = prefixes.find((p) => trimmed.startsWith(p) && !(p === '#' && /^#(!|\[|include\b|define\b|region\b|endregion\b)/.test(trimmed)));
    if (!prefix) break;
    // (/// and //!, ## and --- are doc comments' own prefixes.)
    found.unshift(trimmed.slice(prefix.length).replace(prefix === '//' ? /^[/!]+/ : prefix === '#' ? /^#+/ : /^-+/, '').replace(/^ /, ''));
    i--;
  }
  return found.length ? docText(found) : undefined;
}

function blockLine(line: string): string {
  return line.trim().replace(/^\/\*+!?/, '').replace(/\*+\/$/, '').trim().replace(/^\* ?/, '').trimEnd();
}

// A Python docstring: the string the body starts with.
function docstring(lines: string[], from: number): string | undefined {
  const first = lines[from]?.trim();
  const open = first && /^[rRuUbB]?("""|''')/.exec(first);
  if (!open) return undefined;
  const quote = open[1];
  const rest = first.slice(open[0].length);
  const close = rest.indexOf(quote);
  if (close >= 0) return docText([rest.slice(0, close)]);
  const found = [rest];
  for (let i = from + 1; i < lines.length && i < from + MAX_BLOCK_LINES; i++) {
    const at = lines[i].indexOf(quote);
    if (at >= 0) {
      found.push(lines[i].slice(0, at));
      break;
    }
    found.push(lines[i]);
  }
  return docText(dedent(found));
}

function dedent(lines: string[]): string[] {
  const indents = lines.slice(1).filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return [lines[0].trim(), ...lines.slice(1).map((l) => l.slice(cut).trimEnd())];
}

// The comment's text: C#'s XML documentation read as text, blank lines at either end dropped, and
// kept short.
function docText(lines: string[]): string | undefined {
  const text = lines.flatMap((l) => {
    const read = l
      .replace(/<param name="([^"]*)">/g, '$1: ')
      .replace(/<(?:see (?:c?ref|langword)|(?:type)?paramref name)="([^"]*)"\s*\/>/g, '$1')
      .replace(/<\/?(summary|remarks|returns|param|typeparam|para|c|code|example|exception|value|see|seealso|list|item|description|term|inheritdoc)(\s[^>]*)?\/?>/g, '')
      .trimEnd();
    // (A line that only held tags goes.)
    return read.trim() || !l.trim() ? [read] : [];
  });
  while (text.length && !text[0].trim()) text.shift();
  while (text.length && !text[text.length - 1].trim()) text.pop();
  if (!text.length) return undefined;
  const kept = text.length > MAX_DOC_LINES ? [...text.slice(0, MAX_DOC_LINES), '…'] : text;
  return clip(kept.join('\n'), MAX_DOC_CHARS);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
