// Node library packages (src/core/node-packages.ts): versions and ranges, resolving packages
// together, and graphs remembering the versions their nodes were made with.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { NodeDefinition } from '../../src/core/model';
import { NodePackage, compareVersions, libraryChange, manifestProblems, refreshLibrary, resolvePackages, satisfies, syncLibraryVersions } from '../../src/core/node-packages';
import { NodeRegistry } from '../../src/core/registry';
import { doc, node, wire } from './helpers';

const definition = (type: string, displayName = type): NodeDefinition => ({
  type, version: 1, displayName, category: 'Test',
  inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }],
  outputs: [{ id: 'execOut', name: '', kind: 'exec', direction: 'output' }],
  implementation: { kind: 'code', languages: { javascript: 'return;' } }
});
const pkg = (name: string, version: string, nodes: NodeDefinition[], extra: Partial<NodePackage> = {}): NodePackage => ({ name, version, nodes, origin: `${name}.vgraph-package.json`, ...extra });

describe('versions and ranges', () => {
  test('comparing, with prereleases before their release', () => {
    assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
    assert.ok(compareVersions('2.0.0-beta.1', '2.0.0') < 0);
    assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0);
  });

  test('npm range syntax', () => {
    const cases: [string, string, boolean][] = [
      ['1.4.0', '^1.2.0', true], ['2.0.0', '^1.2.0', false], ['0.2.5', '^0.2.1', true], ['0.3.0', '^0.2.1', false],
      ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.9.0', '1.x', true], ['2.0.0', '1', false],
      ['1.5.0', '>=1.0.0 <2.0.0', true], ['2.1.0', '>=1.0.0 <2.0.0', false], ['3.0.0', '^1.0.0 || ^3.0.0', true],
      ['5.0.0', '*', true], ['1.2.3', '1.2.3', true], ['2.0.0-beta', '^1.0.0', false]
    ];
    for (const [version, range, expected] of cases) assert.equal(satisfies(version, range), expected, `${version} in ${range}`);
  });

  test('manifests are checked', () => {
    assert.deepEqual(manifestProblems({ name: 'combat-nodes', version: '1.0.0', nodes: ['nodes/*.node.json'], dependencies: { 'math-nodes': '^2.0.0' } }), []);
    const problems = manifestProblems({ name: 'Combat Nodes', version: '1.0', nodes: 'x', dependencies: { a: 'soon' } });
    assert.equal(problems.length, 4, problems.join('\n'));
  });
});

describe('resolving packages', () => {
  test('nodes are tagged with their package; missing and mismatched dependencies and engines are warnings', () => {
    const { definitions, problems } = resolvePackages([
      pkg('combat', '1.2.0', [definition('combat:hit')], { dependencies: { math: '^2.0.0', sound: '^1.0.0' }, engines: { blueprint: '^2' } }),
      pkg('math', '1.5.0', [definition('math:lerp')])
    ], [definition('loose:thing')], 1);
    assert.deepEqual(definitions.find((d) => d.type === 'combat:hit')?.library, { name: 'combat', version: '1.2.0' });
    assert.equal(definitions.find((d) => d.type === 'loose:thing')?.library, undefined);
    assert.deepEqual(problems.map((p) => p.message), [
      'combat needs math ^2.0.0, but version 1.5.0 is installed.',
      'combat needs sound ^1.0.0, which isn\'t installed.',
      'combat is for Blueprint Visual Scripting API ^2, but this extension\'s API version is 1.'
    ]);
    assert.equal(problems[0].origin, 'combat.vgraph-package.json');
  });

  test('the newer of two packages with one name, or defining one node type, wins', () => {
    const { definitions, problems } = resolvePackages([
      pkg('combat', '1.0.0', [definition('combat:hit', 'Old Hit')], { where: 'old/combat.vgraph-package.json' }),
      pkg('combat', '2.0.0', [definition('combat:hit', 'New Hit')], { where: 'new/combat.vgraph-package.json' }),
      pkg('extra', '0.1.0', [definition('combat:hit', 'Extra Hit')])
    ], [definition('combat:hit', 'Loose Hit')], 1);
    assert.equal(definitions.find((d) => d.type === 'combat:hit')?.displayName, 'New Hit');
    assert.deepEqual(problems.map((p) => p.message), [
      'combat 1.0.0 isn\'t used: new/combat.vgraph-package.json has version 2.0.0.',
      'combat 2.0.0 and extra 0.1.0 both define combat:hit; combat\'s is used.'
    ]);
  });
});

describe('graphs remember package versions', () => {
  const hit = (version: string) => ({ ...definition('combat:hit'), library: { name: 'combat', version } });
  const graph = () => ({ ...doc([node('s', 'core:event.start'), node('h', 'combat:hit')], [wire('s', 'execOut', 'h', 'execIn')]), metadata: {} as Record<string, unknown> });

  test('a version is recorded once, kept across minor updates, and dropped when unused', () => {
    const d = graph();
    assert.equal(syncLibraryVersions(d, (type) => (type === 'combat:hit' ? hit('1.2.0') : undefined)), true);
    assert.deepEqual(d.metadata.libraries, { combat: '1.2.0' });
    assert.equal(syncLibraryVersions(d, (type) => (type === 'combat:hit' ? hit('1.3.0') : undefined)), false, 'kept');
    assert.equal(libraryChange(d, hit('1.3.0')), undefined, 'a minor version changes nothing');
    assert.deepEqual(libraryChange(d, hit('2.0.0')), { name: 'combat', from: '1.2.0', to: '2.0.0' });
    refreshLibrary(d, 'combat', '2.0.0');
    assert.equal(libraryChange(d, hit('2.0.0')), undefined);
    d.graphs[0].nodes = d.graphs[0].nodes.filter((n) => n.id !== 'h');
    syncLibraryVersions(d, () => undefined);
    assert.equal(d.metadata.libraries, undefined);
  });

  test('compiling a graph whose package changed major version warns on its nodes', () => {
    const registry = new NodeRegistry();
    registry.registerMany([hit('2.0.0')]);
    const result = compileDocument({ ...graph(), metadata: { libraries: { combat: '1.2.0' } } }, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Hit.vgraph' } });
    assert.ok(result.output, 'it still compiles');
    assert.deepEqual(result.diagnostics.map((d) => [d.code, d.severity, d.nodeId]), [['library-changed', 'warning', 'h']]);
    assert.match(result.diagnostics[0].message, /combat is now version 2\.0\.0, a new major version \(this graph was made with 1\.2\.0\)/);
  });
});
