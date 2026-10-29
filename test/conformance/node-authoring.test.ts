// Phase 9's exit check (docs/node-authoring.md, "Exit check"): sample/node-authoring, a TypeScript
// and Python workspace that uses every path. Its graphs use a code class (Construct, a method, Get
// and Set, several outputs, an async method as a latent node), a function library generated for
// both languages, a snippet node whose examples pass, and a graph package as Add Blueprint Package
// leaves it. They're built as the extension builds them, and run in both languages.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatReport, outputLines, runNodeExamples } from '../../src/conformance/conformance';
import { compileDocument } from '../../src/core/compiler';
import { graphFileDefinitions } from '../../src/core/graph-files';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { definitionSite } from '../../src/core/navigation';
import { syncLibraryVersions, tagPackageDefinitions } from '../../src/core/node-packages';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { parseDocument } from '../../src/core/serializer';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';
import { pythonModule } from '../../src/extension/placement';
import { repoRoot } from '../unit/helpers';

const languages = builtinLanguagePacks();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-authoring-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.cpSync(path.join(repoRoot, 'sample/node-authoring'), root, { recursive: true });
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const doc = (file: string): GraphDocument => parseDocument(read(file), path.basename(file, '.vgraph')).document;

// The workspace's nodes, as the extension finds them: its code, its libraries (each generated in
// both languages), its package's library (tagged with the package), and its node files.
const LIBRARIES = ['libs/Scoring.vgraph', 'blueprint-packages/drills/Drills.vgraph'];
const lines = new Map<string, number>();
function workspaceNodes(): NodeDefinition[] {
  const nodes: NodeDefinition[] = [];
  for (const [language, file, module] of [['typescript', 'lib/dojo.ts', undefined], ['python', 'game/dojo.py', 'game.dojo']] as const) {
    const exposed = exposeFunctions(languages.get(language)!.importer!.scan!(read(file)), { language, path: file, module, exposeAll: false });
    nodes.push(...exposed.definitions);
    for (const [type, line] of exposed.lines) lines.set(type, line);
  }
  for (const file of LIBRARIES) {
    const library = doc(file);
    const output = (language: string) => {
      const generated = path.join(path.dirname(file), languages.get(language)!.generator!.outputFileName(path.basename(file))).split(path.sep).join('/');
      return { generatedPath: generated, ...(language === 'python' ? { module: pythonModule(path.join(root, generated), root).module } : {}) };
    };
    const definitions = graphFileDefinitions(library, { document: file, ...output('typescript'), others: { python: output('python') } }, languages.get('typescript')!.generator, (l) => languages.get(l)?.generator)!;
    const manifest = path.join(path.dirname(file), 'drills.vgraph-package.json');
    nodes.push(...(fs.existsSync(path.join(root, manifest)) ? tagPackageDefinitions(definitions, JSON.parse(read(manifest))) : definitions));
  }
  nodes.push(parseNodeDefinition(read('nodes/Clamp01.node.json'))!);
  return nodes;
}
const nodes = workspaceNodes();
const registry = new NodeRegistry();
registry.registerMany(nodes);

// Compiles a graph file in a language, writing what it generates next to it.
function compile(file: string, language: string): { file: string; className: string } {
  const result = compileDocument({ ...doc(file), language }, { registry, languages, generate: { sourceFileName: path.basename(file), outputDir: path.dirname(file).split(path.sep).join('/') } });
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), [], `${file} in ${language}`);
  const out = path.join(root, path.dirname(file), result.output!.fileName);
  fs.writeFileSync(out, result.output!.text);
  for (const companion of result.output!.companionFiles ?? []) fs.writeFileSync(path.join(path.dirname(out), companion.fileName), companion.text);
  return { file: out, className: result.output!.className };
}

describe('Phase 9 exit check: sample/node-authoring', () => {
  for (const file of LIBRARIES) for (const language of ['typescript', 'python']) compile(file, language);

  for (const [graph, language] of [['graphs/DojoTs.vgraph', 'typescript'], ['graphs/DojoPy.vgraph', 'python']] as const) {
    test(`${graph} runs in ${language} and prints what it expects`, async (t) => {
      const { file, className } = compile(graph, language);
      let outcome;
      try {
        outcome = await runGeneratedCode(languages.get(language)!.generator!.runner!, file, className, {
          cwd: path.dirname(file), importRoots: [root, path.join(root, 'libs'), path.join(root, 'blueprint-packages/drills')], timeoutMs: 120000
        });
      } catch (error) {
        if (error instanceof ToolNotFoundError) return t.skip(error.message);
        throw error;
      }
      assert.deepEqual(outputLines(outcome.stdout), doc(graph).metadata?.expectedOutput, `stderr:\n${outcome.stderr}`);
    });
  }

  test("each node reaches its definition: the class's code at its line, the libraries' graphs, the node file", () => {
    for (const graph of ['graphs/DojoTs.vgraph', 'graphs/DojoPy.vgraph']) {
      const document = doc(graph);
      const resolve = createResolver(registry, document);
      for (const node of document.graphs[0].nodes.filter((n) => !n.type.startsWith('core:'))) {
        const def = resolve(node)!;
        const site = definitionSite(node, def, document);
        assert.ok(site, `${graph}: ${node.id}`);
        if (site.kind === 'code') assert.ok(lines.get(node.type), `${node.type} has a line`);
        if (site.kind === 'library') assert.ok(fs.existsSync(path.join(root, site.document)), site.document);
      }
    }
  });

  test("the package's nodes carry its version, which graphs using them record", () => {
    const laps = registry.get('lib:blueprint-packages/drills/Drills.vgraph#Laps')!;
    assert.deepEqual(laps.library, { name: 'drills', version: '1.0.0' });
    const document = doc('graphs/DojoTs.vgraph');
    syncLibraryVersions(document, (type) => registry.get(type));
    assert.deepEqual(document.metadata?.libraries, { drills: '1.0.0' });
  });

  for (const language of ['typescript', 'python']) {
    test(`the node library's examples pass in ${language}`, async (t) => {
      const report = await runNodeExamples(languages.get(language)!, [registry.get('user.dojo.clamp01')!]);
      if (report.skipped) return t.skip(report.results[0].message);
      assert.equal(report.passed, 1, formatReport(report));
    });
  }
});
