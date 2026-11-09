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
import { cppHeaderLinkage, cppRunSources } from '../../src/extension/placement';
import { ToolNotFoundError, runCommand, runGeneratedCode } from '../../src/extension/runner';
import { cppPlacement } from '../../src/core/languages/cpp';
import { withBlock } from '../../src/core/output-plan';
import { parseDocument } from '../../src/core/serializer';
import { doc, node, repoRoot, wire } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';
import { SEVERAL_OUTPUTS_OUTPUT, severalOutputsGraph } from './several-outputs';
import { LATENT_CODE_OUTPUT, latentCodeGraph } from './latent-code';

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

  test('a Makefile\'s $(wildcard) sources take in the generated files they match; the others are named', () => {
    assert.deepEqual(cppPlacement(context({ Makefile: 'SRC := $(wildcard *.cpp) $(wildcard ui/*.cpp)\n' })), {});
    assert.match(cppPlacement(context({ Makefile: 'SRC := $(wildcard ./*.cpp)\n# $(wildcard ui/*.cpp)\n' })).diagnostics![0].message, /Makefile's sources: ui\/Menu\.vgraph\.cpp\.$/);
  });

  test('two graphs of one name: one class in the global namespace, so the first is listed and the compile says why', () => {
    const plan = cppPlacement({ ...context({ 'CMakeLists.txt': 'add_executable(game main.cpp)\n' }, ['a/Fighter.vgraph.cpp', 'b/Fighter.vgraph.cpp']), outputFile: 'b/Fighter.vgraph.cpp' });
    assert.doesNotMatch(plan.ownedFiles![0].text, /b\/Fighter/);
    assert.match(plan.diagnostics![0].message, /a\/Fighter\.vgraph\.cpp and b\/Fighter\.vgraph\.cpp define classes of one name/);
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

  // C functions (docs/code-as-nodes.md): a header a C file implements, without extern "C" of its
  // own, is included in extern "C", and Run compiles the C file as C, so the call links.
  test('a graph calls a C file\'s function; its header is included in extern "C", and Run compiles the C file as C', async (t) => {
    const dir = path.join(workDir, 'c-functions');
    fs.mkdirSync(path.join(dir, 'native'), { recursive: true });
    const header = '#ifndef MEASURE_H\n#define MEASURE_H\n\n/// @blueprint pure\ndouble area(double width, double height);\n\n#endif\n';
    fs.writeFileSync(path.join(dir, 'native/measure.h'), header);
    fs.writeFileSync(path.join(dir, 'native/measure.c'), '#include "measure.h"\n\ndouble area(double width, double height) { return width * height; }\n');
    const linkage = cppHeaderLinkage(path.join(dir, 'native/measure.h'));
    assert.equal(linkage, 'c');
    const registry = new NodeRegistry();
    registry.registerMany(exposeFunctions(scanCpp(header), { language: 'cpp', path: 'native/measure.h', exposeAll: false, linkage }).definitions);
    const d = doc([node('s', 'core:event.start'), node('area', 'fn:cpp:native/measure.h#area', { 'pin:width': 3, 'pin:height': 2.5 }), node('p', 'core:console.print')],
      [wire('s', 'execOut', 'p', 'execIn'), wire('area', 'returnValue', 'p', 'value')]);
    const result = compileDocument({ ...doc([], []), ...d, name: 'Room', language: 'cpp' }, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Room.vgraph', outputDir: '' } });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    assert.match(output.text, /^extern "C" \{\n#include "native\/measure\.h"\n\}$/m);
    const file = path.join(dir, output.fileName);
    fs.writeFileSync(file, output.text);
    for (const companion of output.companionFiles ?? []) fs.writeFileSync(path.join(dir, companion.fileName), companion.text);
    assert.deepEqual(cppRunSources(file), [path.join(dir, 'native/measure.c')], 'the C file, beside its header');
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('cpp')!.generator!.runner!, file, output.className, { cwd: dir, sources: cppRunSources(file), timeoutMs: 120000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.deepEqual(outcome.stdout.trim().split(/\r?\n/), ['7.5']);
    // A header with extern "C" of its own (as Expose Functions as Nodes makes one) needs nothing.
    fs.writeFileSync(path.join(dir, 'native/measure.h'), `#ifdef __cplusplus\nextern "C" {\n#endif\n${header}#ifdef __cplusplus\n}\n#endif\n`);
    assert.equal(cppHeaderLinkage(path.join(dir, 'native/measure.h')), undefined);
  });
});

// Visual Studio projects (docs/output-placement.md, "C and C++"): an owned vgraph.targets lists the
// generated files, and a block in the .vcxproj imports it, before </Project>.
describe('C++ placement in Visual Studio projects', () => {
  const VCXPROJ = '<?xml version="1.0" encoding="utf-8"?>\r\n<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\r\n  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.targets" />\r\n</Project>\r\n';
  const context = (files: Record<string, string>, generatedFiles: string[]) => ({
    generatedFiles, readFile: (f: string) => files[f], exists: (f: string) => f in files,
    list: (dir: string) => Object.keys(files).filter((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '') === dir).map((f) => f.split('/').pop()!)
  });

  test('each generated file goes to the nearest .vcxproj above it', () => {
    const plan = cppPlacement(context({ 'Game/Game.vcxproj': VCXPROJ, 'Tools/Tools.vcxproj': VCXPROJ }, ['Game/graphs/Main.vgraph.cpp', 'Tools/Menu.vgraph.cpp']));
    assert.deepEqual(plan.ownedFiles?.map((f) => f.path), ['Game/vgraph.targets', 'Tools/vgraph.targets']);
    assert.match(plan.ownedFiles![0].text, /<ClCompile Include="\$\(MSBuildThisFileDirectory\)graphs\\Main\.vgraph\.cpp">\r\n {6}<LanguageStandard>stdcpp20<\/LanguageStandard>/);
    assert.match(plan.ownedFiles![0].text, /<ClInclude Include="\$\(MSBuildThisFileDirectory\)graphs\\Main\.vgraph\.h" \/>/);
    assert.deepEqual(plan.hooks?.map((h) => h.file), ['Game/Game.vcxproj', 'Tools/Tools.vcxproj']);
    const placed = withBlock(VCXPROJ, plan.hooks![0].block);
    assert.match(placed, /<!-- vgraph:begin \(managed by Blueprint Visual Scripting\) -->\r\n {2}<Import Project="vgraph\.targets" \/>\r\n<!-- vgraph:end -->\r\n<\/Project>\r\n$/);
  });

  test('without a way to list folders, or a .vcxproj, it falls back to the other build systems', () => {
    assert.deepEqual(cppPlacement({ generatedFiles: ['Main.vgraph.cpp'], readFile: () => undefined, exists: () => false }), {});
    assert.deepEqual(cppPlacement(context({ 'Makefile': 'SRC := $(wildcard *.cpp)\n' }, ['Main.vgraph.cpp'])), {});
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

// Several outputs (docs/node-authoring.md, gap 3): non-const reference parameters, or a std::tuple
// named by @outputs.
describe('C++ several outputs', () => {
  const HEADERS: Record<string, string> = {
    'out parameters': [
      '#pragma once',
      '',
      'namespace math {',
      '/// @blueprint',
      'inline void divide(int a, int b, int& quotient, int& remainder) {',
      '    quotient = a / b;',
      '    remainder = a % b;',
      '}',
      '}',
      ''
    ].join('\n'),
    'a tuple': [
      '#pragma once',
      '#include <tuple>',
      '',
      'namespace math {',
      '/// @blueprint',
      '/// @outputs quotient remainder',
      'inline std::tuple<int, int> divide(int a, int b) { return { a / b, a % b }; }',
      '}',
      ''
    ].join('\n')
  };
  for (const [label, header] of Object.entries(HEADERS)) {
    test(`a graph reads each output (${label})`, async (t) => {
      const dir = path.join(workDir, `outputs-${label.replace(/ /g, '-')}`);
      fs.mkdirSync(path.join(dir, 'native'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'native/divide.h'), header);
      const registry = new NodeRegistry();
      const definitions = exposeFunctions(scanCpp(header), { language: 'cpp', path: 'native/divide.h', exposeAll: false }).definitions;
      registry.registerMany(definitions);
      const result = compileDocument(severalOutputsGraph(definitions, 'cpp'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Dividing.vgraph', outputDir: '' } });
      assert.deepEqual(result.diagnostics, []);
      const output = result.output!;
      if (label === 'out parameters') assert.match(output.text, /int vg_out1_0\{\};\n\s*int vg_out1_1\{\};\n\s*math::divide\(17, 5, vg_out1_0, vg_out1_1\);/);
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
      assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), SEVERAL_OUTPUTS_OUTPUT);
    });
  }
});

// Async functions (docs/node-authoring.md, gap 4): a function returning a std::future is a latent
// node, whose Completed runs when the future is ready.
describe('C++ async functions', () => {
  const header = (result: string) => [
    '#pragma once',
    '#include <chrono>',
    '#include <future>',
    '#include <stdexcept>',
    '#include <thread>',
    '',
    'namespace remote {',
    '/// @blueprint',
    'inline std::future<long long> fetch_double(long long value) {',
    '    return std::async(std::launch::async, [value]() -> long long {',
    '        std::this_thread::sleep_for(std::chrono::milliseconds(10));',
    `        ${result};`,
    '    });',
    '}',
    '}',
    ''
  ].join('\n');

  async function run(name: string, text: string): Promise<{ outcome?: Awaited<ReturnType<typeof runGeneratedCode>>; skipped?: string; generated: string }> {
    const dir = path.join(workDir, name);
    fs.mkdirSync(path.join(dir, 'native'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'native/remote.h'), text);
    const registry = new NodeRegistry();
    const definitions = exposeFunctions(scanCpp(text), { language: 'cpp', path: 'native/remote.h', exposeAll: false }).definitions;
    registry.registerMany(definitions);
    const result = compileDocument(latentCodeGraph(definitions, 'cpp'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Fetching.vgraph', outputDir: '' } });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    const file = path.join(dir, output.fileName);
    fs.writeFileSync(file, output.text);
    for (const companion of output.companionFiles ?? []) fs.writeFileSync(path.join(dir, companion.fileName), companion.text);
    try {
      return { outcome: await runGeneratedCode(builtinLanguagePacks().get('cpp')!.generator!.runner!, file, output.className, { cwd: dir, timeoutMs: 120000 }), generated: output.text };
    } catch (error) {
      if (error instanceof ToolNotFoundError) return { skipped: error.message, generated: output.text };
      throw error;
    }
  }

  test('a graph waits for a future and reads its value on Completed', async (t) => {
    const { outcome, skipped, generated } = await run('latent', header('return value * 2'));
    assert.match(generated, /vgraph::await_latent\(remote::fetch_double\(4(LL)?\), \[=, this\]\(auto value\) \{/);
    if (!outcome) return t.skip(skipped);
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), LATENT_CODE_OUTPUT);
  });

  test("a future that fails stops the run with its exception, and Completed doesn't run", async (t) => {
    const { outcome, skipped } = await run('latent-fails', header('throw std::runtime_error("no double for " + std::to_string(value))'));
    if (!outcome) return t.skip(skipped);
    assert.notEqual(outcome.exitCode, 0);
    assert.match(outcome.stderr, /no double for 4/);
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), ['started']);
  });
});
