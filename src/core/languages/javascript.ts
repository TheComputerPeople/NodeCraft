// JavaScript and TypeScript packs. They share a simulator, because the extension host is a
// JavaScript runtime and can execute JavaScript snippets directly.
import { CodeSimulator, LanguagePack } from '../language-pack';
import { LANGUAGE_TERMS } from '../terms';
import { TypeRef, parseTypeId } from '../types';
import { scanTypeScript } from '../importing/typescript-scanner';
import { typescriptGenerator } from './typescript-codegen';

const javascriptSimulator: CodeSimulator = {
  // TypeScript snippets often carry type annotations the host can't run, so plain JavaScript is
  // preferred even for TypeScript graphs.
  sourceLanguages: ['javascript', 'typescript'],
  run(code, inputs) {
    // Pin ids are parameter names when they are valid identifiers, so snippets can refer to them
    // directly; otherwise a generated name is used and only ${pinId} reaches it.
    const params = new Map(inputs.map((input, i) => [input.id, isIdentifier(input.id) ? input.id : `__pin${i}`]));
    const body = code.replace(/\$\{([^}]+)\}/g, (_m, name: string) => params.get(name) ?? name);
    const fn = new Function(...params.values(), body) as (...args: unknown[]) => unknown;
    return fn(...inputs.map((input) => input.value));
  }
};

// The syntax check alone would accept parameter lists like "a, b" or "a = 1", hence the regex.
function isIdentifier(name: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  try {
    new Function(name, '');
    return true;
  } catch {
    return false;
  }
}

const PRIMITIVES: Record<string, string> = { bool: 'boolean', int: 'number', float: 'number', string: 'string', any: 'unknown', wildcard: 'unknown' };

// TypeScript spelling; also used for JSDoc annotations in generated JavaScript. Types from project
// code (native) aren't imported into generated files: the editor checks them by name, and the
// generated code passes them on as `any`.
function mapType(type: TypeRef): string {
  const { category, name } = parseTypeId(type.id);
  const element = PRIMITIVES[type.id] ?? (category === 'native' ? 'any' : name);
  const base = type.container === 'array' ? `${wrapUnion(element)}[]`
    : type.container === 'set' ? `Set<${element}>`
    : type.container === 'map' ? `Map<${element}, ${type.valueType ? mapType(type.valueType) : 'unknown'}>`
    : element;
  return type.nullable ? `${base} | null` : base;
}

function wrapUnion(type: string): string {
  return type.includes('|') ? `(${type})` : type;
}

export const typescriptPack: LanguagePack = {
  id: 'typescript',
  displayName: 'TypeScript',
  generatedFileExtension: '.ts',
  workspaceMarkers: ['**/tsconfig.json'],
  capabilities: { staticTyping: true, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.typescript,
  simulator: javascriptSimulator,
  generator: typescriptGenerator({ typed: true, mapType }),
  importer: { extensions: ['.ts', '.mts', '.cts'], scan: (source) => scanTypeScript(source) }
};

export const javascriptPack: LanguagePack = {
  id: 'javascript',
  displayName: 'JavaScript',
  generatedFileExtension: '.js',
  workspaceMarkers: ['**/package.json', '**/jsconfig.json'],
  capabilities: { staticTyping: false, classes: true, inheritance: true, interfaces: true, generics: false, async: true, exceptions: true, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  terms: LANGUAGE_TERMS.javascript,
  simulator: javascriptSimulator,
  generator: typescriptGenerator({ typed: false, mapType }),
  importer: { extensions: ['.js', '.mjs', '.cjs'], scan: (source) => scanTypeScript(source, true) }
};
