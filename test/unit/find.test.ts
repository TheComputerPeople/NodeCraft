// Finding things in the Codebase Map (src/core/codemap/find.ts): entities by name, ranked; what the
// filters hide (languages, projects, external packages, tests) and how the views leave it out.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeIndex, Entity } from '../../src/core/codemap/code-index';
import { MAX_FOUND, filterOptions, findEntities, hiddenBy, isTest } from '../../src/core/codemap/find';
import { buildScene } from '../../src/core/codemap/scene';
import { buildCallScene } from '../../src/core/codemap/call-scene';

function entity(id: string, kind: Entity['kind'], parent?: string, extra: Partial<Entity> = {}): Entity {
  return { id, kind, name: id.replace(/^.*[:/#.]/, ''), ...(parent ? { parent } : {}), ...extra };
}

// Two projects: app (TypeScript: src/scoreBoard.ts with class ScoreBoard and its method addScore, and
// tests/score.test.ts testing it) and tools (Python: score.py), and an external package.
function sample(): CodeIndex {
  return {
    entities: [
      entity('p:app', 'project', undefined, { name: 'app', path: 'app' }),
      entity('m:app/src', 'module', 'p:app', { name: 'src', path: 'app/src' }),
      entity('f:app/src/scoreBoard.ts', 'file', 'm:app/src', { name: 'scoreBoard.ts', path: 'app/src/scoreBoard.ts', language: 'typescript' }),
      entity('s:app/src/scoreBoard.ts#ScoreBoard', 'type', 'f:app/src/scoreBoard.ts', { name: 'ScoreBoard', path: 'app/src/scoreBoard.ts', line: 3, language: 'typescript' }),
      entity('s:app/src/scoreBoard.ts#ScoreBoard.addScore', 'function', 's:app/src/scoreBoard.ts#ScoreBoard', { name: 'addScore', path: 'app/src/scoreBoard.ts', line: 7, language: 'typescript', entries: [{ kind: 'main', name: 'addScore' }] }),
      entity('m:app/tests', 'module', 'p:app', { name: 'tests', path: 'app/tests' }),
      entity('f:app/tests/score.test.ts', 'file', 'm:app/tests', { name: 'score.test.ts', path: 'app/tests/score.test.ts', language: 'typescript' }),
      entity('s:app/tests/score.test.ts#checks', 'function', 'f:app/tests/score.test.ts', { name: 'checks', path: 'app/tests/score.test.ts', line: 2, language: 'typescript', entries: [{ kind: 'test', name: 'checks' }] }),
      entity('p:tools', 'project', undefined, { name: 'tools', path: 'tools' }),
      entity('f:tools/score.py', 'file', 'p:tools', { name: 'score.py', path: 'tools/score.py', language: 'python' }),
      entity('x:npm:scorer', 'external', undefined, { name: 'scorer', language: 'typescript' })
    ],
    imports: [
      { from: 'f:app/tests/score.test.ts', to: 'f:app/src/scoreBoard.ts', line: 1, source: '../src/scoreBoard' },
      { from: 'f:app/src/scoreBoard.ts', to: 'x:npm:scorer', line: 1, source: 'scorer' }
    ],
    calls: [
      { from: 's:app/tests/score.test.ts#checks', to: 's:app/src/scoreBoard.ts#ScoreBoard.addScore', path: 'app/tests/score.test.ts', line: 3, column: 1, count: 1, certain: true }
    ],
    inherits: [], unresolved: [], unresolvedCalls: [], generated: []
  };
}

const ids = (index: CodeIndex, hidden: Set<string>) => index.entities.map((e) => e.id).filter((id) => hidden.has(id));

describe('finding on the map', () => {
  test('names are found best first: the name, its start, a word in it, then anywhere', () => {
    const found = findEntities(sample(), 'score');
    assert.deepEqual(found.map((f) => f.label), [
      // All but addScore start with it: the declaration first, then files (shortest first), then the
      // package; a word inside a name last.
      'ScoreBoard', 'score.py', 'score.test.ts', 'scoreBoard.ts', 'scorer', 'addScore'
    ]);
    const board = found.find((f) => f.label === 'ScoreBoard')!;
    assert.deepEqual(board, { id: 's:app/src/scoreBoard.ts#ScoreBoard', label: 'ScoreBoard', kind: 'type', where: 'app/src/scoreBoard.ts:3' });
    assert.equal(found.find((f) => f.label === 'scorer')!.where, 'external');
    // A word inside a camelCase name.
    assert.deepEqual(findEntities(sample(), 'board').map((f) => f.label), ['ScoreBoard', 'scoreBoard.ts']);
    assert.deepEqual(findEntities(sample(), 'TOOLS').map((f) => f.label), ['tools']);
    assert.deepEqual(findEntities(sample(), '  '), []);
    assert.deepEqual(findEntities(sample(), 'nothing'), []);
  });

  test('at most so many are found', () => {
    const index = sample();
    for (let i = 0; i < MAX_FOUND + 10; i++) index.entities.push(entity(`f:many/item${i}.ts`, 'file', 'p:app', { name: `item${i}.ts`, path: `many/item${i}.ts` }));
    assert.equal(findEntities(index, 'item').length, MAX_FOUND);
  });

  test('tests are known by their folders, their file names and their entry points', () => {
    const is = (path: string, extra: Partial<Entity> = {}) => isTest(entity('f:x', 'file', undefined, { path, ...extra }));
    assert.equal(is('app/tests/score.ts'), true);
    assert.equal(is('src/__tests__/a.js'), true);
    assert.equal(is('src/a.test.ts'), true);
    assert.equal(is('src/a_test.go'), true);
    assert.equal(is('src/ScoreTests.cs'), true);
    assert.equal(is('lib/test_score.py'), true);
    assert.equal(is('src/contest.ts'), false);
    assert.equal(is('src/latest/a.ts'), false);
    assert.equal(is('src/a.ts', { entries: [{ kind: 'test', name: 'a' }] }), true);
  });

  test('filters hide languages, projects, the packages and tests, with what they hold', () => {
    const index = sample();
    assert.deepEqual(ids(index, hiddenBy(index, undefined)), []);
    assert.deepEqual(ids(index, hiddenBy(index, {})), []);
    assert.deepEqual(ids(index, hiddenBy(index, { languages: ['python'] })), ['f:tools/score.py']);
    // A language hides its packages too.
    assert.deepEqual(ids(index, hiddenBy(index, { languages: ['typescript'] })), [
      'f:app/src/scoreBoard.ts', 's:app/src/scoreBoard.ts#ScoreBoard', 's:app/src/scoreBoard.ts#ScoreBoard.addScore',
      'f:app/tests/score.test.ts', 's:app/tests/score.test.ts#checks', 'x:npm:scorer'
    ]);
    assert.deepEqual(ids(index, hiddenBy(index, { projects: ['p:tools'] })), ['p:tools', 'f:tools/score.py']);
    assert.deepEqual(ids(index, hiddenBy(index, { externals: false })), ['x:npm:scorer']);
    assert.deepEqual(ids(index, hiddenBy(index, { tests: false })), ['m:app/tests', 'f:app/tests/score.test.ts', 's:app/tests/score.test.ts#checks']);
  });

  test('the filters offer the languages and projects there are', () => {
    assert.deepEqual(filterOptions(sample()), {
      languages: ['python', 'typescript'],
      projects: [{ id: 'p:app', label: 'app' }, { id: 'p:tools', label: 'tools' }]
    });
  });

  test('the views leave out what the filters hide, and say what they could hide', () => {
    const index = sample();
    const expanded = ['p:app', 'm:app/src', 'm:app/tests', 'p:tools'];
    const all = buildScene(index, { expanded });
    assert.ok(all.boxes.some((b) => b.id === 'f:app/tests/score.test.ts'));
    assert.deepEqual(all.options, filterOptions(index));
    assert.equal(all.filters, undefined);

    const noTests = buildScene(index, { expanded, filters: { tests: false } });
    assert.deepEqual(noTests.boxes.map((b) => b.id), ['p:app', 'm:app/src', 'f:app/src/scoreBoard.ts', 'p:tools', 'f:tools/score.py', 'externals']);
    assert.deepEqual(noTests.filters, { tests: false });
    // The tests' import is gone with them.
    assert.ok(!noTests.arrows.some((a) => a.from.includes('tests')));

    const noPackages = buildScene(index, { expanded, filters: { externals: false } });
    assert.ok(!noPackages.boxes.some((b) => b.kind === 'externals' || b.kind === 'external'));

    // The call flow from the test's entry point: with tests hidden, there's nothing to start from.
    const calls = buildCallScene(index, { mode: 'calls', expanded: [] });
    assert.ok(calls.boxes.some((b) => b.id === 's:app/tests/score.test.ts#checks'));
    const callsNoTests = buildCallScene(index, { mode: 'calls', expanded: [], filters: { tests: false } });
    assert.ok(!callsNoTests.boxes.some((b) => b.id === 's:app/tests/score.test.ts#checks'));
    assert.deepEqual(callsNoTests.filters, { tests: false });
  });
});
