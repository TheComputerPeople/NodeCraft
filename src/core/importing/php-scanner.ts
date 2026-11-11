// Reads a PHP file's functions for exposing them as nodes (docs/code-as-nodes.md, docs/more-languages.md
// "PHP"): functions and `public static` methods marked `@blueprint` in a docblock, typed by their
// declared types. A static method's container is its class's qualified name (generated code calls
// \App\Util\Scores::triple); a function's is its namespace followed by \ (\App\Util\triple). A class's
// public constructor, instance methods and properties are its members (docs/node-authoring.md, gap 2).
import { TypeRef } from '../types';
import { DocComment, ModuleScan, ScannedClass, ScannedFunction, ScannedParam, SkippedFunction, isMarked, markDeprecated, parseDocText, tupleOutputs } from './symbols';

export function scanPhp(source: string): ModuleScan {
  const text = source.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const functions: ScannedFunction[] = [];
  const skipped: SkippedFunction[] = [];
  const namespace = /^\s*namespace\s+([A-Za-z_][\w\\]*)\s*;/m.exec(text)?.[1];
  const qualify = (name: string) => (namespace ? `${namespace}\\${name}` : name);
  // Classes and the brace depth of their bodies, to tell methods from functions.
  const classes: { name: string; depth: number; cls?: ScannedClass }[] = [];
  const scannedClasses: ScannedClass[] = [];
  let depth = 0;
  lines.forEach((line, index) => {
    const code = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$|#.*$/, '');
    const declared = /^\s*((?:(?:final|abstract|readonly)\s+)*)(class|interface|trait|enum)\s+([A-Za-z_]\w*)(?:\s+extends\s+([\w\\]+))?/.exec(code);
    if (declared) {
      const [, modifiers, kind, name, base] = declared;
      const baseType = base ? mapPhpType(base) : null;
      const cls: ScannedClass | undefined = kind === 'class'
        ? {
            name: qualify(name), line: index + 1, doc: docAbove(lines, index), type: mapPhpType(name) ?? { id: `native:${name}` },
            ...(baseType ? { base: baseType } : {}), ...(/\babstract\b/.test(modifiers) ? { abstract: true } : {}), methods: [], properties: []
          }
        : undefined;
      if (cls) scannedClasses.push(cls);
      classes.push({ name, depth: depth + 1, ...(cls ? { cls } : {}) });
    }
    // A property of a class: public float $count = 0; (readonly: no Set).
    const property = /^\s*((?:(?:public|protected|private|readonly|static|var)\s+)+)(\??[\w\\|]+\s+)?\$(\w+)\s*(?:=|;)/.exec(code);
    const owner = classes[classes.length - 1];
    if (property && owner?.cls && depth === owner.depth) {
      const [, modifiers, typeText, name] = property;
      const doc = docAbove(lines, index);
      if (/\bstatic\b/.test(modifiers)) {
        if (isMarked(doc)) skipped.push({ name, line: index + 1, reason: "static properties have no object; they can't be nodes yet", marked: true });
      } else if (/\b(protected|private)\b/.test(modifiers)) {
        if (isMarked(doc)) skipped.push({ name, line: index + 1, reason: "it isn't public", marked: true });
      } else {
        const type = typeText ? mapPhpType(typeText.trim()) : null;
        owner.cls.properties.push({ name, line: index + 1, ...(type ? { type } : {}), readonly: /\breadonly\b/.test(modifiers), doc });
      }
    }
    const fn = /^\s*((?:(?:public|protected|private|static|final|abstract)\s+)*)function\s+&?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?::\s*(\??[\w\\|]+))?/.exec(code);
    if (fn) {
      const [, modifiers, name, paramText, returnText] = fn;
      const inClass = classes.length > 0 && depth >= classes[classes.length - 1].depth;
      const doc = docAbove(lines, index);
      const where = index + 1;
      const skip = (reason: string) => skipped.push({ name, line: where, reason, marked: isMarked(doc) });
      const isStatic = /\bstatic\b/.test(modifiers);
      const isPublic = !/\b(protected|private)\b/.test(modifiers);
      // A class's instance method, or its constructor, is a member.
      const member = inClass && !isStatic && classes[classes.length - 1].cls;
      // What a subclass may do with it (docs/code-classes-as-parents.md): override it unless it's
      // final; a protected one is for subclasses alone.
      const isProtected = /\bprotected\b/.test(modifiers);
      const inheritance = { ...(/\babstract\b/.test(modifiers) ? { abstract: true } : {}), ...(/\bfinal\b/.test(modifiers) ? { sealed: true } : {}), ...(isProtected ? { protected: true } : {}) };
      const overridable = !inheritance.sealed && (!!inheritance.abstract || /^overridable\b/i.test(doc.tags.find((t) => t.name === 'blueprint')?.text.trim() ?? ''));
      if (member && !isPublic && !(isProtected && name !== '__construct')) skip("it isn't public");
      else if (inClass && !member && !(isStatic && isPublic)) skip("It isn't public static: generated code calls static methods and functions, without an object.");
      else if (name.startsWith('__') && !(member && name === '__construct')) skip('Its name starts with __ (a magic method).');
      else {
        // From the line as written: string defaults were blanked in `code`.
        const written = /function\s+&?\w+\s*\(([^)]*)\)/.exec(line)?.[1] ?? paramText;
        const params = written.split(',').map((p) => p.trim()).filter(Boolean);
        // Parameters by reference (`int &$count`) are out parameters (docs/node-authoring.md, gap 3),
        // after the inputs.
        const references = params.filter((p) => /&\s*\$/.test(p));
        if (params.some((p) => /\.\.\./.test(p))) skip('It takes any number of arguments.');
        else if (references.length && params.indexOf(references[0]) < params.length - references.length) skip('Its parameters by reference (out parameters) must come after the others.');
        else {
          const scanned: ScannedParam[] = params.filter((p) => !references.includes(p)).map((p) => {
            const [, typeText, paramName, defaultText] = /^(?:(?:public|protected|private|readonly)\s+)*([?\w\\|]+\s+)?\$(\w+)\s*(?:=\s*(.+))?$/.exec(p) ?? [, undefined, p.replace(/^.*\$/, ''), undefined];
            const type = typeText ? mapPhpType(typeText.trim()) : null;
            const defaultValue = defaultText !== undefined ? literal(defaultText) : undefined;
            return { name: paramName ?? p, ...(type ? { type } : {}), ...(defaultValue !== undefined ? { defaultValue } : {}) };
          });
          // A namespace alone ends with \, so generated code calls a function, not a static method.
          const container = inClass ? qualify(classes[classes.length - 1].name) : namespace ? `${namespace}\\` : undefined;
          // A function returning a Fiber is async (docs/node-authoring.md, gap 4): a latent node, whose
          // value is what the Fiber returns (typed by `@return Fiber<int>`, or PHPStan's
          // `Fiber<TStart, TResume, TReturn, TSuspend>`, else any value).
          const fiber = returnText && /^\\?Fiber$/.test(returnText.trim()) && !references.length;
          const fiberTypes = fiber ? /^\\?Fiber<\s*([^>]+)>/.exec(doc.tags.find((t) => t.name === 'return')?.text.trim() ?? '')?.[1].split(',').map((t) => t.trim()) : undefined;
          const fiberValue = fiberTypes?.length === 4 ? fiberTypes[2] : fiberTypes?.[0];
          const returns = fiber ? (fiberValue ? mapPhpType(fiberValue) : undefined) : returnText ? mapPhpType(returnText) : undefined;
          const several = fiber ? { latent: true } : severalOutputs(doc, returns, references);
          if (member && name === '__construct') member.init = { name, line: where, params: scanned, returns: null, doc };
          else if (member) {
            member.methods.push({ name, line: where, params: scanned, returns, doc, ...several, ...inheritance });
            if (isProtected && !overridable) skip("it isn't public");
          }
          else functions.push({ name, line: where, params: scanned, returns, doc, ...several, ...(container ? { container } : {}) });
        }
      }
    }
    for (const c of code) {
      if (c === '{') depth++;
      if (c === '}') {
        depth--;
        while (classes.length && depth < classes[classes.length - 1].depth) classes.pop();
      }
    }
  });
  return markDeprecated({ functions, skipped, ...(scannedClasses.length ? { classes: scannedClasses } : {}) }, deprecatedLines(lines));
}

// The docblock (`/** ... */`) just above a declaration, attributes (#[...]) between them skipped.
// PHP 8.4's #[\Deprecated] or #[\Deprecated("message")] / #[\Deprecated(message: "…")] on the
// lines above a declaration (docs/node-authoring.md, gap 6), by the declaration's 1-based line.
function deprecatedLines(lines: string[]): Map<number, { message?: string }> {
  const found = new Map<number, { message?: string }>();
  lines.forEach((line, index) => {
    if (/^\s*#\[/.test(line) || index === 0) return;
    for (let i = index - 1; i >= 0 && /^\s*#\[/.test(lines[i]); i--) {
      const match = /#\[\s*\\?Deprecated\b\s*(?:\(\s*(?:message\s*:\s*)?(["'])(.*?)\1)?/.exec(lines[i]);
      if (match) found.set(index + 1, match[2] ? { message: match[2] } : {});
    }
  });
  return found;
}

function docAbove(lines: string[], index: number): DocComment {
  let i = index - 1;
  while (i >= 0 && /^\s*#\[/.test(lines[i])) i--;
  if (i < 0 || !/\*\/\s*$/.test(lines[i])) return parseDocText([]);
  const block: string[] = [];
  for (; i >= 0; i--) {
    block.unshift(lines[i]);
    if (/^\s*\/\*\*/.test(lines[i])) break;
  }
  return parseDocText(block.map((l) => l.replace(/^\s*\/\*\*\s?|\s*\*\/\s*$|^\s*\*\s?/g, '')));
}

function literal(text: string): unknown {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^'[^'\\]*'$/.test(t)) return t.slice(1, -1);
  return undefined;
}

// A PHP type as a canonical type: int, float, string, bool, ?T and T|null (nullable); mixed is any
// value and void nothing. A PHP array isn't a graph array (graphs pass VgList objects), so it is
// native, as other classes are.
// Several outputs (docs/node-authoring.md, gap 3): parameters by reference (after the returned
// value, if any), or an array shape the doc comment returns (`@return array{sum: int, count: int}`,
// or `array{int, int}` named by @outputs).
function severalOutputs(doc: DocComment, returns: TypeRef | null | undefined, references: string[]): Pick<ScannedFunction, 'returns' | 'outputs' | 'results'> | {} {
  if (references.length) {
    const outs = references.map((p) => /^(\??[\w\\|]+\s+)?&\s*\$(\w+)/.exec(p)).map((m, i) => ({ name: m?.[2] ?? references[i].replace(/^.*\$/, ''), ...(m?.[1] && mapPhpType(m[1].trim()) ? { type: mapPhpType(m[1].trim())! } : {}) }));
    const returnValue = returns !== null;
    const outputs = [...(returnValue ? [{ name: 'returnValue', ...(returns ? { type: returns } : {}) }] : []), ...outs];
    return { returns: undefined, outputs, results: { kind: 'out', names: outs.map((o) => o.name), ...(returnValue ? { returnValue } : {}) } };
  }
  const shape = /^array\{(.*)\}/.exec(doc.tags.find((t) => t.name === 'return')?.text.trim() ?? '');
  if (!shape) return {};
  const elements = shape[1].split(',').map((e) => e.trim()).filter(Boolean).map((e) => /^(?:([A-Za-z_]\w*|\d+)\??\s*:\s*)?(.+)$/.exec(e)!);
  const types = elements.map((e) => mapPhpType(e[2]) ?? undefined);
  const keys = elements.map((e) => e[1]);
  if (keys.every((k) => k && !/^\d/.test(k))) {
    if (elements.length < 2) return {};
    const outputs = keys.map((k, i) => ({ name: k!, ...(types[i] ? { type: types[i] } : {}) }));
    return { returns: undefined, outputs, results: { kind: 'fields', names: outputs.map((o) => o.name) } };
  }
  const outputs = tupleOutputs(doc, types);
  return outputs ? { returns: undefined, outputs, results: { kind: 'tuple', names: outputs.map((o) => o.name) } } : {};
}

export function mapPhpType(text: string): TypeRef | null {
  let t = text.trim().replace(/^\\/, '');
  let nullable = false;
  if (t.startsWith('?')) {
    nullable = true;
    t = t.slice(1);
  }
  const union = t.split('|').map((u) => u.trim());
  if (union.length === 2 && union.includes('null')) {
    nullable = true;
    t = union.find((u) => u !== 'null')!;
  }
  const base: TypeRef | null = t === 'void' ? null
    : t === 'mixed' ? { id: 'any' }
    : t === 'int' ? { id: 'int' }
    : t === 'float' ? { id: 'float' }
    : t === 'string' ? { id: 'string' }
    : t === 'bool' ? { id: 'bool' }
    : { id: `native:${t}` };
  return base && nullable && base.id !== 'any' ? { ...base, nullable: true } : base;
}
