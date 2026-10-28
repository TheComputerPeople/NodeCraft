// The TypeScript/JavaScript declaration scanner and how scanned functions become nodes
// (docs/code-as-nodes.md).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExposeOptions, exposeFunctions, words } from '../../src/core/importing/symbols';
import { mapTypeText, scanTypeScript } from '../../src/core/importing/typescript-scanner';
import { NodeDefinition } from '../../src/core/model';
import { repoRoot } from './helpers';

const TS: ExposeOptions = { language: 'typescript', path: 'src/combat.ts', exposeAll: false };

function nodes(source: string, options: Partial<ExposeOptions> = {}): NodeDefinition[] {
  return exposeFunctions(scanTypeScript(source, options.language === 'javascript'), { ...TS, ...options }).definitions;
}

function only(source: string, options: Partial<ExposeOptions> = {}): NodeDefinition {
  const found = nodes(source, options);
  assert.equal(found.length, 1, `expected one node, got ${found.map((n) => n.type).join(', ') || 'none'}`);
  return found[0];
}

const pins = (def: NodeDefinition) => ({
  inputs: def.inputs.map((p) => `${p.id}:${p.kind === 'exec' ? 'exec' : p.type ? JSON.stringify(p.type) : 'any'}${p.defaultValue !== undefined ? `=${JSON.stringify(p.defaultValue)}` : ''}`),
  outputs: def.outputs.map((p) => `${p.id}:${p.kind === 'exec' ? 'exec' : p.type ? JSON.stringify(p.type) : 'any'}`)
});

function skipped(source: string, javascript = false): string[] {
  return exposeFunctions(scanTypeScript(source, javascript), { ...TS, exposeAll: true }).skipped.map((s) => `${s.name}: ${s.reason}`);
}

describe('TypeScript scanner: exposure', () => {
  test('a marked, exported function becomes a callable node, as BlueprintCallable', () => {
    const def = only(`
      /**
       * Subtracts damage from health.
       * @blueprint
       */
      export function applyDamage(health: number, amount: number = 10): number {
        return Math.max(0, health - amount);
      }`);
    assert.equal(def.type, 'fn:typescript:src/combat.ts#applyDamage');
    assert.equal(def.displayName, 'Apply Damage');
    assert.equal(def.category, 'Project / combat');
    assert.equal(def.description, 'Subtracts damage from health.');
    assert.deepEqual(pins(def), {
      inputs: ['execIn:exec', 'health:{"id":"float"}', 'amount:{"id":"float"}=10'],
      outputs: ['execOut:exec', 'returnValue:{"id":"float"}']
    });
    assert.deepEqual(def.inputs.map((p) => p.name), ['', 'Health', 'Amount']);
    assert.deepEqual(def.implementation, { kind: 'function', language: 'typescript', path: 'src/combat.ts', name: 'applyDamage' });
  });

  test('"@blueprint pure" has no exec pins, as BlueprintPure', () => {
    const def = only('/** @blueprint pure */\nexport function double(value: number): number { return value * 2; }');
    assert.deepEqual(pins(def), { inputs: ['value:{"id":"float"}'], outputs: ['returnValue:{"id":"float"}'] });
  });

  test('category, display name and keywords come from tags', () => {
    const def = only('/**\n * @blueprint\n * @category Math|Scaling\n * @displayName Times Two\n * @keywords twice, x2\n */\nexport function double(v: number) { return v * 2; }');
    assert.equal(def.category, 'Math / Scaling');
    assert.equal(def.displayName, 'Times Two');
    assert.deepEqual(def.keywords, ['twice', 'x2']);
  });

  test('unmarked functions are only exposed with exposeAll', () => {
    const source = 'export function a(): void {}\n/** @blueprint */\nexport function b(): void {}';
    assert.deepEqual(nodes(source).map((n) => n.displayName), ['B']);
    assert.deepEqual(nodes(source, { exposeAll: true }).map((n) => n.displayName), ['A', 'B']);
  });

  test('a marked function that is not exported is reported, not exposed', () => {
    const source = '/** @blueprint */\nfunction hidden(): void {}';
    assert.deepEqual(nodes(source), []);
    assert.deepEqual(skipped(source), ["hidden: it isn't exported, so generated code can't import it"]);
  });

  test('display names split camelCase, snake_case and acronyms', () => {
    assert.equal(words('applyDamage'), 'Apply Damage');
    assert.equal(words('apply_damage'), 'Apply Damage');
    assert.equal(words('loadHTTPPage'), 'Load HTTP Page');
    assert.equal(words('x'), 'X');
  });
});

describe('TypeScript scanner: declarations', () => {
  test('exported arrow functions and function expressions', () => {
    const found = nodes(`
      /** @blueprint */
      export const half = (value: number): number => value / 2;
      /** @blueprint */
      export const shout = function (text: string): string { return text.toUpperCase(); };
      /** @blueprint */
      export const one = x => x;`);
    assert.deepEqual(found.map((n) => [n.displayName, pins(n).inputs.slice(1), pins(n).outputs.slice(1)]), [
      ['Half', ['value:{"id":"float"}'], ['returnValue:{"id":"float"}']],
      ['Shout', ['text:{"id":"string"}'], ['returnValue:{"id":"string"}']],
      ['One', ['x:any'], ['returnValue:any']]
    ]);
  });

  test('export lists name local functions, with aliases', () => {
    const found = nodes('/** @blueprint */\nfunction heal(amount: number): void {}\nexport { heal as restore };');
    assert.deepEqual(found.map((n) => [n.type, (n.implementation as { name: string }).name]), [['fn:typescript:src/combat.ts#restore', 'restore']]);
  });

  test('re-exports from other modules are left to those modules', () => {
    assert.deepEqual(nodes("export { heal } from './heal';\nexport * from './more';", { exposeAll: true }), []);
  });

  test('CommonJS exports in JavaScript', () => {
    const found = nodes(`
      /** @blueprint */
      function addToTotal(amount) { return amount; }
      /** @blueprint */
      function reset() {}
      module.exports = { addToTotal, clear: reset };
      /** @blueprint */
      exports.triple = (v) => v * 3;`, { language: 'javascript', path: 'lib/score.cjs' });
    assert.deepEqual(found.map((n) => (n.implementation as { name: string }).name).sort(), ['addToTotal', 'clear', 'triple']);
  });

  test('functions that cannot be nodes are reported with the reason', () => {
    assert.deepEqual(skipped(`
      export async function load(): Promise<void> {}
      export function* ids() {}
      export function sum(...values: number[]): number { return 0; }
      export function move({ x, y }: Point): void {}
      export function first<T>(items: T[]): T { return items[0]; }
      export function fetchIt(): Promise<string> { return Promise.resolve(''); }
      export function pick(a: number): number;
      export function pick(a: string): string;
      export function pick(a: any): any { return a; }`), [
      "load: async functions become latent nodes with Phase 4's latent actions",
      "ids: generator functions can't be nodes",
      "sum: rest parameters can't be pins",
      "move: destructured parameters can't be pins",
      "first: generic functions can't be nodes yet",
      "fetchIt: it returns a Promise; asynchronous functions become latent nodes with Phase 4's latent actions",
      "pick: overloaded functions can't be nodes yet"
    ]);
  });

  test('reasons are only reported for marked functions unless everything is exposed', () => {
    const scan = scanTypeScript('export async function a() {}\n/** @blueprint */\nexport async function b() {}');
    assert.deepEqual(exposeFunctions(scan, TS).skipped.map((s) => s.name), ['b']);
  });

  test('declarations inside blocks, classes and namespaces are not top-level functions', () => {
    const found = nodes(`
      export class Game { run(): void {} }
      export namespace Util { export function inner(): void {} }
      if (true) { function nested(): void {} }
      export function outer(): void { function local(): void {} }`, { exposeAll: true });
    assert.deepEqual(found.map((n) => n.displayName), ['Outer']);
  });

  test('declaration lines are 1-based', () => {
    const scan = scanTypeScript('\n\n/** @blueprint */\nexport function f(): void {}');
    assert.equal(scan.functions[0].line, 4);
  });
});

describe('TypeScript scanner: returns and defaults', () => {
  test('without a return annotation, the body decides whether there is an output', () => {
    const found = nodes(`
      export function gives(a: number) { return a + 1; }
      export function none(a: number) { console.log(a); return; }
      export function inner() { const f = () => { return 1; }; function g() { return 2; } }`, { exposeAll: true });
    assert.deepEqual(found.map((n) => [n.displayName, n.outputs.filter((p) => p.kind === 'data').length]), [['Gives', 1], ['None', 0], ['Inner', 0]]);
  });

  test('void, undefined and never return nothing; type predicates are booleans', () => {
    const found = nodes(`
      export function a(): void {}
      export function b(): undefined { return undefined; }
      export function c(x: unknown): x is string { return typeof x === 'string'; }`, { exposeAll: true });
    assert.deepEqual(found.map((n) => pins(n).outputs.slice(1)), [[], [], ['returnValue:{"id":"bool"}']]);
  });

  test('literal defaults become pin defaults; other defaults leave the pin without one', () => {
    const def = only("export function f(a = -2.5, b = 'it\\'s', c = `plain`, d = true, e = null, g = 1_000, h = Math.PI, i = `x${1}`) {}", { exposeAll: true });
    assert.deepEqual(def.inputs.slice(1).map((p) => p.defaultValue), [-2.5, "it's", 'plain', true, null, 1000, undefined, undefined]);
  });

  test('JavaScript reads parameter and return types from JSDoc', () => {
    const def = only(`
      /**
       * @blueprint
       * @param {number} amount How much.
       * @param {string[]} [tags]
       * @param {?string} label
       * @returns {boolean}
       */
      export function check(amount, tags, label) { return amount > 0; }`, { language: 'javascript', path: 'lib/check.js' });
    assert.deepEqual(pins(def).inputs.slice(1), ['amount:{"id":"float"}', 'tags:{"id":"string","container":"array"}', 'label:{"id":"string","nullable":true}']);
    assert.deepEqual(pins(def).outputs.slice(1), ['returnValue:{"id":"bool"}']);
  });
});

describe('TypeScript scanner: tokens', () => {
  test('braces inside strings, templates, regular expressions and comments do not confuse it', () => {
    const found = nodes(`
      const a = "{"; const b = '}'; const c = \`{\${ { x: '}' }.x }\`;
      const r = /[{}]\\{/g; const d = 4 / 2 / 1;
      // }
      /* { */
      export function after(): void {}`, { exposeAll: true });
    assert.deepEqual(found.map((n) => n.displayName), ['After']);
  });

  test('object and function types in signatures', () => {
    const def = only('export function f(o: { a: number; b: string }, cb: (x: number) => void): { ok: boolean } { return { ok: true }; }', { exposeAll: true });
    assert.deepEqual(pins(def).inputs.slice(1), ['o:{"id":"native:{ a: number; b: string }"}', 'cb:{"id":"native:(x: number) => void"}']);
    assert.deepEqual(pins(def).outputs.slice(1), ['returnValue:{"id":"native:{ ok: boolean }"}']);
  });
});

describe('TypeScript scanner: real code', () => {
  // This repository's own sources: every `export function` the scanner sees is either exposed or
  // reported with a reason, never silently lost.
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(path.join(repoRoot, 'src'));

  test(`finds every exported function in ${files.length} source files`, () => {
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const expected = [...source.matchAll(/^export (?:async )?function\*? ?(\w+)/gm)].map((m) => m[1]);
      const scan = scanTypeScript(source);
      const found = new Set([...scan.functions, ...scan.skipped].map((f) => f.name));
      assert.deepEqual(expected.filter((name) => !found.has(name)), [], path.relative(repoRoot, file));
    }
  });

  test('reads signatures from src/core/types.ts', () => {
    const scan = scanTypeScript(fs.readFileSync(path.join(repoRoot, 'src/core/types.ts'), 'utf8'));
    const formatType = scan.functions.find((f) => f.name === 'formatType')!;
    assert.deepEqual(formatType.params, [{ name: 'type', type: { id: 'native:TypeRef | undefined' } }]);
    assert.deepEqual(formatType.returns, { id: 'string' });
  });
});

describe('TypeScript types', () => {
  const cases: [string, unknown][] = [
    ['number', { id: 'float' }],
    ['string', { id: 'string' }],
    ['boolean', { id: 'bool' }],
    ['any', undefined],
    ['unknown', undefined],
    ['number[]', { id: 'float', container: 'array' }],
    ['Array<string>', { id: 'string', container: 'array' }],
    ['readonly boolean[]', { id: 'bool', container: 'array' }],
    ['ReadonlyArray<number>', { id: 'float', container: 'array' }],
    ['Set<string>', { id: 'string', container: 'set' }],
    ['Map<string, number>', { id: 'string', container: 'map', valueType: { id: 'float' } }],
    ['Map<string, Array<number>>', { id: 'native:Map<string, Array<number>>' }],
    ['Record<string, number>', { id: 'native:Record<string, number>' }],
    ['string | null', { id: 'string', nullable: true }],
    ['null | number', { id: 'float', nullable: true }],
    ['string | undefined', { id: 'native:string | undefined' }],
    ["'red' | 'green'", { id: 'string' }],
    ['1 | 2 | 3', { id: 'float' }],
    ['true | false', { id: 'bool' }],
    ['string | number', { id: 'native:string | number' }],
    ['(string | null)[]', { id: 'native:(string | null)[]' }],
    ['number[][]', { id: 'native:number[][]' }],
    ['Vector', { id: 'native:Vector' }],
    ['game.Vector', { id: 'native:game.Vector' }]
  ];
  for (const [text, expected] of cases) {
    test(text, () => assert.deepEqual(mapTypeText(text), expected));
  }
});

// Classes (docs/node-authoring.md, gap 2): marked members of exported classes become nodes with a
// Target pin; Construct comes from the constructor.
describe('TypeScript classes', () => {
  const source = [
    'export class Player extends Entity {',
    '  /** @blueprint */',
    '  health: number = 100;',
    '  /**',
    '   * @blueprint readonly',
    '   */',
    '  name: string;',
    '  /** @blueprint */',
    '  private secret = 1;',
    '  /** @blueprint */',
    '  constructor(public start: number, label = "x") { super(); this.name = label; }',
    '  /** @blueprint */',
    '  heal(amount: number): number { return this.health += amount; }',
    '  /** @blueprint */',
    '  get alive(): boolean { return this.health > 0; }',
    '  /** @blueprint */',
    '  static make(): Player { return new Player(1); }',
    '  get(): number { return 1; }',
    '}',
    'class Hidden {',
    '  /** @blueprint */',
    '  go() {}',
    '}',
    ''
  ].join('\n');

  test('reads the constructor, methods, fields and accessors', () => {
    const [cls] = scanTypeScript(source).classes!;
    assert.deepEqual([cls.name, cls.type, cls.base], ['Player', { id: 'native:Player' }, { id: 'native:Entity' }]);
    assert.deepEqual(cls.init!.params, [{ name: 'start', type: { id: 'float' } }, { name: 'label', defaultValue: 'x' }]);
    assert.deepEqual(cls.methods.map((m) => m.name), ['heal', 'get']);
    assert.deepEqual(cls.properties.map((p) => [p.name, p.readonly]), [['health', false], ['name', false], ['alive', true]]);
  });

  test("says why marked members can't be nodes", () => {
    assert.deepEqual(scanTypeScript(source).skipped.filter((s) => s.marked).map((s) => [s.name, s.reason]), [
      ['Player.secret', "it isn't public"],
      ['Player.make', 'static methods of a class have no object; make it a module function instead'],
      ['Hidden.go', "its class Hidden isn't exported, so generated code can't import it"]
    ]);
  });

  test('marked members become Construct, member nodes with a Target, and Get and Set', () => {
    const { definitions } = exposeFunctions(scanTypeScript(source), TS);
    assert.deepEqual(definitions.map((d) => [d.type, d.displayName, [...d.inputs, ...d.outputs].filter((p) => p.kind === 'data').map((p) => p.id).join(',')]), [
      ['fn:typescript:src/combat.ts#Player:new', 'Construct Player', 'start,label,returnValue'],
      ['fn:typescript:src/combat.ts#Player:heal', 'Heal', 'target,amount,returnValue'],
      ['fn:typescript:src/combat.ts#Player:get:health', 'Get Health', 'target,returnValue'],
      ['fn:typescript:src/combat.ts#Player:set:health', 'Set Health', 'target,value'],
      ['fn:typescript:src/combat.ts#Player:get:name', 'Get Name', 'target,returnValue'],
      ['fn:typescript:src/combat.ts#Player:get:alive', 'Get Alive', 'target,returnValue']
    ]);
    const heal = definitions[1];
    assert.equal(heal.category, 'Project / Player');
    assert.deepEqual(heal.inputs.find((p) => p.id === 'target')?.type, { id: 'native:Player' });
    assert.deepEqual(heal.implementation?.kind === 'function' && heal.implementation.member, { kind: 'method', name: 'heal', type: 'native:Player', base: 'native:Entity' });
  });
});
