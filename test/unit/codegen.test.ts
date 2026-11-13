import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CompileResult, compileDocument } from '../../src/core/compiler';
import { pythonModuleName, relativeSpecifier, typescriptSpecifier } from '../../src/core/compiler/module-paths';
import { NameScope, dedent, toIdentifier } from '../../src/core/compiler/names';
import { GenerateOptions } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { doc, node, readRepoFile, repoRoot, wire } from './helpers';

export function fixtureRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register(parseNodeDefinition(readRepoFile('sample/visual-nodes/Math/Double.node.json'))!);
  return registry;
}

export function compileAs(d: GraphDocument, language: string, sourceFileName = 'graph.vgraph', moduleFormat?: 'esm' | 'commonjs'): CompileResult {
  return compileDocument({ ...d, language }, { registry: fixtureRegistry(), languages: builtinLanguagePacks(), generate: { sourceFileName, moduleFormat } });
}

// Compares generated code with a committed golden file; UPDATE_GOLDEN=1 rewrites the goldens.
function matchesGolden(text: string, goldenName: string): void {
  const file = path.join(repoRoot, 'test/fixtures/codegen', goldenName);
  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  assert.equal(text, fs.readFileSync(file, 'utf8'), `${goldenName} differs from its golden file (run with UPDATE_GOLDEN=1 to accept)`);
}

const sample = () => parseDocument(readRepoFile('sample/demo.vgraph')).document;
const features = () => parseDocument(readRepoFile('test/fixtures/graphs/features.vgraph')).document;

describe('golden files', () => {
  for (const [label, load] of [['demo', sample], ['features', features]] as const) {
    const expectedFile: Record<string, string> = { typescript: `${label}.vgraph.ts`, javascript: `${label}.vgraph.js`, python: `${label}_vgraph.py`, csharp: `${label}.vgraph.cs` };
    for (const [language, fileName] of Object.entries(expectedFile)) {
      test(`${label} matches its ${language} golden file`, () => {
        const result = compileAs(load(), language, `${label}.vgraph`);
        assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
        assert.equal(result.output?.fileName, fileName);
        matchesGolden(result.output!.text, fileName);
      });
    }
  }
});

describe('Python generation', () => {
  test('names the module so it can be imported', () => {
    assert.equal(compileAs(sample(), 'python', 'BlueprintDemo.vgraph').output?.fileName, 'blueprint_demo_vgraph.py');
  });

  test('records node lines after the module header', () => {
    const output = compileAs(sample(), 'python', 'demo.vgraph').output!;
    const lines = output.text.split('\n');
    for (const { nodeId, line } of output.nodeLines) assert.match(lines[line - 2], new RegExp(`# .+ \\(${nodeId}\\)$`));
  });

  test('writes pass for empty branches', () => {
    const d = doc(
      [node('s', 'core:event.start'), node('g', 'core:variable.get', { variable: 'flag' }), node('br', 'core:flow.branch'), node('p', 'core:console.print', { 'pin:value': 'no' })],
      [wire('s', 'execOut', 'br', 'execIn'), wire('g', 'value', 'br', 'condition'), wire('br', 'false', 'p', 'execIn')],
      [{ id: 'flag', name: 'Flag', type: { id: 'bool' }, defaultValue: true }]
    );
    assert.match(compileAs(d, 'python').output!.text, /if self\.Flag:\n {12}pass\n {8}else:\n/);
  });
});

describe('TypeScript and JavaScript generation', () => {

  test('JavaScript for CommonJS projects exports with module.exports', () => {
    const text = compileAs(sample(), 'javascript', 'demo.vgraph', 'commonjs').output!.text;
    assert.match(text, /^class BlueprintDemo \{/m);
    assert.match(text, /module\.exports = \{ BlueprintDemo \};\n$/);
  });

  test('records the line where each node starts', () => {
    const output = compileAs(sample(), 'typescript', 'demo.vgraph').output!;
    const lines = output.text.split('\n');
    for (const { nodeId, line } of output.nodeLines) {
      assert.match(lines[line - 2], new RegExp(`// .+ \\(${nodeId}\\)$`), `marker above line ${line} for ${nodeId}`);
    }
    // The sample's Branch has an unconnected condition (true): only its True side is generated.
    assert.deepEqual(output.nodeLines.map((l) => l.nodeId), ['add_1', 'print_true']);
  });

  test('only includes the format helper when a value has no static type', () => {
    assert.doesNotMatch(compileAs(sample(), 'typescript').output!.text, /function formatValue/);
    assert.match(compileAs(features(), 'typescript').output!.text, /function formatValue/);
  });

  test('makes class and member names legal and unique', () => {
    const d = doc(
      [node('s', 'core:event.start'), node('set', 'core:variable.set', { variable: 'v', 'pin:value': 1 })],
      [wire('s', 'execOut', 'set', 'execIn')],
      [{ id: 'v', name: 'class', type: { id: 'any' } }]
    );
    d.name = 'my cool-graph';
    const text = compileAs(d, 'typescript').output!.text;
    assert.match(text, /export class MyCoolGraph \{/);
    assert.match(text, /\n {2}class_: unknown = null;/);
    assert.match(text, /this\.class_ = 1;/);
  });

  test('reports languages without a generator', () => {
    const result = compileAs(sample(), 'cobol');
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['unknown-language']);
  });
});

describe('project function imports', () => {
  // Start → Save (impure) → Print(Double(4)), with a function whose name clashes with the class.
  const fn = (language: string, path: string, name: string, pure: boolean, module?: string): NodeDefinition => ({
    type: `fn:${language}:${path}#${name}`, version: 1, displayName: name, category: 'Project',
    inputs: [
      ...(pure ? [] : [{ id: 'execIn', name: '', kind: 'exec' as const, direction: 'input' as const }]),
      { id: 'value', name: 'Value', kind: 'data', direction: 'input', type: { id: 'float' } }
    ],
    outputs: [
      ...(pure ? [] : [{ id: 'execOut', name: '', kind: 'exec' as const, direction: 'output' as const }]),
      { id: 'returnValue', name: 'Return Value', kind: 'data', direction: 'output', type: { id: 'float' } }
    ],
    implementation: { kind: 'function', language, path, name, ...(module ? { module } : {}) }
  });
  const compileWith = (language: string, ext: string, generate: Partial<GenerateOptions> = {}, module?: string) => {
    const lib = language === 'python' ? 'lib/math.py' : `lib/math.${ext}`;
    const defs = [fn(language, lib, 'double', true, module), fn(language, lib, 'save', false, module), fn(language, language === 'python' ? 'lib/other.py' : `lib/other.${ext}`, 'Test', true, module && 'lib.other')];
    const registry = new NodeRegistry();
    registry.registerMany(defs);
    const d = doc(
      [node('s', 'core:event.start'), node('f', defs[1].type), node('d', defs[0].type, { 'pin:value': 4 }), node('t', defs[2].type), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'f', 'execIn'), wire('f', 'execOut', 'p', 'execIn'), wire('t', 'returnValue', 'd', 'value'), wire('d', 'returnValue', 'p', 'value')]
    );
    const result = compileDocument({ ...d, language }, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'graph.vgraph', outputDir: 'graphs', ...generate } });
    assert.deepEqual(result.diagnostics.filter((x) => x.severity === 'error'), []);
    return result.output!.text;
  };

  test('TypeScript imports each module once, relative to the generated file, aliasing clashes', () => {
    const text = compileWith('typescript', 'ts');
    assert.match(text, /^import \{ double, save \} from "\.\.\/lib\/math\.ts";$/m);
    assert.match(text, /^import \{ Test as Test_2 \} from "\.\.\/lib\/other\.ts";$/m);
    assert.match(text, /^ {4}save\(/m, 'impure: called once');
    assert.doesNotMatch(text, /f_returnValue/, 'its result, which nothing reads, is not kept');
    assert.match(text, /console\.log\(String\(double\(Test_2\(/, 'pure: called where used');
  });

  test("TypeScript follows the project's import extension", () => {
    assert.match(compileWith('typescript', 'ts', { importExtension: 'js' }), /from "\.\.\/lib\/math\.js";/);
    assert.match(compileWith('typescript', 'ts', { importExtension: 'none' }), /from "\.\.\/lib\/math";/);
    assert.match(compileWith('typescript', 'mts', { importExtension: 'none' }), /from "\.\.\/lib\/math\.mjs";/, '.mts needs an extension');
  });

  test('JavaScript imports or requires with the real extension', () => {
    assert.match(compileWith('javascript', 'js'), /^import \{ double, save \} from "\.\.\/lib\/math\.js";$/m);
    const cjs = compileWith('javascript', 'cjs', { moduleFormat: 'commonjs' });
    assert.match(cjs, /^const \{ double, save \} = require\("\.\.\/lib\/math\.cjs"\);$/m);
    assert.match(cjs, /^const \{ Test: Test_2 \} = require\("\.\.\/lib\/other\.cjs"\);$/m);
  });

  test('Python imports by module name', () => {
    const text = compileWith('python', 'py', {}, 'lib.math');
    assert.match(text, /^from lib\.math import double, save$/m);
    assert.match(text, /^from lib\.other import Test as Test_2$/m);
    assert.match(text, /print\(_format_value\(double\(Test_2\(/);
  });
});

describe('module paths', () => {
  test('relative specifiers', () => {
    assert.equal(relativeSpecifier('', 'math.ts'), './math.ts');
    assert.equal(relativeSpecifier('graphs', 'lib/math.ts'), '../lib/math.ts');
    assert.equal(relativeSpecifier('src/graphs', 'src/lib/math.ts'), '../lib/math.ts');
    assert.equal(relativeSpecifier('src', 'src/math.ts'), './math.ts');
    assert.equal(relativeSpecifier('a/b', 'a/b/c/d.ts'), './c/d.ts');
  });

  test('TypeScript extensions', () => {
    assert.equal(typescriptSpecifier('', 'a.ts', 'js'), './a.js');
    assert.equal(typescriptSpecifier('', 'a.cts', 'js'), './a.cjs');
    assert.equal(typescriptSpecifier('', 'a.ts', 'none'), './a');
    assert.equal(typescriptSpecifier('', 'a.js', 'none'), './a.js', 'JavaScript keeps its extension');
  });

  test('Python module names from paths', () => {
    assert.equal(pythonModuleName('combat.py'), 'combat');
    assert.equal(pythonModuleName('game/combat.py'), 'game.combat');
    assert.equal(pythonModuleName('game/__init__.py'), 'game');
  });
});

describe('identifier helpers', () => {
  test('toIdentifier converts between styles', () => {
    assert.equal(toIdentifier('BlueprintDemo', 'snake'), 'blueprint_demo');
    assert.equal(toIdentifier('user.math.double', 'pascal'), 'UserMathDouble');
    assert.equal(toIdentifier('HTTPServer v2', 'snake'), 'http_server_v_2');
    assert.equal(toIdentifier('add-1', 'keep'), 'add_1');
    assert.equal(toIdentifier('1st', 'keep'), '_1st');
    assert.equal(toIdentifier('***', 'keep'), 'value');
  });

  test('NameScope avoids keywords and duplicates', () => {
    const scope = new NameScope(new Set(['class']), ['start']);
    assert.deepEqual([scope.claim('class'), scope.claim('start'), scope.claim('a b'), scope.claim('a_b')], ['class_', 'start_2', 'a_b', 'a_b_2']);
  });

  test('dedent strips shared indentation and blank edges', () => {
    assert.deepEqual(dedent('\n    if (x) {\n      y();\n    }\n'), ['if (x) {', '  y();', '}']);
  });
});

// docs/audit.md, second pass. The conformance fixtures string-literals.vgraph and names.vgraph run
// these in every language; here they're checked where no toolchain is installed.
describe("what a language can't take as it is", () => {
  const printing = (value: string) => doc([node('s', 'core:event.start'), node('p', 'core:console.print', { 'pin:value': value })], [wire('s', 'execOut', 'p', 'execIn')]);
  const named = (name: string) => doc([node('s', 'core:event.start'), node('g', 'core:variable.get', { variable: 'v' }), node('p', 'core:console.print')],
    [wire('s', 'execOut', 'p', 'execIn'), wire('g', 'value', 'p', 'value')], [{ id: 'v', name, type: { id: 'string' }, defaultValue: 'x' }]);

  test('C#: U+0085, U+2028 and U+2029 in a string are escaped, as C# ends a line at them', () => {
    const text = compileAs(printing('a' + String.fromCharCode(0x85) + 'b' + String.fromCharCode(0x2028) + 'c' + String.fromCharCode(0x2029) + 'd'), 'csharp').output!.text;
    assert.ok(!new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`).test(text));
    const u = (code: string) => String.fromCharCode(92) + 'u' + code;
    assert.ok(text.includes(`"a${u('0085')}b${u('2028')}c${u('2029')}d"`));
  });

  test('C++: a name a standard header defines as a macro is renamed', () => {
    for (const name of ['NULL', 'EOF', 'errno', 'stdout', 'assert', 'INT_MAX', 'M_PI', 'SIZE_MAX', 'linux']) {
      // Declared in the header, used in the .cpp file.
      const output = compileAs(named(name), 'cpp').output!;
      const text = [output.text, ...(output.companionFiles ?? []).map((f) => f.text)].join('\n');
      assert.ok(text.includes(`std::string ${name}_ = `), `${name} is declared as ${name}_`);
      assert.ok(!text.includes(`std::string ${name} = `) && !text.includes(`<< ${name} <<`), `${name} isn't used as it is`);
    }
  });

  test('GDScript: namespace and trait, reserved for later versions, are renamed', () => {
    for (const name of ['namespace', 'trait']) {
      const text = compileAs(named(name), 'gdscript').output!.text;
      assert.ok(!new RegExp(`^var ${name}(?![A-Za-z0-9_])`, 'm').test(text), text);
    }
  });

  // member-names.vgraph runs this: languages that read a member by its bare name.
  test("C++, C#, Java and GDScript: a function's input named like a class variable doesn't hide it", () => {
    const graph = doc([node('s', 'core:event.start'), node('c', 'core:function.call', { graph: 'f', 'pin:in': 'new' })], [wire('s', 'execOut', 'c', 'execIn')],
      [{ id: 'v', name: 'value', type: { id: 'string' }, defaultValue: 'old' }]);
    graph.graphs.push({
      id: 'f', name: 'Store', kind: 'function',
      signature: { inputs: [{ id: 'in', name: 'value', kind: 'data', type: { id: 'string' } }], outputs: [] },
      nodes: [node('e', 'core:function.entry', { graph: 'f' }), node('set', 'core:variable.set', { variable: 'v' }), node('r', 'core:function.return', { graph: 'f' })],
      connections: [wire('e', 'execOut', 'set', 'execIn'), wire('e', 'in', 'set', 'value'), wire('set', 'execOut', 'r', 'execIn')], comments: []
    });
    for (const language of ['cpp', 'csharp', 'java', 'gdscript']) {
      const text = compileAs(graph, language).output!.text;
      assert.ok(!/\bvalue = value\b/.test(text), `${language}: ${text}`);
      assert.match(text, /\bvalue = value_2\b/, language);
    }
  });
});
