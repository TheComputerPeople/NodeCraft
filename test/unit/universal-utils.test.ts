// The universal-utils node package (libraries/universal-utils): a valid package whose node files are
// the generator's output, each implemented in every graph language.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { manifestProblems } from '../../src/core/node-packages';
import { builtinLanguagePacks } from '../../src/core/languages';
import { readRepoFile, repoRoot } from './helpers';

const library = path.join(repoRoot, 'libraries/universal-utils');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const generator = require(path.join(library, 'generate.js')) as { NODES: { name: string }[]; definition(node: unknown): Record<string, unknown> };

describe('universal-utils package', () => {
  test('the manifest is a valid package of the node files', () => {
    const manifest = JSON.parse(readRepoFile('libraries/universal-utils/universal-utils.vgraph-package.json'));
    assert.deepEqual(manifestProblems(manifest), []);
    const ajv = new Ajv2020({ strict: false });
    assert.ok(ajv.validate(JSON.parse(readRepoFile('schemas/node-package.schema.json')), manifest), ajv.errorsText());
  });

  test('the node files are what generate.js writes (run it after changing its table)', () => {
    const files = fs.readdirSync(path.join(library, 'nodes')).sort();
    assert.deepEqual(files, generator.NODES.map((n) => `${n.name.replace('.', '-')}.node.json`).sort());
    for (const node of generator.NODES) {
      const file = path.join(library, 'nodes', `${node.name.replace('.', '-')}.node.json`);
      assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), JSON.stringify(generator.definition(node), null, 2) + '\n', file);
    }
  });

  test('every node is valid and implemented in every graph language', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(JSON.parse(readRepoFile('schemas/node.schema.json')));
    const languages = new Set(builtinLanguagePacks().all().flatMap((p) => p.generator!.snippetLanguages.slice(-1)));
    for (const node of generator.NODES) {
      const definition = generator.definition(node) as { type: string; implementation: { languages: Record<string, string> } };
      assert.ok(validate(definition), `${definition.type}: ${ajv.errorsText(validate.errors)}`);
      for (const language of languages) assert.ok(definition.implementation.languages[language], `${definition.type} has no ${language}`);
    }
  });
});
