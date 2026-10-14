// Structs and enums (docs/program-structure.md, "Structs and enums"): their documents, nodes,
// values and compile errors. The conformance suite runs them on every target.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENT_KIND_NAMES, addEnumerator, moveMember, newDocument, removeEnumerator, renameEnumerator } from '../../src/core/blueprint-edits';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { parseDocument, serializeDocument } from '../../src/core/serializer';
import { StructValue, declaredType, listUserTypes, typeLookup, userTypeDefinitions } from '../../src/core/user-types';
import { defaultValue, formatValue, fromStored, storedDefault } from '../../src/core/values';
import { logs, node, run, wire } from './helpers';

const team: GraphDocument = { schemaVersion: 3, name: 'Team', kind: 'enumeration', language: 'javascript', variables: [], graphs: [], enumerators: [{ id: 'red', name: 'Red' }, { id: 'blue', name: 'Light Blue' }] };
const point: GraphDocument = {
  schemaVersion: 3, name: 'Point', kind: 'structure', language: 'javascript', graphs: [],
  variables: [{ id: 'x', name: 'X', type: { id: 'float' }, defaultValue: 1 }, { id: 'side', name: 'Side', type: { id: 'enum:Team' } }]
};

function registry(): NodeRegistry {
  const r = new NodeRegistry();
  r.registerMany([...userTypeDefinitions(declaredType(team)!), ...userTypeDefinitions(declaredType(point)!)]);
  return r;
}

function compile(doc: GraphDocument) {
  return compileDocument(doc, { registry: registry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'test.vgraph' } });
}

describe('struct and enum documents', () => {
  test('parse without graphs, and round-trip', () => {
    for (const doc of [team, point]) {
      const parsed = parseDocument(serializeDocument(doc)).document;
      assert.equal(parsed.kind, doc.kind);
      assert.deepEqual(parsed.graphs, []);
      assert.deepEqual(parsed.enumerators, doc.enumerators);
    }
    assert.throws(() => parseDocument(JSON.stringify({ ...team, kind: 'class', graphs: [{ id: 'g', kind: 'event', nodes: [], connections: [] }] })), /only an enumeration has enumerators/);
  });

  test('new files of each kind start as Unreal\'s assets do', () => {
    assert.deepEqual(Object.values(DOCUMENT_KIND_NAMES), ['Blueprint Class', 'Blueprint Function Library', 'Blueprint Macro Library', 'Structure', 'Enumeration']);
    assert.deepEqual(newDocument('S', 'python', 'structure').variables.map((v) => v.name), ['MemberVar']);
    assert.deepEqual(newDocument('E', 'python', 'enumeration').enumerators?.map((e) => e.name), ['NewEnumerator']);
    assert.deepEqual(newDocument('F', 'python', 'functionLibrary').graphs.map((g) => g.kind), ['function']);
    assert.deepEqual(newDocument('M', 'python', 'macroLibrary').graphs[0].nodes.map((n) => n.type), ['core:macro.inputs', 'core:macro.outputs']);
  });

  test('enumeration values are added, renamed, reordered, and never all removed', () => {
    const doc = structuredClone(team);
    const added = addEnumerator(doc);
    assert.equal(renameEnumerator(doc, added.id, 'Red'), 'There is already a value named "Red".');
    assert.equal(renameEnumerator(doc, added.id, 'Green'), undefined);
    moveMember(doc, added.id, -1);
    assert.deepEqual(doc.enumerators?.map((e) => e.name), ['Red', 'Green', 'Light Blue']);
    assert.equal(removeEnumerator(doc, 'red'), undefined);
    assert.equal(removeEnumerator(doc, 'blue'), undefined);
    assert.match(removeEnumerator(doc, added.id) ?? '', /at least one value/);
  });

  test('the type pickers list the structs and enums of the graph\'s language', () => {
    const python = userTypeDefinitions(declaredType({ ...team, name: 'Mood', language: 'python' })!);
    assert.deepEqual(listUserTypes([...registry().all(), ...python], 'javascript').map((t) => t.name), ['Point', 'Team']);
  });
});

describe('struct and enum values', () => {
  const types = typeLookup(registry().all());

  test('defaults: a struct has its fields\' defaults, an enum its first value', () => {
    const value = defaultValue({ id: 'struct:Point' }, types);
    assert.ok(value instanceof StructValue);
    assert.equal(formatValue(value), '{"X":1,"Side":"Red"}');
    assert.equal(defaultValue({ id: 'enum:Team' }, types), 'Red');
    assert.equal(storedDefault({ id: 'enum:Team' }, types), 'red');
  });

  test('stored values: enums by id, structs by the fields that differ', () => {
    assert.equal(fromStored('blue', { id: 'enum:Team' }, types), 'Light Blue');
    assert.equal(formatValue(fromStored({ side: 'blue' }, { id: 'struct:Point' }, types)), '{"X":1,"Side":"Light Blue"}');
    assert.deepEqual(fromStored(['blue', 'red'], { id: 'enum:Team', container: 'array' }, types), ['Light Blue', 'Red']);
  });

  test('Set members in changes only the chosen fields', () => {
    const doc: GraphDocument = {
      schemaVersion: 3, name: 'T', kind: 'class', language: 'javascript', variables: [{ id: 'p', name: 'P', type: { id: 'struct:Point' } }],
      graphs: [{
        id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
        nodes: [
          node('s', 'core:event.start'), node('get', 'core:variable.get', { variable: 'p' }),
          node('m', 'struct:Point.set-members', { members: ['side'], 'pin:side': 'blue' }), node('print', 'core:console.print')
        ],
        connections: [wire('s', 'execOut', 'm', 'execIn'), wire('get', 'value', 'm', 'struct'), wire('m', 'execOut', 'print', 'execIn'), wire('get', 'value', 'print', 'value')]
      }]
    };
    const resolve = createResolver(registry(), doc);
    assert.deepEqual(resolve(doc.graphs[0].nodes[2])!.inputs.map((p) => p.id), ['execIn', 'struct', 'side']);
    assert.deepEqual(logs(run(doc, registry())), ['{"X":1,"Side":"Light Blue"}']);
  });
});

describe('compiling structs and enums', () => {
  test('a structure needs fields with distinct names, and can\'t contain itself', () => {
    const codes = (doc: GraphDocument) => compile(doc).diagnostics.map((d) => d.code);
    assert.deepEqual(codes({ ...point, variables: [] }), ['empty-struct']);
    assert.deepEqual(codes({ ...point, variables: [...point.variables, { id: 'x2', name: 'X', type: { id: 'int' } }] }), ['duplicate-member']);
    assert.deepEqual(codes({ ...point, variables: [{ id: 'self', name: 'Self', type: { id: 'struct:Point' } }] }), ['recursive-struct']);
    assert.deepEqual(codes({ ...team, enumerators: [] }), ['empty-enum']);
  });

  test('sets and map keys of structs or enums are reported', () => {
    const doc: GraphDocument = {
      schemaVersion: 3, name: 'T', kind: 'class', language: 'javascript', variables: [{ id: 'teams', name: 'Teams', type: { id: 'enum:Team', container: 'set' } }],
      graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [node('s', 'core:event.start')], connections: [] }]
    };
    assert.deepEqual(compile(doc).diagnostics.map((d) => d.code), ['unsupported-key-type']);
  });

  test('a class imports the types it uses from their generated files', () => {
    const r = new NodeRegistry();
    const source = (file: string) => ({ document: `types/${file}.vgraph`, generatedPath: `types/${file}.vgraph.js` });
    r.registerMany([...userTypeDefinitions(declaredType(team, source('Team'))!), ...userTypeDefinitions(declaredType(point, source('Point'))!)]);
    const doc: GraphDocument = {
      schemaVersion: 3, name: 'T', kind: 'class', language: 'javascript', variables: [{ id: 'p', name: 'P', type: { id: 'struct:Point' } }],
      graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [node('s', 'core:event.start')], connections: [] }]
    };
    const { output } = compileDocument(doc, { registry: r, languages: builtinLanguagePacks(), generate: { sourceFileName: 'T.vgraph' } });
    assert.match(output!.text, /^import \{ Point \} from "\.\/types\/Point\.vgraph\.js";$/m);
    assert.match(output!.text, /^import \{ Team \} from "\.\/types\/Team\.vgraph\.js";$/m, 'the struct\'s enum field may be needed too');
    assert.match(output!.text, /P = new Point\(\);/);
  });
});
