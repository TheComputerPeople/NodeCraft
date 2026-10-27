// Tier 2 symbol import (docs/language-breadth.md, "Tier 2 symbol import"): a language without a
// scanner of its own has its functions found by the language server. The extension asks it for the
// file's document symbols and each function's hover; this module reads those, with the doc comments
// in the file, into the ModuleScan the scanners produce. Types are read from the hover's signature
// and mapped back through the pack's own spellings; types it doesn't know become native types.
import { LanguageServerImport } from '../language-pack';
import { TypeRef } from '../types';
import { DocComment, ModuleScan, NO_DOC, ScannedParam, isMarked, parseDocText } from './symbols';

// Why a function is skipped when its hover has no signature (the server may still be loading).
export const NO_SIGNATURE = 'the language server gave no signature for it';

// A function the language server reported, with its hover text (markdown or plain).
export interface SymbolFunction {
  name: string;
  // 0-based lines: where the declaration starts (its range) and where its name is.
  line: number;
  nameLine: number;
  // The namespaces or modules it's inside, outermost first.
  containers: string[];
  hover?: string;
}

export function scanSymbols(text: string, functions: SymbolFunction[], spec: LanguageServerImport, spell: (type: TypeRef) => string): ModuleScan {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const result: ModuleScan = { functions: [], skipped: [] };
  const known = spellings(spell);
  for (const fn of functions) {
    const doc = docAbove(lines, fn, spec.comments);
    const container = fn.containers.length ? fn.containers.join(spec.namespaceSeparator ?? '.') : undefined;
    const line = fn.line + 1;
    const skip = (reason: string) => result.skipped.push({ name: fn.name, line, reason, marked: isMarked(doc), ...(container ? { container } : {}) });
    const signature = fn.hover !== undefined ? findSignature(fn.hover, fn.name) : undefined;
    if (!signature) {
      skip(NO_SIGNATURE);
      continue;
    }
    const parsed = parseSignature(signature, fn.name, spec);
    if ('reason' in parsed) {
      skip(parsed.reason);
      continue;
    }
    const params: ScannedParam[] = parsed.params.map((p) => ({ name: p.name, ...(p.type ? { type: typeFromText(p.type, known) } : {}), ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}) }));
    const returns = parsed.returns === null ? null : parsed.returns ? typeFromText(parsed.returns, known) : undefined;
    result.functions.push({ name: fn.name, line, params, returns, doc, ...(container ? { container } : {}) });
  }
  return result;
}

// ---- Doc comments ------------------------------------------------------------------------------

// The comment lines right above a declaration (attributes and the declaration's own earlier lines
// may sit in between), without their comment markers.
function docAbove(lines: string[], fn: SymbolFunction, prefixes: string[]): DocComment {
  const sorted = [...prefixes, '*/'].sort((a, b) => b.length - a.length);
  const collected: string[] = [];
  for (let i = fn.nameLine - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    const prefix = sorted.find((p) => trimmed.startsWith(p));
    if (prefix !== undefined) {
      collected.unshift(trimmed.slice(prefix.length).replace(/\*\/\s*$/, '').replace(/^ /, ''));
      continue;
    }
    // Attributes, decorators, and the declaration's earlier lines (a return type on its own line).
    if (/^(#\[|\[\[|@)/.test(trimmed) || (i >= fn.line && trimmed)) continue;
    break;
  }
  return collected.some((l) => l.trim()) ? parseDocText(collected) : NO_DOC;
}

// ---- Signatures --------------------------------------------------------------------------------

// The line of the hover that declares the function: in a code block when there is one.
export function findSignature(hover: string, name: string): string | undefined {
  const blocks = [...hover.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = (blocks.length ? blocks : [hover]).join('\n').split('\n');
  const call = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}\\s*(<[^>]*>)?\\s*\\(`);
  const at = candidates.findIndex((line) => call.test(line));
  if (at < 0) return undefined;
  // A signature may run over several lines: up to its closing parenthesis and what follows it.
  let text = candidates[at];
  for (let i = at + 1; i < candidates.length && depth(text) > 0; i++) text += ` ${candidates[i].trim()}`;
  return text.trim();
}

function depth(text: string): number {
  let d = 0;
  for (const ch of text) d += ch === '(' ? 1 : ch === ')' ? -1 : 0;
  return d;
}

interface ParsedSignature {
  params: { name: string; type?: string; defaultValue?: unknown }[];
  // The return type's text; null when the function returns nothing; undefined when unknown.
  returns: string | null | undefined;
}

export function parseSignature(signature: string, name: string, spec: LanguageServerImport): ParsedSignature | { reason: string } {
  const match = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}\\s*(<[^>]*>)?\\s*\\(`).exec(signature);
  if (!match) return { reason: NO_SIGNATURE };
  const start = match.index + match[1].length;
  const open = signature.indexOf('(', start);
  let close = open;
  for (let d = 0; close < signature.length; close++) {
    if (signature[close] === '(') d++;
    else if (signature[close] === ')' && --d === 0) break;
  }
  if (/<[^>]*>\s*\($/.test(signature.slice(start, open + 1))) return { reason: 'generic functions can\'t be nodes yet' };
  const ignore = new Set(spec.ignore ?? []);
  const voids = new Set(spec.void ?? ['void']);
  const clean = (text: string) => text.split(/\s+/).filter((w) => w && !ignore.has(w)).join(' ').trim();
  const params: ParsedSignature['params'] = [];
  const inner = signature.slice(open + 1, close).trim();
  for (const piece of splitTopLevel(inner)) {
    if (!piece || voids.has(piece.trim())) continue;
    const param = parseParam(piece, spec.parameters, clean);
    if ('reason' in param) return param;
    params.push(param);
  }
  let returns: string | null | undefined;
  if (spec.returns === 'before') {
    const before = clean(signature.slice(0, start).replace(/([\w$]+(::|\.))+$/, ''));
    returns = !before ? undefined : voids.has(before) ? null : before;
  } else {
    const after = clean(signature.slice(close + 1).replace(/^\s*(->|=>|:)?/, '').replace(/[{;].*$/, '').replace(/\bwhere\b.*$/, ''));
    returns = !after || voids.has(after) ? null : after;
  }
  return { params, returns };
}

function parseParam(piece: string, style: LanguageServerImport['parameters'], clean: (text: string) => string): ParsedSignature['params'][number] | { reason: string } {
  const [declaration, defaultText] = splitDefault(piece);
  if (declaration.includes('...')) return { reason: 'variadic functions can\'t be nodes' };
  let name: string;
  let type: string | undefined;
  if (style === 'name: type') {
    const colon = declaration.indexOf(':');
    name = (colon < 0 ? declaration : declaration.slice(0, colon)).replace(/^\s*(mut\s+|\.\.\.)/, '').replace(/\?\s*$/, '').trim();
    type = colon < 0 ? undefined : clean(declaration.slice(colon + 1));
  } else if (style === 'name type') {
    const match = /^\s*([\w$]+)\s+(.+)$/.exec(declaration);
    name = match?.[1] ?? declaration.trim();
    type = match ? clean(match[2]) : undefined;
  } else {
    const match = /^(.*?)([\w$]+)\s*(\[\s*\])?\s*$/.exec(declaration);
    name = match?.[2] ?? '';
    type = match ? clean(`${match[1]}${match[3] ?? ''}`) : undefined;
    if (!type) return { reason: 'a parameter has no name, so it can\'t be a pin' };
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(name) || name === 'self' || name === 'this') return { reason: 'self and pattern parameters can\'t be pins' };
  return { name, ...(type ? { type } : {}), ...(defaultText !== undefined ? { defaultValue: literalValue(defaultText) } : {}) };
}

function splitDefault(piece: string): [string, string | undefined] {
  const at = piece.search(/(?<![=!<>])=(?![=>])/);
  return at < 0 ? [piece, undefined] : [piece.slice(0, at), piece.slice(at + 1).trim()];
}

function literalValue(text: string): unknown {
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?[fFlLuU]*$/.test(text)) return Number(text.replace(/[fFlLuU]+$/, ''));
  if (text === 'true' || text === 'True') return true;
  if (text === 'false' || text === 'False') return false;
  const quoted = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/.exec(text);
  if (quoted) return (quoted[1] ?? quoted[2]).replace(/\\(.)/g, '$1');
  return undefined;
}

// Splits on commas outside brackets.
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let level = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('([{<'.includes(ch)) level++;
    else if (')]}>'.includes(ch) && text[i - 1] !== '-' && text[i - 1] !== '=') level--;
    else if (ch === ',' && level === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  if (text.slice(from).trim()) parts.push(text.slice(from).trim());
  return parts;
}

// ---- Types -------------------------------------------------------------------------------------

// The pack's spellings of the canonical types and of containers of them, normalized.
function spellings(spell: (type: TypeRef) => string): Map<string, TypeRef> {
  const known = new Map<string, TypeRef>();
  const add = (type: TypeRef) => {
    const text = normalize(spell(type));
    if (text && !known.has(text)) known.set(text, type);
  };
  // Float before int: a language with one number type (JavaScript's number) means a float by it.
  const ids = ['bool', 'float', 'int', 'string'] as const;
  for (const id of ids) add({ id });
  for (const container of ['array', 'set'] as const) for (const id of ids) add({ id, container });
  return known;
}

export function typeFromText(text: string, known: Map<string, TypeRef>): TypeRef | undefined {
  const t = normalize(text);
  if (!t || t === 'any' || t === 'unknown') return undefined;
  return known.get(t) ?? { id: `native:${t}` };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s*([<>,*&[\]():])\s*/g, '$1').replace(/,/g, ', ').trim();
}
