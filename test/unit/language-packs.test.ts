import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguagePack, LanguagePackRegistry } from '../../src/core/language-pack';
import { builtinLanguagePacks } from '../../src/core/languages';
import { javascriptPack, typescriptPack } from '../../src/core/languages/javascript';
import { NodeRegistry } from '../../src/core/registry';
import { GraphRuntime } from '../../src/core/runtime';
import { TypeRef } from '../../src/core/types';
import { doc, node, run, wire } from './helpers';

describe('LanguagePackRegistry.detect', () => {
  const packs = builtinLanguagePacks();

  test('prefers TypeScript when a project has both tsconfig.json and package.json', () => {
    assert.equal(packs.detect((glob) => glob === '**/tsconfig.json' || glob === '**/package.json')?.id, 'typescript');
  });

  test('falls back to JavaScript with only package.json', () => {
    assert.equal(packs.detect((glob) => glob === '**/package.json')?.id, 'javascript');
  });

  test('returns undefined when no marker is present', () => {
    assert.equal(packs.detect(() => false), undefined);
  });
});

describe('TypeScript type mapping', () => {
  const cases: [TypeRef, string][] = [
    [{ id: 'bool' }, 'boolean'],
    [{ id: 'int' }, 'number'],
    [{ id: 'any' }, 'unknown'],
    [{ id: 'struct:Vector' }, 'Vector'],
    [{ id: 'float', container: 'array' }, 'number[]'],
    [{ id: 'string', container: 'set' }, 'Set<string>'],
    [{ id: 'string', container: 'map', valueType: { id: 'int', container: 'array' } }, 'Map<string, number[]>'],
    [{ id: 'object:Player', nullable: true }, 'Player | null'],
    [{ id: 'object:Player', nullable: true, container: 'array' }, 'Player[] | null']
  ];
  for (const [type, expected] of cases) {
    test(`${JSON.stringify(type)} → ${expected}`, () => assert.equal(typescriptPack.mapType(type), expected));
  }
});

describe('JavaScript simulator', () => {
  const simulator = javascriptPack.simulator!;

  test('passes inputs as named parameters and returns the result', () => {
    assert.equal(simulator.run('return a + b;', [{ id: 'a', value: 2 }, { id: 'b', value: 3 }]), 5);
  });

  test('substitutes ${pinId} for ids that are not identifiers', () => {
    assert.equal(simulator.run('return ${my-value} * ${class};', [{ id: 'my-value', value: 4 }, { id: 'class', value: 5 }]), 20);
  });

  test('propagates errors thrown by the snippet', () => {
    assert.throws(() => simulator.run('throw new Error("boom");', []), /boom/);
  });
});

describe('GraphRuntime language handling', () => {
  const codeRegistry = (): NodeRegistry => {
    const registry = new NodeRegistry();
    registry.register({
      type: 't.code', version: 1, displayName: 'Code', category: 'Test',
      inputs: [{ id: 'execIn', name: '', kind: 'exec', direction: 'input' }],
      outputs: [{ id: 'execOut', name: '', kind: 'exec', direction: 'output' }],
      implementation: { kind: 'code', languages: { python: 'return 1' } }
    });
    return registry;
  };
  const codeGraph = (language: string) => {
    const g = doc([node('s', 'core:event.start'), node('c', 't.code')], [wire('s', 'execOut', 'c', 'execIn')]);
    g.language = language;
    return g;
  };
  const errors = (events: ReturnType<typeof run>) => events.filter((e) => e.kind === 'error').map((e) => e.message);

  test('reports a code node without a snippet the simulator can run', () => {
    assert.match(errors(run(codeGraph('javascript'), codeRegistry())).join(), /no javascript or typescript implementation/);
  });

  test('reports a pack that has no simulator', () => {
    const python: LanguagePack = { ...javascriptPack, id: 'python', displayName: 'Python', simulator: undefined };
    const events: ReturnType<typeof run> = [];
    new GraphRuntime(codeRegistry(), (e) => events.push(e), new LanguagePackRegistry([python])).run(codeGraph('python'));
    assert.match(errors(events).join(), /Python code can't run inside the editor/);
  });

  test('reports an unknown language', () => {
    assert.match(errors(run(codeGraph('cobol'), codeRegistry())).join(), /Unknown graph language "cobol"/);
  });
});
