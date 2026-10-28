// C++ graphs calling the project's own functions (docs/language-breadth.md, "C++"): a function
// marked @blueprint in a header becomes a node, generated code includes the header, and Run
// compiles the header's implementation file with it.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { scanCpp } from '../../src/core/importing/cpp-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeRegistry } from '../../src/core/registry';
import { cppRunSources } from '../../src/extension/placement';
import { ToolNotFoundError, runCommand, runGeneratedCode } from '../../src/extension/runner';
import { cppPlacement } from '../../src/core/languages/cpp';
import { withBlock } from '../../src/core/output-plan';
import { parseDocument } from '../../src/core/serializer';
import { doc, node, repoRoot, wire } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-cpp-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const HEADER = [
  '#pragma once',
  '#include <string>',
  '',
  'namespace scoring {',
  '/// @blueprint',
  'double triple(double value);',
  '/// @blueprint pure',
  'std::string label(const std::string& name, long long points = 1);',
  '}',
  ''
].join('\n');
const SOURCE = [
  '#include "score.h"',
  '',
  'namespace scoring {',
  'double triple(double value) { return value * 3; }',
  'std::string label(const std::string& name, long long points) { return name + ": " + std::to_string(points); }',
  '}',
  ''
].join('\n');

describe('C++ placement', () => {
  const context = (files: Record<string, string>, generatedFiles = ['Game.vgraph.cpp', 'ui/Menu.vgraph.cpp']) => ({
    generatedFiles, readFile: (f: string) => files[f], exists: (f: string) => f in files
  });

  test('CMake: an owned list of the generated sources, and a block adding them to the first target', () => {
    const plan = cppPlacement(context({ 'CMakeLists.txt': 'project(demo CXX)\n# add_library(old x.cpp)\nadd_executable(game main.cpp)\n' }));
    assert.equal(plan.ownedFiles?.[0].path, 'vgraph.cmake');
    assert.match(plan.ownedFiles![0].text, /set\(VGRAPH_SOURCES\n {4}\$\{CMAKE_CURRENT_LIST_DIR\}\/Game\.vgraph\.cpp\n {4}\$\{CMAKE_CURRENT_LIST_DIR\}\/ui\/Menu\.vgraph\.cpp\n\)/);
    assert.equal(plan.hooks?.[0].file, 'CMakeLists.txt');
    assert.match(plan.hooks![0].block.text, /target_sources\(game PRIVATE \$\{VGRAPH_SOURCES\}\)/);
    assert.match(plan.hooks![0].description, /the game target/);
  });

  test('a project that globs its sources needs nothing; one without a target or CMake gets told what to add', () => {
    assert.deepEqual(cppPlacement(context({ 'CMakeLists.txt': 'file(GLOB_RECURSE SRC src/*.cpp)\nadd_executable(game ${SRC})\n' })), {});
    assert.match(cppPlacement(context({ 'CMakeLists.txt': 'project(x)\n' })).diagnostics![0].message, /no add_executable or add_library/);
    assert.match(cppPlacement(context({ 'meson.build': '' })).diagnostics![0].message, /meson\.build's sources: Game\.vgraph\.cpp, ui\/Menu\.vgraph\.cpp/);
    assert.deepEqual(cppPlacement(context({})), {}, 'no build system: nothing to register');
  });

  test('a CMake project registered this way builds and runs the generated class', async (t) => {
    const dir = path.join(workDir, 'cmake');
    fs.mkdirSync(dir, { recursive: true });
    const sample = parseDocument(fs.readFileSync(path.join(repoRoot, 'sample/demo.vgraph'), 'utf8')).document;
    const output = compileDocument({ ...sample, language: 'cpp' }, { registry: new NodeRegistry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'Demo.vgraph' } }).output!;
    fs.writeFileSync(path.join(dir, output.fileName), output.text);
    for (const companion of output.companionFiles ?? []) fs.writeFileSync(path.join(dir, companion.fileName), companion.text);
    fs.writeFileSync(path.join(dir, 'main.cpp'), `#include "Demo.vgraph.h"\nint main() {\n    auto demo = std::make_shared<${output.className}>();\n    demo->start();\n}\n`);
    const cmake = 'cmake_minimum_required(VERSION 3.20)\nproject(demo CXX)\nadd_executable(app main.cpp)\n';
    const plan = cppPlacement(context({ 'CMakeLists.txt': cmake }, [output.fileName]));
    fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), withBlock(cmake, plan.hooks![0].block));
    fs.writeFileSync(path.join(dir, 'vgraph.cmake'), plan.ownedFiles![0].text);
    const configure = await runCommand(['cmake', '-S', '.', '-B', 'build', '-G', 'Ninja', '-DCMAKE_CXX_COMPILER=g++'], { cwd: dir, timeoutMs: 120000 });
    if (!configure || configure.exitCode !== 0) return t.skip(`CMake with Ninja and g++ isn't available here: ${configure?.stderr ?? 'cmake not found'}`);
    const build = await runCommand(['cmake', '--build', 'build'], { cwd: dir, timeoutMs: 300000 });
    assert.equal(build?.exitCode, 0, `${build?.stdout}\n${build?.stderr}`);
    const run = await runCommand([path.join(dir, 'build', process.platform === 'win32' ? 'app.exe' : 'app')], { cwd: dir, timeoutMs: 30000 });
    assert.equal(run?.stdout.trim(), '30');
  });
});

describe('C++ project functions', () => {
  test('a graph calls functions from a header, and Run builds the header\'s implementation with it', async (t) => {
    fs.mkdirSync(path.join(workDir, 'native'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'native/score.h'), HEADER);
    fs.writeFileSync(path.join(workDir, 'native/score.cpp'), SOURCE);
    const registry = new NodeRegistry();
    const exposed = exposeFunctions(scanCpp(HEADER), { language: 'cpp', path: 'native/score.h', exposeAll: false });
    registry.registerMany(exposed.definitions);
    const d = doc(
      [
        node('s', 'core:event.start'),
        node('triple', 'fn:cpp:native/score.h#scoring.triple', { 'pin:value': 14 }),
        node('p1', 'core:console.print'),
        node('label', 'fn:cpp:native/score.h#scoring.label', { 'pin:name': 'Red', 'pin:points': 3 }),
        node('p2', 'core:console.print')
      ],
      [wire('s', 'execOut', 'triple', 'execIn'), wire('triple', 'execOut', 'p1', 'execIn'), wire('triple', 'returnValue', 'p1', 'value'), wire('p1', 'execOut', 'p2', 'execIn'), wire('label', 'returnValue', 'p2', 'value')]
    );
    const result = compileDocument({ ...doc([], []), ...d, name: 'Uses', language: 'cpp' }, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Uses.vgraph', outputDir: '' } });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    assert.match(output.text, /^#include "native\/score\.h"$/m);
    assert.match(output.text, /scoring::triple\(14\.0\)/);
    const file = path.join(workDir, output.fileName);
    fs.writeFileSync(file, output.text);
    for (const companion of output.companionFiles ?? []) fs.writeFileSync(path.join(workDir, companion.fileName), companion.text);
    assert.deepEqual(cppRunSources(file), [path.join(workDir, 'native/score.cpp')]);
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('cpp')!.generator!.runner!, file, output.className, { cwd: workDir, sources: cppRunSources(file), timeoutMs: 120000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), ['42', 'Red: 3']);
  });
});

// Classes from a header (docs/node-authoring.md, gap 2): their objects travel in a std::any as each
// class they can be used as, so a BigCounter reaches Counter's members.
const COUNTER = [
  '#pragma once',
  'namespace game {',
  '',
  'class Counter {',
  'public:',
  '    /// @blueprint',
  '    double count = 0;',
  '',
  '    /// @blueprint',
  '    explicit Counter(double start) : count(start) {}',
  '    virtual ~Counter() = default;',
  '',
  '    /// @blueprint',
  '    double add(double amount) {',
  '        count += amount;',
  '        return count;',
  '    }',
  '',
  '    /// @blueprint pure',
  '    double doubled() const { return count * 2; }',
  '};',
  '',
  'class BigCounter : public Counter {',
  'public:',
  '    /// @blueprint',
  '    explicit BigCounter(double start) : Counter(start * 10) {}',
  '};',
  '',
  '}',
  ''
].join('\n');

describe('C++ code classes', () => {
  test('a graph constructs them and uses their members, a subclass where its base is expected', async (t) => {
    const dir = path.join(workDir, 'classes');
    fs.mkdirSync(path.join(dir, 'native'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'native/counter.h'), COUNTER);
    const registry = new NodeRegistry();
    const definitions = exposeFunctions(scanCpp(COUNTER), { language: 'cpp', path: 'native/counter.h', exposeAll: false }).definitions;
    registry.registerMany(definitions);
    const result = compileDocument(codeClassGraph(definitions, 'cpp'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Counting.vgraph', outputDir: '' } });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    assert.match(output.text, /vgraph::code_new<game::BigCounter, game::Counter>\(1\.0\)/);
    const file = path.join(dir, output.fileName);
    fs.writeFileSync(file, output.text);
    for (const companion of output.companionFiles ?? []) fs.writeFileSync(path.join(dir, companion.fileName), companion.text);
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('cpp')!.generator!.runner!, file, output.className, { cwd: dir, timeoutMs: 120000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), CODE_CLASS_OUTPUT);
  });
});
