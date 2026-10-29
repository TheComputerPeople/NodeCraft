// A class method with out parameters (docs/node-authoring.md, gaps 2 and 3): its node keeps how the
// code gives its outputs, and generated code passes the out variables to the method on the Target.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { exposeFunctions } from '../../src/core/importing/symbols';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';

const SOURCES: Record<string, { path: string; text: string; call: RegExp }> = {
  csharp: {
    path: 'lib/Meter.cs',
    text: [
      'namespace Game;',
      'public class Meter',
      '{',
      '    /// @blueprint',
      '    public Meter() {}',
      '    /// @blueprint',
      '    public void Read(int a, out int low, out int high) { low = a; high = a + 1; }',
      '}',
      ''
    ].join('\n'),
    call: /\.Read\(3, out var vgOut1_0, out var vgOut1_1\);/
  },
  cpp: {
    path: 'native/meter.h',
    text: [
      '#pragma once',
      'namespace game {',
      'class Meter {',
      'public:',
      '    /// @blueprint',
      '    Meter() {}',
      '    /// @blueprint',
      '    void read(int a, int& low, int& high) { low = a; high = a + 1; }',
      '};',
      '}',
      ''
    ].join('\n'),
    call: /\.read\(3, vg_out1_0, vg_out1_1\);/
  },
  php: {
    path: 'src/Meter.php',
    text: [
      '<?php',
      'namespace App;',
      'class Meter',
      '{',
      '    /** @blueprint */',
      '    public function __construct() {}',
      '    /** @blueprint */',
      '    public function read(int $a, int &$low, int &$high): void { $low = $a; $high = $a + 1; }',
      '}',
      ''
    ].join('\n'),
    call: /->read\(3, \$vgOut1_0, \$vgOut1_1\);/
  }
};

describe('class methods with out parameters', () => {
  const languages = builtinLanguagePacks();
  for (const [language, source] of Object.entries(SOURCES)) {
    test(`${language}: the method's node keeps its results, and the call passes the out variables`, () => {
      const scan = languages.get(language)!.importer!.scan!(source.text);
      const definitions = exposeFunctions(scan, { language, path: source.path, exposeAll: false }).definitions;
      const find = (suffix: string): NodeDefinition => definitions.find((d) => d.type.toLowerCase().endsWith(suffix))!;
      const read = find(':read');
      assert.deepEqual((read.implementation as { results?: unknown }).results, { kind: 'out', names: ['low', 'high'], ...(language === 'cpp' ? { types: ['int', 'int'] } : {}) });
      const registry = new NodeRegistry();
      registry.registerMany(definitions);
      const n = (id: string, type: string, properties: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, properties });
      const w = (fromNode: string, fromPin: string, toNode: string, toPin: string) => ({ id: `${fromNode}.${fromPin}`, fromNode, fromPin, toNode, toPin });
      const document: GraphDocument = {
        schemaVersion: 3, name: 'Metering', kind: 'class', language, variables: [],
        graphs: [{
          id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
          nodes: [n('s', 'core:event.start'), n('c', find(':new').type), n('r', read.type, { 'pin:a': 3 }), n('p', 'core:console.print')],
          connections: [w('s', 'execOut', 'c', 'execIn'), w('c', 'execOut', 'r', 'execIn'), w('r', 'execOut', 'p', 'execIn'), w('c', 'returnValue', 'r', 'target'), w('r', 'high', 'p', 'value')]
        }]
      };
      const result = compileDocument(document, { registry, languages, generate: { sourceFileName: 'Metering.vgraph', outputDir: '' } });
      assert.deepEqual(result.diagnostics, []);
      assert.match(result.output!.text, source.call);
    });
  }
});
