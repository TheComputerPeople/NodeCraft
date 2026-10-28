// Rust graphs in a Cargo project (docs/language-breadth.md, "Rust"): placement declares generated
// modules at the crate root, a function marked @blueprint becomes a node that generated code calls
// through its module, and Run builds the crate's modules with the generated one.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { scanRust } from '../../src/core/importing/rust-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { RUST_BLOCK, rustPlacement } from '../../src/core/languages/rust';
import { RUST_RUNTIME } from '../../src/core/languages/rust-runtime';
import { withBlock } from '../../src/core/output-plan';
import { NodeRegistry } from '../../src/core/registry';
import { rustCrateModules, rustRunSources } from '../../src/extension/placement';
import { ToolNotFoundError, runCommand, runGeneratedCode } from '../../src/extension/runner';
import { doc, node, wire } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-rust-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const GAME = '//! The game.\npub mod combat;\n\npub fn base() -> f64 { 3.0 }\n';
const COMBAT = [
  '//! Combat rules.',
  '/// @blueprint',
  'pub fn triple(value: f64) -> f64 { value * crate::game::base() }',
  '',
  '/// @blueprint pure',
  'pub fn label(name: String, points: i64) -> String { format!("{}: {}", name, points) }',
  ''
].join('\n');

describe('Rust placement', () => {
  const context = (files: Record<string, string>, generatedFiles: string[], outputFile?: string) => ({
    outputFile, generatedFiles, readFile: (f: string) => files[f], exists: (f: string) => f in files
  });

  test('an owned runtime module, and a block in the crate root declaring it and each generated module', () => {
    const plan = rustPlacement(context({ 'Cargo.toml': '', 'src/lib.rs': '', 'src/main.rs': '' }, ['src/duel_vgraph.rs', 'src/graphs/fighter_vgraph.rs'], 'src/duel_vgraph.rs'));
    assert.deepEqual(plan.ownedFiles, [{ path: 'src/vgraph_runtime.rs', text: RUST_RUNTIME }]);
    assert.equal(plan.hooks?.length, 1);
    assert.equal(plan.hooks![0].file, 'src/lib.rs', 'the library root, when there is one');
    assert.equal(plan.hooks![0].block.text, 'pub mod vgraph_runtime;\npub mod duel_vgraph;\n#[path = "graphs/fighter_vgraph.rs"]\npub mod fighter_vgraph;');
    assert.deepEqual(plan.diagnostics, []);
  });

  test('a new block goes after the root\'s module declarations', () => {
    const plan = rustPlacement(context({ 'Cargo.toml': '', 'src/main.rs': '' }, ['src/duel_vgraph.rs']));
    const main = '//! App.\nmod game;\nuse std::fmt;\n\nmod inline {\n    use super::*;\n}\n\nfn main() {}\n';
    const placed = withBlock(main, plan.hooks![0].block);
    assert.ok(placed.startsWith(`//! App.\nmod game;\nuse std::fmt;\n${RUST_BLOCK.begin}\npub mod vgraph_runtime;\npub mod duel_vgraph;\n${RUST_BLOCK.end}\n\nmod inline {`), placed);
  });

  test('each crate of a workspace gets its own; a crate whose graphs are gone keeps an emptied block', () => {
    const files = { 'Cargo.toml': '[workspace]\nmembers = ["crates/app", "crates/old/"]\n', 'crates/app/Cargo.toml': '', 'crates/app/src/main.rs': '', 'crates/old/Cargo.toml': '', 'crates/old/src/lib.rs': '', 'crates/old/src/vgraph_runtime.rs': '' };
    const plan = rustPlacement(context(files, ['crates/app/src/menu_vgraph.rs']));
    assert.deepEqual(plan.hooks!.map((h) => [h.file, h.block.text]), [
      ['crates/app/src/main.rs', 'pub mod vgraph_runtime;\npub mod menu_vgraph;'],
      ['crates/old/src/lib.rs', 'pub mod vgraph_runtime;']
    ]);
  });

  test('a generated file outside a crate, or a crate without a root file, gets told what to do', () => {
    assert.match(rustPlacement(context({}, ['tools/x_vgraph.rs'], 'tools/x_vgraph.rs')).diagnostics![0].message, /isn't in a Cargo crate/);
    assert.match(rustPlacement(context({ 'Cargo.toml': '' }, ['src/x_vgraph.rs'], 'src/x_vgraph.rs')).diagnostics![0].message, /no src\/lib\.rs or src\/main\.rs/);
  });
});

describe('Rust project functions', () => {
  const project = path.join(workDir, 'game');
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "game"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n',
    'src/main.rs': 'mod game;\n\nfn main() {\n    let uses = crate::uses_vgraph::Uses::new();\n    uses.start();\n}\n',
    'src/game.rs': GAME,
    'src/game/combat.rs': COMBAT
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), text);
  }

  const registry = new NodeRegistry();
  const exposed = exposeFunctions(scanRust(COMBAT), { language: 'rust', path: 'src/game/combat.rs', module: 'game::combat', exposeAll: false });
  registry.registerMany(exposed.definitions);
  const d = doc(
    [
      node('s', 'core:event.start'),
      node('triple', 'fn:rust:src/game/combat.rs#triple', { 'pin:value': 14 }),
      node('p1', 'core:console.print'),
      node('label', 'fn:rust:src/game/combat.rs#label', { 'pin:name': 'Red', 'pin:points': 3 }),
      node('p2', 'core:console.print')
    ],
    [wire('s', 'execOut', 'triple', 'execIn'), wire('triple', 'execOut', 'p1', 'execIn'), wire('triple', 'returnValue', 'p1', 'value'), wire('p1', 'execOut', 'p2', 'execIn'), wire('label', 'returnValue', 'p2', 'value')]
  );
  const result = compileDocument({ ...doc([], []), ...d, name: 'Uses', language: 'rust' }, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Uses.vgraph', outputDir: 'src/graphs' } });
  const output = result.output!;
  const file = path.join(project, 'src/graphs', output.fileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, output.text);

  test('a graph calls them through their module in the crate', () => {
    assert.deepEqual(result.diagnostics, []);
    assert.match(output.text, /crate::game::combat::triple\(arg1\)/);
    assert.deepEqual(output.importedFiles, ['src/game/combat.rs']);
  });

  test('the crate registered by placement builds and runs the generated class', async (t) => {
    const plan = rustPlacement({
      outputFile: `src/graphs/${output.fileName}`, generatedFiles: [`src/graphs/${output.fileName}`],
      readFile: (f) => (fs.existsSync(path.join(project, f)) ? fs.readFileSync(path.join(project, f), 'utf8') : undefined),
      exists: (f) => fs.existsSync(path.join(project, f))
    });
    for (const owned of plan.ownedFiles ?? []) fs.writeFileSync(path.join(project, owned.path), owned.text);
    const main = path.join(project, plan.hooks![0].file);
    fs.writeFileSync(main, withBlock(fs.readFileSync(main, 'utf8'), plan.hooks![0].block));
    const run = await runCommand(['cargo', 'run', '--quiet'], { cwd: project, env: { CARGO_TERM_COLOR: 'never' }, timeoutMs: 300000 });
    if (!run) return t.skip('cargo isn\'t available here');
    assert.equal(run.exitCode, 0, run.stderr);
    assert.deepEqual(run.stdout.replace(/\r\n/g, '\n').trim().split('\n'), ['42', 'Red: 3']);
  });

  test('Run builds the crate\'s modules with the generated one', async (t) => {
    const sources = rustRunSources(file, project, output.importedFiles ?? []);
    assert.deepEqual(sources.crate, rustCrateModules(path.join(project, 'src/game/combat.rs'), project));
    assert.deepEqual(sources.crate?.modules, ['game'], 'not the generated modules placement declared');
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('rust')!.generator!.runner!, file, output.className, { cwd: project, sources: sources.generated, crate: sources.crate, timeoutMs: 300000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), ['42', 'Red: 3']);
  });
});

// Structs as classes (docs/node-authoring.md, gap 2): pub fields, and the methods and constructor
// of their impl blocks, used through Target pins. Rust has no inheritance, so BigCounter is a
// struct of its own with its own Add.
const COUNTER = [
  'pub struct Counter {',
  '    /// @blueprint',
  '    pub count: f64,',
  '}',
  '',
  'impl Counter {',
  '    /// @blueprint',
  '    pub fn new(start: f64) -> Self {',
  '        Counter { count: start }',
  '    }',
  '',
  '    /// @blueprint',
  '    pub fn add(&mut self, amount: f64) -> f64 {',
  '        self.count += amount;',
  '        self.count',
  '    }',
  '',
  '    /// @blueprint pure',
  '    pub fn doubled(&self) -> f64 {',
  '        self.count * 2.0',
  '    }',
  '}',
  '',
  'pub struct BigCounter {',
  '    count: f64,',
  '}',
  '',
  'impl BigCounter {',
  '    /// @blueprint',
  '    pub fn new(start: f64) -> Self {',
  '        BigCounter { count: start * 10.0 }',
  '    }',
  '',
  '    /// @blueprint',
  '    pub fn add(&mut self, amount: f64) -> f64 {',
  '        self.count += amount;',
  '        self.count',
  '    }',
  '}',
  ''
].join('\n');

describe('Rust code classes', () => {
  test('a graph constructs structs and uses their fields and methods', async (t) => {
    const project = path.join(workDir, 'classes');
    const files: Record<string, string> = {
      'Cargo.toml': '[package]\nname = "classes"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n',
      'src/main.rs': 'mod counter;\n\nfn main() {}\n',
      'src/counter.rs': COUNTER
    };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), text);
    }
    const definitions = exposeFunctions(scanRust(COUNTER), { language: 'rust', path: 'src/counter.rs', module: 'counter', exposeAll: false }).definitions;
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(codeClassGraph(definitions, 'rust'), { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Counting.vgraph', outputDir: 'src/graphs' } });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    const file = path.join(project, 'src/graphs', output.fileName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, output.text);
    const sources = rustRunSources(file, project, output.importedFiles ?? []);
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('rust')!.generator!.runner!, file, output.className, { cwd: project, sources: sources.generated, crate: sources.crate, timeoutMs: 300000 });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), CODE_CLASS_OUTPUT);
  });
});
