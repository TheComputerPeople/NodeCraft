// Control flow across real code (docs/codebase-map.md, Part 2): every function and method of every
// fixture's generated code, in all 12 languages, and of the corpus of project layouts, has a
// flowchart in which every box is reached and leads somewhere.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { grammarForFile } from '../../src/core/parsing/grammars';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { parseDocument } from '../../src/core/serializer';
import { CodeParser } from '../../src/extension/code-parser';

const repoRoot = path.resolve(__dirname, '../../..');

function generatedCode(): { name: string; text: string }[] {
  const languages = builtinLanguagePacks();
  const registry = new NodeRegistry();
  for (const file of ['sample/visual-nodes/Math/Double.node.json', 'test/fixtures/nodes/Fail.node.json']) {
    registry.register(parseNodeDefinition(fs.readFileSync(path.join(repoRoot, file), 'utf8'))!);
  }
  const fixtures = fs.readdirSync(path.join(repoRoot, 'test/fixtures/graphs')).filter((f) => f.endsWith('.vgraph'));
  const files: { name: string; text: string }[] = [];
  for (const language of ['typescript', 'javascript', 'python', 'csharp', 'cpp', 'rust', 'java', 'go', 'lua', 'gdscript', 'ruby', 'php']) {
    for (const fixture of fixtures) {
      const document = parseDocument(fs.readFileSync(path.join(repoRoot, 'test/fixtures/graphs', fixture), 'utf8')).document;
      const output = compileDocument({ ...document, language }, { registry, languages, generate: { sourceFileName: fixture } }).output;
      if (!output) continue;
      files.push({ name: `${language}/${output.fileName}`, text: output.text });
      for (const companion of output.companionFiles ?? []) files.push({ name: `${language}/${companion.fileName}`, text: companion.text });
    }
  }
  return files;
}

function corpusCode(dir = path.join(repoRoot, 'test/fixtures/projects')): { name: string; text: string }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return /^(node_modules|target|build|bin|obj)$/.test(e.name) ? [] : corpusCode(full);
    return grammarForFile(e.name) ? [{ name: path.relative(repoRoot, full), text: fs.readFileSync(full, 'utf8') }] : [];
  });
}

describe('flowcharts of real code', () => {
  let parser: CodeParser;
  before(async () => {
    parser = await CodeParser.create(path.join(repoRoot, 'grammars'));
  });
  after(() => parser.dispose());

  for (const [what, files] of [['every fixture\'s generated code, in all 12 languages', generatedCode], ['the corpus of project layouts', corpusCode]] as const) {
    test(`${what}: every function charts, every box reached and leading somewhere`, async () => {
      const problems: string[] = [];
      let charts = 0;
      const grammars = new Set<string>();
      for (const { name, text } of files()) {
        const grammar = grammarForFile(name);
        if (!grammar) continue;
        const facts = await parser.facts(grammar, text);
        for (const d of facts.declarations.filter((x) => x.kind === 'function' || x.kind === 'method' || x.kind === 'constructor')) {
          const chart = await parser.flow(grammar, text, d.endLine > d.line ? d.line + 1 : d.line);
          if (!chart) continue;
          charts++;
          grammars.add(grammar);
          for (const node of chart.nodes) {
            if (node.kind !== 'start' && !chart.edges.some((e) => e.to === node.id)) problems.push(`${name}:${d.line} ${node.kind} "${node.label.slice(0, 30)}" isn't reached`);
            if (node.kind !== 'end' && !chart.edges.some((e) => e.from === node.id)) problems.push(`${name}:${d.line} ${node.kind} "${node.label.slice(0, 30)}" leads nowhere`);
          }
        }
      }
      assert.deepEqual(problems, []);
      assert.ok(charts > 100, `${charts} charts`);
      assert.ok(grammars.size >= 11, [...grammars].join(', '));
    });
  }
});
