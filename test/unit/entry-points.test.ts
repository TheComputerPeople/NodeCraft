// Entry points (docs/program-structure.md, "Entry points and framework packs"): Main, and framework
// packs' events, which something outside the graph runs by calling their methods.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument } from '../../src/core/model';
import { NodeRegistry, parseNodeDefinition } from '../../src/core/registry';
import { doc, node, readRepoFile, wire } from './helpers';

function registry(): NodeRegistry {
  const r = new NodeRegistry();
  r.register(parseNodeDefinition(readRepoFile('sample/visual-nodes/CLI/OnCommand.node.json'))!);
  return r;
}

const compile = (d: GraphDocument, language = 'javascript') =>
  compileDocument({ ...d, language }, { registry: registry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'Tool.vgraph' } });

describe('entry points', () => {
  test('a framework event becomes a method named in each language\'s style, its outputs the parameters', () => {
    const d = doc([node('cmd', 'cli:on-command'), node('p', 'core:console.print')], [wire('cmd', 'execOut', 'p', 'execIn'), wire('cmd', 'name', 'p', 'value')]);
    assert.match(compile(d, 'typescript').output!.text, /onCommand\(name: string, args: string\[\]\): void \{\s*(\/\/.*\s*)?console\.log\(name\);/);
    assert.match(compile(d, 'python').output!.text, /def on_command\(self, name: str, args: list\[str\]\) -> None:\s*(#.*\s*)?print\(name\)/);
    assert.match(compile(d, 'csharp').output!.text, /public virtual void OnCommand\(string name, List<string> args\)/);
  });

  test('Main is reported to Run, one per class, and events stay out of functions', () => {
    const d = doc([node('main', 'core:event.main')], []);
    assert.equal(compile(d).output!.mainMethod, 'main');
    assert.equal(compile(d, 'csharp').output!.mainMethod, 'Main');
    d.graphs[0].nodes.push(node('main2', 'core:event.main'));
    assert.deepEqual(compile(d).diagnostics.map((x) => x.code), ['duplicate-event']);
    const inFunction = doc([], []);
    inFunction.graphs.push({ id: 'F', name: 'F', kind: 'function', comments: [], signature: { inputs: [], outputs: [] }, nodes: [node('entry', 'core:function.entry', { graph: 'F' }), node('cmd', 'cli:on-command')], connections: [] });
    assert.deepEqual(compile(inFunction).diagnostics.map((x) => x.code), ['event-in-function']);
  });
});
