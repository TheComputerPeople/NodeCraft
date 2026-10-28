// Structs and enums (docs/program-structure.md, "Structs and enums"): their documents, nodes,
// values and compile errors. The conformance suite runs them on every target.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { recombineStructPin, splitStructPin } from '../../src/core/editing';
import { DOCUMENT_KIND_NAMES, addEnumerator, moveMember, newDocument, removeEnumerator, renameEnumerator, setTypeLanguages } from '../../src/core/blueprint-edits';
import { graphFileDefinitions } from '../../src/core/graph-files';
import { compileDocument } from '../../src/core/compiler';
import { builtinLanguagePacks } from '../../src/core/languages';
import { GraphDocument } from '../../src/core/model';
import { NodeRegistry } from '../../src/core/registry';
import { createResolver } from '../../src/core/resolve';
import { parseDocument, serializeDocument } from '../../src/core/serializer';
import { StructValue, declaredType, duplicateTypes, listUserTypes, typeLanguages, typeLookup, userTypeDefinitions } from '../../src/core/user-types';
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
    assert.deepEqual(Object.values(DOCUMENT_KIND_NAMES), ['Blueprint Class', 'Blueprint Function Library', 'Blueprint Macro Library', 'Structure', 'Enumeration', 'Blueprint Interface']);
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

// docs/multi-language.md, gap 2: a type another language declares, or nobody does, is an error
// rather than a value that vanishes from the generated code.
describe('types from another language', () => {
  const pythonPoint = { ...point, language: 'python' };
  const user = (language: string, nodes = [node('s', 'core:event.start'), node('p', 'core:console.print'), node('m', 'struct:Point.make')], variables: GraphDocument['variables'] = []): GraphDocument => ({
    schemaVersion: 3, name: 'User', kind: 'class', language, variables,
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes, connections: [wire('s', 'execOut', 'p', 'execIn'), wire('m', 'struct', 'p', 'value')] }]
  });
  const pythonTypes = (): NodeRegistry => {
    const r = new NodeRegistry();
    r.registerMany([...userTypeDefinitions(declaredType({ ...team, language: 'python' })!), ...userTypeDefinitions(declaredType(pythonPoint, { document: 'api/Point.vgraph', generatedPath: 'api/point_vgraph.py' })!)]);
    return r;
  };
  const diagnostics = (doc: GraphDocument, r: NodeRegistry) => compileDocument(doc, { registry: r, languages: builtinLanguagePacks(), generate: { sourceFileName: 'User.vgraph' } }).diagnostics;

  test("a graph using another language's struct gets an error on the node, and no code", () => {
    const result = compileDocument(user('typescript'), { registry: pythonTypes(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'User.vgraph' } });
    assert.deepEqual(result.diagnostics.map((d) => [d.code, d.message, d.nodeId]), [['wrong-language', "Point is a Python struct (api/Point.vgraph); a TypeScript graph can't use it.", 'm']]);
    assert.equal(result.output, undefined);
    assert.deepEqual(diagnostics(user('python'), pythonTypes()), [], 'Python graphs use it');
  });

  test('a variable of a type no file declares gets one error, not one per node that reads it', () => {
    const doc = user('javascript', [node('s', 'core:event.start'), node('p', 'core:console.print'), node('m', 'core:variable.get', { variable: 'v' })], [{ id: 'v', name: 'V', type: { id: 'struct:Missing' } }]);
    doc.graphs[0].connections[1] = wire('m', 'value', 'p', 'value');
    assert.deepEqual(diagnostics(doc, new NodeRegistry()).map((d) => [d.code, d.message]), [['unknown-type', 'No struct named Missing is declared in the workspace.']]);
  });

  test("a struct's field of another language's enum is reported on the struct", () => {
    assert.deepEqual(diagnostics(point, pythonTypes()).map((d) => d.code), ['wrong-language']);
  });

  test('Simulate stops with the same message', () => {
    const events = run(user('typescript'), pythonTypes());
    assert.deepEqual(events.filter((e) => e.kind === 'error').map((e) => e.message), ["Point is a Python struct (api/Point.vgraph); a TypeScript graph can't use it."]);
    assert.deepEqual(logs(events), []);
  });

  test("a type name declared in two files is reported on each file graphs don't use", () => {
    const file = (path: string, doc: GraphDocument) => ({ path, definitions: userTypeDefinitions(declaredType(doc, { document: path, generatedPath: path })!) });
    const files = [file('api/Point.vgraph', pythonPoint), file('web/Point.vgraph', point), file('web/Team.vgraph', team)];
    assert.deepEqual(duplicateTypes(files).map((d) => [d.file.path, d.message]), [
      ['api/Point.vgraph', 'A struct named Point is also declared in web/Point.vgraph, and graphs use that one: a name means one type in the workspace. Rename one of them.']
    ]);
  });
});

// docs/multi-language.md, gap 2: one struct file generated for several languages.
describe('shared structs and enums', () => {
  const shared: GraphDocument = { ...point, language: 'typescript', languages: ['python'], variables: [{ id: 'x', name: 'X', type: { id: 'float' }, defaultValue: 1 }] };
  const sharedRegistry = (): NodeRegistry => {
    const r = new NodeRegistry();
    r.registerMany(graphFileDefinitions(shared, {
      document: 'shared/Point.vgraph', generatedPath: 'shared/Point.vgraph.ts',
      others: { python: { generatedPath: 'shared/point_vgraph.py', module: 'shared.point_vgraph' } }
    }, builtinLanguagePacks().get('typescript')!.generator)!);
    return r;
  };
  const printPoint = (language: string): GraphDocument => ({
    schemaVersion: 3, name: 'User', kind: 'class', language, variables: [],
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [node('s', 'core:event.start'), node('p', 'core:console.print'), node('m', 'struct:Point.make', { 'pin:x': 2 })], connections: [wire('s', 'execOut', 'p', 'execIn'), wire('m', 'struct', 'p', 'value')] }]
  });
  const compileIn = (language: string) => compileDocument(printPoint(language), { registry: sharedRegistry(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'User.vgraph' } });

  test('each of its languages sees the type with its own generated file', () => {
    const definitions = sharedRegistry().all();
    assert.equal(typeLookup(definitions, 'typescript')('struct:Point')?.source?.generatedPath, 'shared/Point.vgraph.ts');
    assert.equal(typeLookup(definitions, 'python')('struct:Point')?.source?.generatedPath, 'shared/point_vgraph.py');
    assert.equal(typeLookup(definitions, 'go')('struct:Point'), undefined);
    assert.deepEqual(listUserTypes(definitions, 'python').map((t) => t.name), ['Point']);
  });

  test('graphs in each language import it from that language\'s file', () => {
    const python = compileIn('python');
    assert.deepEqual(python.diagnostics, []);
    assert.match(python.output!.text, /^from shared\.point_vgraph import Point$/m);
    const typescript = compileIn('typescript');
    assert.deepEqual(typescript.diagnostics, []);
    assert.match(typescript.output!.text, /^import \{ Point \} from "\.\/shared\/Point\.vgraph\.ts";$/m);
  });

  test('a language it isn\'t generated for gets an error naming the ones it is', () => {
    assert.deepEqual(compileIn('go').diagnostics.map((d) => d.message), ["Point is a TypeScript and Python struct (shared/Point.vgraph); a Go graph can't use it."]);
  });

  test('Simulate runs it in any of its languages', () => {
    assert.deepEqual(logs(run(printPoint('python'), sharedRegistry())), ['{"X":2}']);
  });

  test('only structures and enumerations list other languages, and the list never repeats its own', () => {
    assert.deepEqual(parseDocument(serializeDocument(shared)).document.languages, ['python']);
    assert.throws(() => parseDocument(JSON.stringify({ ...shared, kind: 'class', variables: [], graphs: [{ id: 'g', name: 'EventGraph', kind: 'event', nodes: [], connections: [] }] })), /only a structure or enumeration has other languages/);
    const doc = structuredClone(shared);
    setTypeLanguages(doc, ['python', 'typescript', 'python', 'go']);
    assert.deepEqual(doc.languages, ['python', 'go']);
    assert.deepEqual(typeLanguages(doc), ['typescript', 'python', 'go']);
    setTypeLanguages(doc, []);
    assert.equal('languages' in doc, false);
  });
});

describe('split struct pins', () => {
  // Line { Start: Point, Width } holds a struct, to split twice.
  const line: GraphDocument = { schemaVersion: 3, name: 'Line', kind: 'structure', language: 'javascript', graphs: [], variables: [{ id: 'start', name: 'Start', type: { id: 'struct:Point' } }, { id: 'width', name: 'Width', type: { id: 'int' }, defaultValue: 2 }] };
  const withLine = (): NodeRegistry => {
    const r = registry();
    r.registerMany(userTypeDefinitions(declaredType(line)!));
    return r;
  };
  const doc = (nodes: GraphDocument['graphs'][number]['nodes'], connections: GraphDocument['graphs'][number]['connections']): GraphDocument => ({
    schemaVersion: 3, name: 'T', kind: 'class', language: 'javascript', variables: [{ id: 'l', name: 'L', type: { id: 'struct:Line' } }],
    graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes, connections }]
  });

  test('a split pin shows a pin per field; split again for a struct field', () => {
    const d = doc([node('get', 'core:variable.get', { variable: 'l', split: ['value', 'value.start'] })], []);
    const def = createResolver(withLine(), d)(d.graphs[0].nodes[0])!;
    assert.deepEqual(def.outputs.map((p) => [p.id, p.name]), [['value.start.x', 'L Start X'], ['value.start.side', 'L Start Side'], ['value.width', 'L Width']]);
    assert.deepEqual(def.outputs[0].split, { pin: 'value.start', field: 'x' });
  });

  test('splitting drops the pin\'s wires; recombining drops the field pins\' wires and values', () => {
    const d = doc([node('get', 'core:variable.get', { variable: 'l' }), node('set', 'core:variable.set', { variable: 'l' })], [wire('get', 'value', 'set', 'value')]);
    const [get, set] = d.graphs[0].nodes;
    splitStructPin(d.graphs[0], set, 'value');
    assert.equal(d.graphs[0].connections.length, 0);
    splitStructPin(d.graphs[0], set, 'value.start');
    set.properties['pin:value.width'] = 5;
    d.graphs[0].connections.push(wire('get', 'value', 'set', 'value.start.x'));
    recombineStructPin(d.graphs[0], set, 'value');
    assert.deepEqual([set.properties, d.graphs[0].connections], [{ variable: 'l' }, []]);
    assert.ok(get);
  });

  test('split pins run and compile as Make and Break nodes', () => {
    // Set L from split fields (Start's X wired from a split Get of L, Width typed), then print L.
    const d = doc([
      node('s', 'core:event.start'), node('get', 'core:variable.get', { variable: 'l', split: ['value', 'value.start'] }),
      node('set', 'core:variable.set', { variable: 'l', split: ['value', 'value.start'], 'pin:value.width': 7, 'pin:value.start.side': 'blue' }),
      node('print', 'core:console.print'), node('l2', 'core:variable.get', { variable: 'l' })
    ], [
      wire('s', 'execOut', 'set', 'execIn'), wire('get', 'value.start.x', 'set', 'value.start.x'),
      wire('set', 'execOut', 'print', 'execIn'), wire('l2', 'value', 'print', 'value')
    ]);
    assert.deepEqual(logs(run(d, withLine())), ['{"Start":{"X":1,"Side":"Light Blue"},"Width":7}']);
    const result = compileDocument(d, { registry: withLine(), languages: builtinLanguagePacks(), generate: { sourceFileName: 'T.vgraph' } });
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.output!.text, /this\.L = new Line\(new Point\(this\.L\.start\.x, Team\.LightBlue\), 7\);/);
  });
});
