// The code index's rules (src/core/codemap/code-index.ts), on hand-made facts: projects and modules,
// graphs in place of their generated code, resolution, standard libraries, externals and entry points.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeIndex, IndexFile, IndexInput, buildCodeIndex, joinPath } from '../../src/core/codemap/code-index';
import { FileFacts, ImportFact } from '../../src/core/codemap/facts';
import { GraphDocument } from '../../src/core/model';
import { GrammarId } from '../../src/core/parsing/grammars';

function file(p: string, grammar: GrammarId, imports: Partial<ImportFact>[] = [], extra: Partial<FileFacts> = {}, generatedFrom?: string): IndexFile {
  return {
    path: p,
    facts: { grammar, declarations: [], entries: [], errors: 0, ...extra, imports: imports.map((i) => ({ kind: 'module', line: 1, source: '', ...i })) },
    ...(generatedFrom ? { generatedFrom } : {})
  };
}

function graph(p: string, nodes: string[] = ['core:event.start']): { path: string; document: GraphDocument } {
  return {
    path: p,
    document: { schemaVersion: 3, name: 'G', kind: 'class', language: 'typescript', variables: [], graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes: nodes.map((type, i) => ({ id: `n${i}`, type, position: { x: 0, y: 0 }, properties: {} })), connections: [], comments: [] }] }
  };
}

function index(input: Partial<IndexInput>): CodeIndex {
  return buildCodeIndex({ files: [], graphs: [], projects: [], folderName: 'ws', ...input });
}

const edges = (i: CodeIndex) => i.imports.map((e) => `${e.from} > ${e.to}`).sort();

describe('the code index', () => {
  test('paths join and leave the workspace only with ..', () => {
    assert.equal(joinPath('src/a', '../b/./c.ts'), 'src/b/c.ts');
    assert.equal(joinPath('', './x'), 'x');
    assert.equal(joinPath('a', '/../b'), 'b');
    assert.equal(joinPath('a', '../../b'), '../b');
  });

  test('projects hold their folders as modules, and code outside them goes in the folder', () => {
    const i = index({
      projects: [{ root: 'web', name: 'web', buildSystems: ['npm'], languages: ['typescript'] }],
      files: [file('web/src/ui/a.ts', 'typescript'), file('tools/x.py', 'python')]
    });
    const parents = Object.fromEntries(i.entities.map((e) => [e.id, e.parent ?? '']));
    assert.equal(parents['f:web/src/ui/a.ts'], 'm:web/src/ui');
    assert.equal(parents['m:web/src/ui'], 'm:web/src');
    assert.equal(parents['m:web/src'], 'p:web');
    assert.equal(parents['f:tools/x.py'], 'm:tools');
    assert.equal(parents['m:tools'], 'p:');
    assert.equal(i.entities.find((e) => e.id === 'p:')?.name, 'ws');
    // Parents come before their children.
    const order = i.entities.map((e) => e.id);
    for (const e of i.entities) if (e.parent) assert.ok(order.indexOf(e.parent) < order.indexOf(e.id), e.id);
  });

  test('a generated file is shown as its graph, its imports become the graph\'s, and support code is hidden', () => {
    const i = index({
      graphs: [graph('src/Greet.vgraph')],
      files: [
        file('src/main.ts', 'typescript', [{ source: './Greet.vgraph.ts' }]),
        file('src/Greet.vgraph.ts', 'typescript', [{ source: './text' }, { source: './vgraph_runtime' }], {}, 'Greet.vgraph'),
        file('src/vgraph_runtime.ts', 'typescript', [], {}, 'support'),
        file('src/text.ts', 'typescript')
      ]
    });
    const ids = i.entities.map((e) => e.id);
    assert.ok(ids.includes('g:src/Greet.vgraph') && ids.includes('g:src/Greet.vgraph#EventGraph'));
    assert.ok(!ids.includes('f:src/Greet.vgraph.ts') && !ids.includes('f:src/vgraph_runtime.ts'));
    assert.deepEqual(edges(i), ['f:src/main.ts > g:src/Greet.vgraph', 'g:src/Greet.vgraph > f:src/text.ts']);
    assert.deepEqual(i.unresolved, []);
    assert.deepEqual(i.entities.find((e) => e.id === 'g:src/Greet.vgraph#EventGraph')?.entries, [{ kind: 'event', name: 'Start' }]);
  });

  test("a graph's project functions are its imports before it's compiled", () => {
    const i = index({ graphs: [graph('g/A.vgraph', ['fn:python:lib/text.py#title'])], files: [file('lib/text.py', 'python')] });
    assert.deepEqual(edges(i), ['g:g/A.vgraph > f:lib/text.py']);
  });

  test('relative imports to nothing are unresolved; packages are external, once per ecosystem; standard libraries are left out', () => {
    const i = index({
      files: [
        file('a.ts', 'typescript', [{ source: './missing' }, { source: 'react' }, { source: '@scope/pkg/deep' }, { source: 'node:fs' }, { source: 'path' }, { source: './data.json' }, { source: './app.css' }]),
        file('b.js', 'javascript', [{ source: 'react' }]),
        file('c.py', 'python', [{ source: 'os' }, { source: 'numpy.linalg' }]),
        file('d.cpp', 'cpp', [{ source: 'vector', kind: 'system' }, { source: 'stdio.h', kind: 'system' }, { source: 'boost/asio.hpp', kind: 'system' }, { source: 'missing.h', kind: 'include' }])
      ]
    });
    assert.deepEqual(i.unresolved.map((u) => u.source), ['./missing', 'missing.h']);
    assert.deepEqual(edges(i), ['f:a.ts > x:npm:@scope/pkg', 'f:a.ts > x:npm:react', 'f:b.js > x:npm:react', 'f:c.py > x:pypi:numpy', 'f:d.cpp > x:c:boost']);
  });

  test('TypeScript: extensions, index files, .js written for .ts, and a workspace package by name', () => {
    const i = index({
      projects: [{ root: 'packages/shared', name: '@x/shared', packageName: '@x/shared', buildSystems: ['npm'], languages: ['typescript'] }],
      files: [
        file('app/main.ts', 'typescript', [{ source: './util' }, { source: './lib' }, { source: './esm.js' }, { source: '@x/shared' }]),
        file('app/util.ts', 'typescript'), file('app/lib/index.ts', 'typescript'), file('app/esm.ts', 'typescript'),
        file('packages/shared/src/index.ts', 'typescript')
      ]
    });
    assert.deepEqual(edges(i), ['f:app/main.ts > f:app/esm.ts', 'f:app/main.ts > f:app/lib/index.ts', 'f:app/main.ts > f:app/util.ts', 'f:app/main.ts > f:packages/shared/src/index.ts']);
  });

  test('Python: absolute imports from the project and src/, relative ones by level, and submodules imported by name', () => {
    const i = index({
      projects: [{ root: '', name: 'p', buildSystems: ['python'], languages: ['python'] }],
      files: [
        file('src/game/__init__.py', 'python'), file('src/game/core.py', 'python'), file('src/game/sub/__init__.py', 'python'), file('src/game/sub/x.py', 'python'),
        file('src/game/sub/y.py', 'python', [{ source: '', level: 1, names: ['x'] }, { source: 'core', level: 2 }, { source: 'game.core.helper' }])
      ]
    });
    assert.deepEqual(edges(i), ['f:src/game/sub/y.py > f:src/game/core.py', 'f:src/game/sub/y.py > f:src/game/sub/x.py']);
  });

  test('C# namespaces, Java packages and types, and PHP namespaces resolve to the files declaring them', () => {
    const i = index({
      files: [
        file('Program.cs', 'c_sharp', [{ source: 'Game.Graphs' }, { source: 'System.Text' }]),
        file('Graphs/A.cs', 'c_sharp', [], { package: 'Game.Graphs', declarations: [{ kind: 'class', name: 'A', container: [], line: 1, endLine: 2 }] }),
        file('Main.java', 'java', [{ source: 'a.b.C' }, { source: 'a.b.*' }, { source: 'java.util.List' }], { package: 'a' }),
        file('a/b/C.java', 'java', [], { package: 'a.b', declarations: [{ kind: 'class', name: 'C', container: [], line: 1, endLine: 2 }] }),
        file('a/b/D.java', 'java', [], { package: 'a.b', declarations: [{ kind: 'class', name: 'D', container: [], line: 1, endLine: 2 }] }),
        file('index.php', 'php', [{ source: 'App\\Models\\User' }]),
        file('src/Models/User.php', 'php', [], { package: 'App\\Models', declarations: [{ kind: 'class', name: 'User', container: [], line: 1, endLine: 2 }] })
      ]
    });
    assert.deepEqual(edges(i), [
      'f:Main.java > f:a/b/C.java', 'f:Main.java > f:a/b/D.java', 'f:Program.cs > f:Graphs/A.cs', 'f:index.php > f:src/Models/User.php'
    ]);
  });

  test("Rust: mod declarations (and #[path]), crate:: and super:: paths, and a workspace crate by name", () => {
    const i = index({
      projects: [
        { root: 'app', name: 'app', packageName: 'app', buildSystems: ['cargo'], languages: ['rust'] },
        { root: 'core', name: 'my-core', packageName: 'my-core', buildSystems: ['cargo'], languages: ['rust'] }
      ],
      files: [
        file('app/src/main.rs', 'rust', [{ source: 'net', kind: 'mod' }, { source: 'gen', kind: 'mod', path: 'graphs/gen.rs' }, { source: 'my_core::text::title' }, { source: 'std::fmt' }]),
        file('app/src/net/mod.rs', 'rust', [{ source: 'http', kind: 'mod' }, { source: 'crate::graphs::gen' }]),
        file('app/src/net/http.rs', 'rust', [{ source: 'super::super::net' }]),
        file('app/src/graphs/gen.rs', 'rust'),
        file('core/src/lib.rs', 'rust'), file('core/src/text.rs', 'rust')
      ]
    });
    assert.deepEqual(edges(i), [
      'f:app/src/main.rs > f:app/src/graphs/gen.rs', 'f:app/src/main.rs > f:app/src/net/mod.rs', 'f:app/src/main.rs > f:core/src/text.rs',
      'f:app/src/net/http.rs > f:app/src/net/mod.rs', 'f:app/src/net/mod.rs > f:app/src/graphs/gen.rs', 'f:app/src/net/mod.rs > f:app/src/net/http.rs'
    ]);
  });

  test('Go packages by module path, Lua and Ruby by their roots, GDScript by res://', () => {
    const i = index({
      projects: [
        { root: 'svc', name: 'svc', goModule: 'example.com/svc', buildSystems: ['go'], languages: ['go'] },
        { root: 'game', name: 'game', buildSystems: ['godot'], languages: ['gdscript'] },
        { root: 'rock', name: 'rock', buildSystems: ['lua'], languages: ['lua'] }
      ],
      files: [
        file('svc/main.go', 'go', [{ source: 'example.com/svc/internal/text' }, { source: 'fmt' }, { source: 'github.com/a/b/c' }], { package: 'main' }),
        file('svc/internal/text/text.go', 'go'), file('svc/internal/text/text_test.go', 'go'),
        file('rock/bin/run.lua', 'lua', [{ source: 'mylib.core' }]), file('rock/src/mylib/core.lua', 'lua'),
        file('gem/lib/a.rb', 'ruby', [{ source: 'a/b' }, { source: 'set' }, { source: 'c', kind: 'file' }]), file('gem/lib/a/b.rb', 'ruby'), file('gem/lib/c.rb', 'ruby'),
        file('game/main.gd', 'gdscript', [{ source: 'res://ui/hud.gd', kind: 'file' }, { source: 'res://ui/hud.tscn', kind: 'file' }]), file('game/ui/hud.gd', 'gdscript')
      ]
    });
    assert.deepEqual(edges(i), [
      'f:game/main.gd > f:game/ui/hud.gd', 'f:gem/lib/a.rb > f:gem/lib/a/b.rb', 'f:gem/lib/a.rb > f:gem/lib/c.rb',
      'f:rock/bin/run.lua > f:rock/src/mylib/core.lua',
      'f:svc/main.go > f:svc/internal/text/text.go', 'f:svc/main.go > x:go:github.com/a/b'
    ]);
  });

  test('entry points: main functions, scripts, package.json bins and scripts, and script folders', () => {
    const i = index({
      projects: [{ root: 'cli', name: 'cli', packageName: 'cli', bins: ['bin/run.js'], scripts: ['src/server.ts'], main: 'dist/index.js', buildSystems: ['npm'], languages: ['typescript'] }],
      files: [
        file('cli/bin/run.js', 'javascript'), file('cli/src/server.ts', 'typescript'),
        file('app.go', 'go', [], { package: 'main', declarations: [{ kind: 'function', name: 'main', container: [], line: 3, endLine: 5 }], entries: [{ kind: 'main', name: 'main', line: 3 }] }),
        file('tools/bin/gen.lua', 'lua'), file('tools/lib/x.lua', 'lua')
      ]
    });
    const entries = Object.fromEntries(i.entities.filter((e) => e.entries).map((e) => [e.id, e.entries!.map((x) => x.kind)]));
    assert.deepEqual(entries, { 'f:cli/bin/run.js': ['bin'], 'f:cli/src/server.ts': ['script'], 's:app.go#main': ['main'], 'f:tools/bin/gen.lua': ['script'] });
  });

  test('declarations nest in their containers, overloads each get their own id', () => {
    const i = index({
      files: [file('a.java', 'java', [], {
        package: 'p',
        declarations: [
          { kind: 'class', name: 'A', container: [], line: 1, endLine: 9 },
          { kind: 'method', name: 'f', container: ['A'], line: 2, endLine: 3 },
          { kind: 'method', name: 'f', container: ['A'], line: 4, endLine: 5 }
        ]
      })]
    });
    const decls = i.entities.filter((e) => e.kind === 'type' || e.kind === 'function').map((e) => [e.id, e.parent]);
    assert.deepEqual(decls, [['s:a.java#A', 'f:a.java'], ['s:a.java#A.f', 's:a.java#A'], ['s:a.java#A.f@4', 's:a.java#A']]);
  });
});
