// The code preview (src/core/preview.ts, docs/language-context.md part 3): what a node becomes in a
// language, for the palette and the Add Node menu.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auditCases } from '../../src/conformance/audit';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { ownLines, previewNode } from '../../src/core/preview';
import { NodeRegistry } from '../../src/core/registry';

const languages = builtinLanguagePacks();
const registry = new NodeRegistry();
const preview = (type: string, language: string, properties?: Record<string, unknown>, document?: GraphDocument) =>
  previewNode({ type, ...(properties ? { properties } : {}) }, { language, languages, registry, ...(document ? { document } : {}) });

describe('code preview', () => {
  test('every node the palette offers has a preview in every language', () => {
    // Sequence and End write no code of their own: Sequence runs its outputs in order, End returns.
    const none = new Set(['core:flow.sequence', 'core:flow.end']);
    for (const pack of languages.all()) {
      const types = [...new Set(auditCases(builtinNodeDefinitions(), pack).map((c) => c.definition.type))];
      const missing = types.filter((type) => !none.has(type) && !preview(type, pack.id));
      assert.deepEqual(missing, [], pack.id);
    }
  });

  test("a code node shows its snippet in the language, its inputs named as its pins", () => {
    assert.deepEqual(preview('core:array.length', 'python'), { code: 'return len(target)', kind: 'snippet' });
    assert.match(preview('core:array.length', 'cpp')!.code, /target\.size\(\)/);
    assert.equal(preview('core:array.length', 'lua')!.code, 'return target.n');
    // TypeScript uses the JavaScript snippet.
    assert.equal(preview('core:array.length', 'typescript')!.code, preview('core:array.length', 'javascript')!.code);
  });

  test('Length is previewed in each language, each its own way', () => {
    const previews = languages.all().map((pack) => [pack.id, preview('core:array.length', pack.id)?.code]);
    for (const [id, code] of previews) assert.ok(code, `${id}: ${code}`);
    // TypeScript and JavaScript share a snippet; the other ten are each their own.
    assert.equal(new Set(previews.map(([, code]) => code)).size, 11);
  });

  test("any other node shows its own lines of generated code", () => {
    assert.deepEqual(preview('core:flow.branch', 'python'), { code: 'if condition:\n    pass', kind: 'generated' });
    assert.equal(preview('core:flow.branch', 'lua')!.code, 'if condition then\nend');
    assert.match(preview('core:latent.delay', 'go')!.code, /^if !self\._node_pending \{\n\tself\._node_pending = true\n\tVgDelay\(duration, func\(\) \{/);
    // A pure node is written where it's used.
    assert.equal(preview('core:array.make', 'python')!.code, 'return [item_0]');
    assert.equal(preview('core:console.print', 'ruby')!.code, 'puts Vg.format(value)');
  });

  test("an entry that refers to the open document is shown in it", () => {
    const document: GraphDocument = {
      schemaVersion: 3, name: 'Game', kind: 'class', language: 'typescript',
      variables: [{ id: 'score', name: 'Score', type: { id: 'int' }, defaultValue: 0 }],
      graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], connections: [], nodes: [{ id: 'node', type: 'core:event.custom', position: { x: 0, y: 0 }, properties: { name: 'Hit' } }] }]
    };
    assert.equal(preview('core:variable.set', 'csharp', { variable: 'score' }, document)?.code, 'Score = score;');
    assert.equal(preview('core:call.event', 'python', { event: 'Hit' }, document)?.code, 'self.hit()');
    // Without the document, there's nothing to show.
    assert.equal(preview('core:variable.set', 'csharp', { variable: 'score' }), undefined);
  });

  test("a project function shows its call", () => {
    const fn: NodeDefinition = {
      type: 'fn:python:game/combat.py#damage', version: 1, displayName: 'Damage', category: 'Project',
      inputs: [{ id: 'strength', name: 'Strength', kind: 'data', direction: 'input', type: { id: 'float' } }],
      outputs: [{ id: 'returnValue', name: 'Return Value', kind: 'data', direction: 'output', type: { id: 'float' } }],
      implementation: { kind: 'function', language: 'python', path: 'game/combat.py', name: 'damage', module: 'game.combat' }
    };
    const withFunction = new NodeRegistry();
    withFunction.register(fn);
    assert.equal(previewNode({ type: fn.type }, { language: 'python', languages, registry: withFunction })?.code, 'return damage(strength)');
  });

  test('own lines: from a line, while indented at least as deep', () => {
    const text = 'class A:\n    def f(self):\n        if x:\n            y()\n\n        z()\n    def g(self):\n        pass\n';
    assert.equal(ownLines(text, 3), 'if x:\n    y()\n\nz()');
  });
});
