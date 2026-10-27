// The template syntax of declarative language packs (docs/language-breadth.md, "Declarative packs"):
// small and logic-less. `{{field}}` inserts a value, `{{#each list ", "}}…{{/each}}` repeats with an
// optional separator (`{{this}}` is the item, `{{@index}}` its position), `{{#if field}}…{{else}}…{{/if}}`
// and `{{#unless field}}…{{/unless}}` test whether a value is there, and a line holding only
// `{{> field}}` inserts multi-line text (statements) indented to the placeholder's column. A line
// holding only a section tag leaves no blank line behind.

export type TemplateValue = string | number | boolean | undefined | null | TemplateValue[] | { [key: string]: TemplateValue };

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; path: string }
  | { kind: 'block'; path: string; indent: string }
  | { kind: 'each'; path: string; separator: string; body: Node[] }
  | { kind: 'if'; path: string; negate: boolean; then: Node[]; else: Node[] };

export interface Template {
  readonly nodes: Node[];
  // The fields it reads (first path segments), for checking definitions.
  readonly fields: Set<string>;
}

export class TemplateError extends Error {}

const TAG = /\{\{(.*?)\}\}/gs;
const SECTION_LINE = /^[ \t]*\{\{\s*(#each|#if|#unless|\/each|\/if|\/unless|else)\b[^}]*\}\}[ \t]*(\r?\n|$)/;
const BLOCK_LINE = /^([ \t]*)\{\{>\s*([\w.@]+)\s*\}\}[ \t]*(\r?\n|$)/;

export function parseTemplate(source: string): Template {
  // Lines that hold only a section tag or a block placeholder become bare tokens.
  const tokens: ({ kind: 'text'; text: string } | { kind: 'tag'; text: string } | { kind: 'block'; path: string; indent: string })[] = [];
  for (const line of source.split(/(?<=\n)/)) {
    const block = BLOCK_LINE.exec(line);
    if (block) {
      tokens.push({ kind: 'block', indent: block[1], path: block[2] });
      continue;
    }
    const section = SECTION_LINE.exec(line);
    if (section && (line.match(TAG) ?? []).length === 1) {
      tokens.push({ kind: 'tag', text: line.trim().replace(/^\{\{|\}\}$/g, '').trim() });
      continue;
    }
    let last = 0;
    for (const match of line.matchAll(TAG)) {
      if (match.index! > last) tokens.push({ kind: 'text', text: line.slice(last, match.index) });
      tokens.push({ kind: 'tag', text: match[1].trim() });
      last = match.index! + match[0].length;
    }
    if (last < line.length) tokens.push({ kind: 'text', text: line.slice(last) });
  }

  const fields = new Set<string>();
  const use = (path: string) => {
    if (path !== 'this' && !path.startsWith('@')) fields.add(path.split('.')[0]);
  };
  const root: Node[] = [];
  const stack: { node: Extract<Node, { kind: 'each' | 'if' }> | undefined; into: Node[]; inElse: boolean; tag: string }[] = [{ node: undefined, into: root, inElse: false, tag: '' }];
  const top = () => stack[stack.length - 1];
  for (const token of tokens) {
    if (token.kind === 'text') {
      top().into.push(token);
      continue;
    }
    if (token.kind === 'block') {
      use(token.path);
      top().into.push(token);
      continue;
    }
    const text = token.text;
    const open = /^#(each|if|unless)\s+([\w.@]+)(?:\s+("(?:[^"\\]|\\.)*"))?$/.exec(text);
    if (open) {
      use(open[2]);
      const node: Extract<Node, { kind: 'each' | 'if' }> = open[1] === 'each'
        ? { kind: 'each', path: open[2], separator: open[3] ? JSON.parse(open[3]) as string : '', body: [] }
        : { kind: 'if', path: open[2], negate: open[1] === 'unless', then: [], else: [] };
      if (open[1] !== 'each' && open[3]) throw new TemplateError(`{{#${open[1]}}} takes one field: {{${text}}}`);
      top().into.push(node);
      stack.push({ node, into: node.kind === 'each' ? node.body : node.then, inElse: false, tag: open[1] });
      continue;
    }
    if (text === 'else') {
      const frame = top();
      if (frame.node?.kind !== 'if' || frame.inElse) throw new TemplateError('{{else}} outside {{#if}} or {{#unless}}');
      frame.inElse = true;
      frame.into = frame.node.else;
      continue;
    }
    const close = /^\/(each|if|unless)$/.exec(text);
    if (close) {
      if (stack.length === 1 || top().tag !== close[1]) throw new TemplateError(`{{/${close[1]}}} without a matching {{#${close[1]}}}`);
      stack.pop();
      continue;
    }
    if (/^[\w.@]+$/.test(text)) {
      use(text);
      top().into.push({ kind: 'value', path: text });
      continue;
    }
    if (/^>\s*/.test(text)) throw new TemplateError(`{{${text}}} must be alone on its line`);
    throw new TemplateError(`Unknown tag {{${text}}}`);
  }
  if (stack.length > 1) throw new TemplateError(`{{#${top().tag}}} is never closed`);
  return { nodes: root, fields };
}

export function renderTemplate(template: Template, context: TemplateValue): string {
  return renderNodes(template.nodes, [context], -1);
}

function renderNodes(nodes: Node[], scopes: TemplateValue[], index: number): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.text;
        break;
      case 'value':
        out += text(lookup(node.path, scopes, index));
        break;
      case 'block': {
        const value = text(lookup(node.path, scopes, index)).replace(/\n$/, '');
        if (value) out += value.split('\n').map((line) => (line ? node.indent + line : '')).join('\n') + '\n';
        break;
      }
      case 'each': {
        const list = lookup(node.path, scopes, index);
        const items = Array.isArray(list) ? list : truthy(list) ? [list] : [];
        out += items.map((item, i) => renderNodes(node.body, [...scopes, item], i)).join(node.separator);
        break;
      }
      case 'if': {
        const value = truthy(lookup(node.path, scopes, index));
        out += renderNodes(value !== node.negate ? node.then : node.else, scopes, index);
        break;
      }
    }
  }
  return out;
}

function lookup(path: string, scopes: TemplateValue[], index: number): TemplateValue {
  if (path === '@index') return index;
  if (path === 'this') return scopes[scopes.length - 1];
  const [first, ...rest] = path.split('.');
  let value: TemplateValue = undefined;
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (scope && typeof scope === 'object' && !Array.isArray(scope) && first in scope) {
      value = scope[first];
      break;
    }
  }
  for (const key of rest) value = value && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined;
  return value;
}

function truthy(value: TemplateValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return !!value;
}

function text(value: TemplateValue): string {
  if (value === undefined || value === null || value === false) return '';
  if (typeof value === 'object') return Array.isArray(value) ? value.map(text).join('') : '';
  return String(value);
}
