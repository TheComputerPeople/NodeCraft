// The utility nodes (src/core/utilities.ts): built in, valid, and implemented in every graph language.
// What they print is covered by test/fixtures/graphs/utilities-*.vgraph in the conformance suite.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020';
import { builtinNodeDefinitions } from '../../src/core/builtins';
import { builtinLanguagePacks } from '../../src/core/languages';
import { parseDocument } from '../../src/core/serializer';
import { utilityDefinitions } from '../../src/core/utilities';
import { readRepoFile, run } from './helpers';

describe('utility nodes', () => {
  test('are built in', () => {
    const builtin = new Set(builtinNodeDefinitions().map((d) => d.type));
    for (const definition of utilityDefinitions()) assert.ok(builtin.has(definition.type), definition.type);
  });

  test('are valid and implemented in every graph language', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(JSON.parse(readRepoFile('schemas/node.schema.json')));
    const languages = new Set(builtinLanguagePacks().all().flatMap((p) => p.generator!.snippetLanguages.slice(-1)));
    for (const definition of utilityDefinitions()) {
      assert.ok(validate(definition), `${definition.type}: ${ajv.errorsText(validate.errors)}`);
      const snippets = definition.implementation?.kind === 'code' ? definition.implementation.languages : {};
      for (const language of languages) assert.ok(snippets[language], `${definition.type} has no ${language}`);
    }
  });

  test('a broken rule stops the run with its message', () => {
    const doc = parseDocument(readRepoFile('test/fixtures/graphs/utilities-errors.vgraph')).document;
    assert.equal(run(doc).find((e) => e.kind === 'error')?.message, 'Not a boolean: "maybe"');
  });
});
