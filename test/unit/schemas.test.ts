import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020';
import { createEmptyDocument, createGraph, serializeDocument } from '../../src/core/serializer';
import { readRepoFile } from './helpers';

// Keeps the published JSON schemas in step with what the code reads and writes.
function validator(schemaPath: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(readRepoFile(schemaPath)));
  return (value: unknown): void => {
    assert.ok(validate(value), ajv.errorsText(validate.errors));
  };
}

describe('graph.schema.json (schema 3)', () => {
  const check = validator('schemas/graph.schema.json');

  test('accepts the sample graph', () => check(JSON.parse(readRepoFile('sample/demo.vgraph'))));

  test('accepts a newly created document', () => check(JSON.parse(serializeDocument(createEmptyDocument('New')))));

  test('accepts a class with function and macro graphs', () => {
    const doc = createEmptyDocument('Full');
    doc.graphs.push(createGraph('Helper', 'function'), createGraph('Repeat', 'macro'));
    doc.variables.push({ id: 'v1', name: 'Scores', type: { id: 'int', container: 'array' }, defaultValue: [] });
    check(JSON.parse(serializeDocument(doc)));
  });

  test('rejects an event graph in a function library', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(JSON.parse(readRepoFile('schemas/graph.schema.json')));
    const doc = { ...createEmptyDocument('Lib'), kind: 'functionLibrary' as const };
    assert.equal(validate(JSON.parse(serializeDocument(doc))), false);
  });
});

describe('graph-v1.schema.json', () => {
  test('accepts the v1 fixture', () => validator('schemas/graph-v1.schema.json')(JSON.parse(readRepoFile('test/fixtures/demo-v1.vgraph'))));
});

describe('node.schema.json', () => {
  test('accepts the sample library node', () => validator('schemas/node.schema.json')(JSON.parse(readRepoFile('sample/visual-nodes/Math/Double.node.json'))));
  test('accepts the sample framework event', () => validator('schemas/node.schema.json')(JSON.parse(readRepoFile('sample/visual-nodes/CLI/OnCommand.node.json'))));
});
