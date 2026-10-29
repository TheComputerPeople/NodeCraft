// Java graphs calling the project's own methods (docs/language-breadth.md, "Java"): a public static
// method marked @blueprint becomes a node, generated code calls it by its qualified class, and Run
// compiles the project's classes it needs from the source roots.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { scanJava } from '../../src/core/importing/java-scanner';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeRegistry } from '../../src/core/registry';
import { javaProject } from '../../src/extension/placement';
import { ToolNotFoundError, runGeneratedCode } from '../../src/extension/runner';
import { doc, node, wire } from '../unit/helpers';
import { CODE_CLASS_OUTPUT, codeClassGraph } from './code-classes';
import { SEVERAL_OUTPUTS_OUTPUT, severalOutputsGraph } from './several-outputs';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgraph-java-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const RULES = [
  'package game.combat;',
  '',
  'import game.util.Base;',
  '',
  'public final class Rules {',
  '    /** @blueprint */',
  '    public static double triple(double value) {',
  '        return value * Base.three();',
  '    }',
  '',
  '    /** @blueprint pure */',
  '    public static String label(String name, long points) {',
  '        return name + ": " + points;',
  '    }',
  '}',
  ''
].join('\n');
const BASE = 'package game.util;\n\npublic final class Base {\n    public static double three() {\n        return 3;\n    }\n}\n';

describe('Java project functions', () => {
  test('a graph in a Maven project calls them, and Run compiles the classes they use', async (t) => {
    const project = path.join(workDir, 'game');
    const files: Record<string, string> = {
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>game</artifactId><version>1</version></project>',
      'src/main/java/game/combat/Rules.java': RULES,
      'src/main/java/game/util/Base.java': BASE
    };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), text);
    }
    const graphDir = path.join(project, 'src/main/java/game/graphs');
    fs.mkdirSync(graphDir, { recursive: true });
    const placement = javaProject(graphDir, project);
    assert.equal(placement.package, 'game.graphs');

    const registry = new NodeRegistry();
    registry.registerMany(exposeFunctions(scanJava(RULES), { language: 'java', path: 'src/main/java/game/combat/Rules.java', exposeAll: false }).definitions);
    const d = doc(
      [
        node('s', 'core:event.start'),
        node('triple', 'fn:java:src/main/java/game/combat/Rules.java#game.combat.Rules.triple', { 'pin:value': 14 }),
        node('p1', 'core:console.print'),
        node('label', 'fn:java:src/main/java/game/combat/Rules.java#game.combat.Rules.label', { 'pin:name': 'Red', 'pin:points': 3 }),
        node('p2', 'core:console.print')
      ],
      [wire('s', 'execOut', 'triple', 'execIn'), wire('triple', 'execOut', 'p1', 'execIn'), wire('triple', 'returnValue', 'p1', 'value'), wire('p1', 'execOut', 'p2', 'execIn'), wire('label', 'returnValue', 'p2', 'value')]
    );
    const result = compileDocument({ ...doc([], []), ...d, name: 'Uses', language: 'java' }, {
      registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Uses.vgraph', outputDir: 'src/main/java/game/graphs', namespace: placement.package }
    });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    assert.equal(output.fileName, 'Uses.java');
    assert.equal(output.className, 'game.graphs.Uses');
    assert.match(output.text, /^package game\.graphs;$/m);
    assert.match(output.text, /game\.combat\.Rules\.triple\(14\.0\)/);
    const file = path.join(graphDir, output.fileName);
    fs.writeFileSync(file, output.text);
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('java')!.generator!.runner!, file, output.className, {
        cwd: project, importRoots: placement.sourceRoots, sources: [path.join(project, 'src/main/java/game/combat/Rules.java')], timeoutMs: 300000
      });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), ['42', 'Red: 3']);
  });
});

// Classes (docs/node-authoring.md, gap 2): constructors, instance methods and fields marked
// @blueprint, used through Target pins; a subclass's object where its base is expected.
const COUNTER = [
  'package game.count;',
  '',
  'public class Counter {',
  '    /** @blueprint */',
  '    public double count;',
  '',
  '    /** @blueprint */',
  '    public Counter(double start) {',
  '        count = start;',
  '    }',
  '',
  '    /** @blueprint */',
  '    public double add(double amount) {',
  '        count += amount;',
  '        return count;',
  '    }',
  '',
  '    /** @blueprint pure */',
  '    public double doubled() {',
  '        return count * 2;',
  '    }',
  '}',
  ''
].join('\n');
const BIG_COUNTER = [
  'package game.count;',
  '',
  'public class BigCounter extends Counter {',
  '    /** @blueprint */',
  '    public BigCounter(double start) {',
  '        super(start * 10);',
  '    }',
  '}',
  ''
].join('\n');

describe('Java code classes', () => {
  test('a graph constructs them and uses their members, a subclass where its base is expected', async (t) => {
    const project = path.join(workDir, 'classes');
    const files: Record<string, string> = {
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>classes</artifactId><version>1</version></project>',
      'src/main/java/game/count/Counter.java': COUNTER,
      'src/main/java/game/count/BigCounter.java': BIG_COUNTER
    };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), text);
    }
    const graphDir = path.join(project, 'src/main/java/game/graphs');
    fs.mkdirSync(graphDir, { recursive: true });
    const placement = javaProject(graphDir, project);
    const definitions = [
      ...exposeFunctions(scanJava(COUNTER), { language: 'java', path: 'src/main/java/game/count/Counter.java', exposeAll: false }).definitions,
      ...exposeFunctions(scanJava(BIG_COUNTER), { language: 'java', path: 'src/main/java/game/count/BigCounter.java', exposeAll: false }).definitions
    ];
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(codeClassGraph(definitions, 'java'), {
      registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Counting.vgraph', outputDir: 'src/main/java/game/graphs', namespace: placement.package }
    });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    const file = path.join(graphDir, output.fileName);
    fs.writeFileSync(file, output.text);
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('java')!.generator!.runner!, file, output.className, {
        cwd: project, importRoots: placement.sourceRoots, sources: Object.keys(files).filter((f) => f.endsWith('.java')).map((f) => path.join(project, f)), timeoutMs: 300000
      });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), CODE_CLASS_OUTPUT);
  });
});

// Several outputs (docs/node-authoring.md, gap 3): a function returning a record of its file gives
// the record's components.
describe('Java several outputs', () => {
  const DIVIDE = [
    'package game.math;',
    '',
    'public final class Arithmetic {',
    '    public record Division(long quotient, long remainder) {}',
    '',
    '    /** @blueprint */',
    '    public static Division divide(long a, long b) {',
    '        return new Division(a / b, a % b);',
    '    }',
    '}',
    ''
  ].join('\n');

  test('a graph reads each component of a returned record', async (t) => {
    const project = path.join(workDir, 'outputs');
    const files: Record<string, string> = {
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>outputs</artifactId><version>1</version></project>',
      'src/main/java/game/math/Arithmetic.java': DIVIDE
    };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
      fs.writeFileSync(path.join(project, name), text);
    }
    const graphDir = path.join(project, 'src/main/java/game/graphs');
    fs.mkdirSync(graphDir, { recursive: true });
    const placement = javaProject(graphDir, project);
    const definitions = exposeFunctions(scanJava(DIVIDE), { language: 'java', path: 'src/main/java/game/math/Arithmetic.java', exposeAll: false }).definitions;
    const registry = new NodeRegistry();
    registry.registerMany(definitions);
    const result = compileDocument(severalOutputsGraph(definitions, 'java'), {
      registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Dividing.vgraph', outputDir: 'src/main/java/game/graphs', namespace: placement.package }
    });
    assert.deepEqual(result.diagnostics, []);
    const output = result.output!;
    assert.match(output.text, /var vgRecord1 = .*divide\(17L?, 5L?\);\n\s*\w+ = vgRecord1\.quotient\(\);/);
    const file = path.join(graphDir, output.fileName);
    fs.writeFileSync(file, output.text);
    let outcome;
    try {
      outcome = await runGeneratedCode(builtinLanguagePacks().get('java')!.generator!.runner!, file, output.className, {
        cwd: project, importRoots: placement.sourceRoots, sources: Object.keys(files).filter((f) => f.endsWith('.java')).map((f) => path.join(project, f)), timeoutMs: 300000
      });
    } catch (error) {
      if (error instanceof ToolNotFoundError) return t.skip(error.message);
      throw error;
    }
    assert.equal(outcome.stderr, '');
    assert.deepEqual(outcome.stdout.replace(/\r\n/g, '\n').trim().split('\n'), SEVERAL_OUTPUTS_OUTPUT);
  });
});
