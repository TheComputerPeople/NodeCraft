// Classes from the project's code as parents of graph classes (docs/code-classes-as-parents.md,
// step 2): what each scanner reads about a class's methods (abstract, sealed, protected), the class
// definition a marked class gets, graph objects wiring to their code ancestors' pins, and Compile's
// errors for a code parent.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocument } from '../../src/core/compiler';
import { scanCpp } from '../../src/core/importing/cpp-scanner';
import { scanCSharp } from '../../src/core/importing/csharp-scanner';
import { scanJava } from '../../src/core/importing/java-scanner';
import { scanPhp } from '../../src/core/importing/php-scanner';
import { scanPython } from '../../src/core/importing/python-scanner';
import { ExposeOptions, ModuleScan, codeClassId, exposeFunctions } from '../../src/core/importing/symbols';
import { scanTypeScript } from '../../src/core/importing/typescript-scanner';
import { builtinLanguagePacks } from '../../src/core/languages';
import { Graph, GraphDocument, GraphNode, NodeDefinition } from '../../src/core/model';
import { overrideEvent } from '../../src/core/blueprint-edits';
import { CodeClassInfo, OVERRIDE_EVENT, PARENT_CALL, abstractLeft, classDefinitions, codeClassBases, codeClassById, declaredClass, subclassTest } from '../../src/core/objects';
import { createResolver } from '../../src/core/resolve';
import { lowerDocument } from '../../src/core/compiler/lower';
import { NodeRegistry } from '../../src/core/registry';

function classesOf(scan: ModuleScan, options: Partial<ExposeOptions> & { language: string; path: string }): CodeClassInfo[] {
  return exposeFunctions(scan, { exposeAll: false, ...options }).classes.map((d) => {
    assert.equal(d.implementation?.kind, 'code-class');
    assert.equal(d.type, (d.implementation as { type: CodeClassInfo }).type.id, "the definition's type is the class's id");
    return (d.implementation as { type: CodeClassInfo }).type;
  });
}

// Each overridable method, as "name(inputs) -> outputs [flags]".
const overridable = (c: CodeClassInfo) => c.overridable.map((m) => `${m.name}(${m.inputs.map((p) => `${p.id}:${p.type?.id ?? '?'}`).join(', ')})${m.outputs.length ? ` -> ${m.outputs.map((p) => p.type?.id ?? '?').join(', ')}` : ''}${m.abstract ? ' abstract' : ''}${m.protected ? ' protected' : ''}`);

describe('code classes graph classes may extend', () => {
  test('TypeScript: abstract and protected methods, marked overridable ones, and the constructor', () => {
    const [actor] = classesOf(scanTypeScript([
      '/** @blueprint */',
      'export abstract class Actor {',
      '  constructor(public name: string, lives = 3) {}',
      '  /** @blueprint */',
      '  greet(): string { return this.name; }',
      '  /** @blueprint overridable */',
      '  hit(damage: number): void {}',
      '  protected abstract describe(): string;',
      '  /** @blueprint overridable */',
      '  protected onSpawn(): void {}',
      '  protected helper(): void {}',
      '  private secret(): void {}',
      '}'
    ].join('\n')), { language: 'typescript', path: 'src/actor.ts' });
    assert.equal(actor.id, 'code:typescript:src/actor.ts#Actor');
    assert.deepEqual({ type: actor.type, title: actor.title, abstract: actor.abstract, init: actor.init?.map((p) => p.id) }, { type: 'native:Actor', title: 'Actor', abstract: true, init: ['name', 'lives'] });
    assert.deepEqual(overridable(actor), ['hit(damage:float)', 'describe() -> string abstract protected', 'onSpawn() protected']);
  });

  test("an unmarked class isn't offered; protected methods aren't nodes", () => {
    const scan = scanTypeScript('export class Plain {\n  run(): void {}\n}\n/** @blueprint */\nexport class Marked {\n  /** @blueprint */\n  protected tick(): void {}\n}\n');
    const exposed = exposeFunctions(scan, { language: 'typescript', path: 'a.ts', exposeAll: false });
    assert.deepEqual(exposed.classes.map((d) => d.displayName), ['Marked']);
    assert.ok(!exposed.definitions.some((d) => d.type.endsWith('Marked:tick')), 'a protected method has no node');
    assert.ok(exposed.skipped.some((s) => s.name === 'Marked.tick'), 'and says why, being marked without overridable');
  });

  test('Python: an ABC, @abstractmethod, and _protected methods', () => {
    const [shape] = classesOf(scanPython([
      'from abc import ABC, abstractmethod',
      '',
      'class Shape(ABC):',
      '    """@blueprint"""',
      '    def __init__(self, name: str) -> None:',
      '        self.name = name',
      '',
      '    @abstractmethod',
      '    def area(self) -> float:',
      '        ...',
      '',
      '    def _on_draw(self) -> None:',
      '        """@blueprint overridable"""',
      '',
      '    def __private(self) -> None:',
      '        pass',
      ''
    ].join('\n')), { language: 'python', path: 'shapes.py', module: 'shapes' });
    assert.deepEqual({ id: shape.id, abstract: shape.abstract, init: shape.init?.map((p) => p.id) }, { id: 'code:python:shapes.py#Shape', abstract: true, init: ['name'] });
    assert.deepEqual(overridable(shape), ['area() -> float abstract', '_on_draw() protected']);
  });

  test('C#: only virtual, abstract and override methods can be overridden, and not sealed ones', () => {
    const [actor] = classesOf(scanCSharp([
      'namespace Game;',
      '/// <summary>An actor.</summary>',
      '/// @blueprint',
      'public abstract class Actor',
      '{',
      '    public Actor(string name) { }',
      '    /// @blueprint overridable',
      '    public virtual void Hit(int damage) { }',
      '    /// @blueprint overridable',
      '    public void NotVirtual() { }',
      '    protected abstract string Describe();',
      '    /// @blueprint overridable',
      '    public sealed override string ToString() => "";',
      '}'
    ].join('\n')), { language: 'csharp', path: 'Actor.cs' });
    assert.equal(actor.id, 'code:csharp:Actor.cs#Game.Actor');
    assert.deepEqual(overridable(actor), ['Hit(damage:int)', 'Describe() -> string abstract protected']);
  });

  test('Java: abstract, final and protected methods', () => {
    const [actor] = classesOf(scanJava([
      'package game;',
      '/** @blueprint */',
      'public abstract class Actor {',
      '  public Actor(String name) {}',
      '  /** @blueprint overridable */',
      '  public void hit(long damage) {}',
      '  /** @blueprint overridable */',
      '  public final void locked() {}',
      '  protected abstract String describe();',
      '}'
    ].join('\n')), { language: 'java', path: 'src/main/java/game/Actor.java', module: 'game' });
    assert.deepEqual(overridable(actor), ['hit(damage:int)', 'describe() -> string abstract protected']);
    assert.deepEqual(actor.init?.map((p) => p.id), ['name']);
    // The types as the code writes them, which a generated override repeats.
    assert.deepEqual(actor.overridable.map((m) => m.spelling), [{ params: ['long'], returns: 'void' }, { params: [], returns: 'String' }]);
    assert.deepEqual(actor.initSpelling, ['String']);
  });

  test('C++: virtual, pure virtual (an abstract class), final and protected member functions', () => {
    const [actor] = classesOf(scanCpp([
      'namespace game {',
      '/** @blueprint */',
      'class Actor {',
      'public:',
      '  explicit Actor(std::string name);',
      '  /** @blueprint overridable */',
      '  virtual void hit(int damage);',
      '  /** @blueprint overridable */',
      '  void notVirtual();',
      '  /** @blueprint overridable */',
      '  virtual void locked() final;',
      'protected:',
      '  virtual std::string describe() const = 0;',
      '};',
      '}'
    ].join('\n')), { language: 'cpp', path: 'include/actor.h' });
    assert.equal(actor.id, 'code:cpp:include/actor.h#game::Actor');
    assert.equal(actor.abstract, true);
    assert.deepEqual(overridable(actor), ['hit(damage:int)', 'describe() -> string abstract protected']);
    // The types as the code writes them, and what follows the parameters (not `= 0`).
    assert.deepEqual(actor.overridable.map((m) => m.spelling), [{ params: ['int'], returns: 'void' }, { params: [], returns: 'std::string', qualifiers: 'const' }]);
  });

  test('PHP: abstract, final and protected methods', () => {
    const [actor] = classesOf(scanPhp([
      '<?php',
      'namespace App;',
      '/** @blueprint */',
      'abstract class Actor {',
      '    public function __construct(string $name) {}',
      '    /** @blueprint overridable */',
      '    public function hit(int $damage): void {}',
      '    /** @blueprint overridable */',
      '    final public function locked(): void {}',
      '    abstract protected function describe(): string;',
      '}'
    ].join('\n')), { language: 'php', path: 'src/Actor.php' });
    assert.deepEqual(overridable(actor), ['hit(damage:int)', 'describe() -> string abstract protected']);
  });
});

// A code class Actor (Pawn extends it), and a graph class Knight extending Actor.
function workspace(parent = codeClassId('typescript', 'src/actor.ts', 'Actor')): { registry: NodeRegistry; knight: GraphDocument } {
  const registry = new NodeRegistry();
  // Actor(name): hit(damage) overridable, describe() abstract, score() overridable, returning an int.
  const pin = (id: string, type: string, direction: 'input' | 'output' = 'input') => ({ id, name: id, kind: 'data' as const, direction, type: { id: type } });
  const info: CodeClassInfo = {
    kind: 'code-class', id: codeClassId('typescript', 'src/actor.ts', 'Actor'), type: 'native:Actor', base: 'native:Pawn', name: 'Actor', title: 'Actor', language: 'typescript', path: 'src/actor.ts',
    abstract: true, init: [pin('name', 'string')],
    overridable: [
      { name: 'hit', inputs: [pin('damage', 'int')], outputs: [] },
      { name: 'describe', inputs: [], outputs: [pin('returnValue', 'string', 'output')], abstract: true, protected: true },
      { name: 'score', inputs: [], outputs: [pin('returnValue', 'int', 'output')] }
    ]
  };
  const definition: NodeDefinition = { type: info.id, version: 1, displayName: 'Actor', category: 'Project / Classes', inputs: [], outputs: [], implementation: { kind: 'code-class', type: info } };
  registry.register(definition);
  const knight: GraphDocument = { schemaVersion: 3, name: 'Knight', kind: 'class', language: 'typescript', parent, variables: [], graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes: [], connections: [], comments: [] }] };
  return { registry, knight };
}

describe('a graph class extending a class from the code', () => {
  test("its objects wire to the code class's pins and its bases', directly or through a graph parent", () => {
    const { registry, knight } = workspace();
    const definition = (type: string) => registry.get(type);
    assert.equal(codeClassById(knight.parent, definition)?.title, 'Actor');
    const own = declaredClass(knight)!;
    const is = subclassTest(definition, own, codeClassBases(registry.all()));
    assert.ok(is('object:Knight', 'native:Actor'));
    assert.ok(is('object:Knight', 'native:Pawn'), "and the code class's own base");
    assert.ok(!is('object:Knight', 'native:Other'));
    // A graph class extending Knight is an Actor too.
    for (const d of classDefinitions(own)) registry.register(d);
    const squire: GraphDocument = { ...knight, name: 'Squire', parent: 'object:Knight' };
    assert.ok(subclassTest(definition, declaredClass(squire)!, codeClassBases(registry.all()))('object:Squire', 'native:Actor'));
  });

  test("Compile: a missing code class, one in another language, and one in a language without inheritance (Rust)", () => {
    const errors = (doc: GraphDocument, registry: NodeRegistry) => compileDocument(doc, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Knight.vgraph' } }).diagnostics
      .filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`);
    const missing = workspace(codeClassId('typescript', 'src/gone.ts', 'Gone'));
    assert.deepEqual(errors(missing.knight, missing.registry), ["parent-missing: There is no class Gone in src/gone.ts to inherit from: it isn't there, or isn't marked @blueprint (or has no marked members)."]);
    const python = workspace();
    assert.match(errors({ ...python.knight, language: 'python' }, python.registry).join('\n'), /^wrong-language: Actor is a TypeScript class \(src\/actor\.ts\); a Python graph can't extend it\.$/);
    const later = workspace();
    const rust = codeClassId('rust', 'src/actor.rs', 'Actor');
    const actor = later.registry.get(later.knight.parent!)!;
    if (actor.implementation?.kind !== 'code-class') throw new Error('no Actor');
    later.registry.register({ ...actor, type: rust, implementation: { kind: 'code-class', type: { ...actor.implementation.type, id: rust, language: 'rust', path: 'src/actor.rs' } } });
    assert.deepEqual(errors({ ...later.knight, language: 'rust', parent: rust }, later.registry), ["unsupported: Rust has no inheritance, so a Parent Class can't be compiled to it."]);
    // TypeScript's generated code extends it (docs/code-classes-as-parents.md, step 4).
    assert.deepEqual(errors(later.knight, later.registry), []);
  });
});

describe('generated code for a class extending the code', () => {
  const errors = (doc: GraphDocument, registry: NodeRegistry) => compileDocument(doc, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: `${doc.name}.vgraph` } }).diagnostics
    .filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`);
  const at = (id: string, type: string, properties: Record<string, unknown> = {}): GraphNode => ({ id, type, position: { x: 0, y: 0 }, properties });
  const actorOf = (registry: NodeRegistry, id: string): CodeClassInfo => {
    const implementation = registry.get(id)?.implementation;
    if (implementation?.kind !== 'code-class') throw new Error('no Actor');
    return implementation.type;
  };

  test('Event <Method> in a class with no code parent overrides nothing', () => {
    const { registry, knight } = workspace();
    const doc: GraphDocument = { ...knight, parent: undefined, graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], connections: [], nodes: [at('e', OVERRIDE_EVENT, { method: 'hit' })] }] };
    assert.deepEqual(errors(doc, registry), ["override-missing: Event hit overrides a method of a class from your code, and Knight doesn't extend one."]);
  });

  test("Test Case events need a class made with no arguments; the code can't have a start", () => {
    const { registry, knight } = workspace();
    const describe: Graph = { id: 'd', name: 'describe', kind: 'function', comments: [], connections: [], signature: { inputs: [], outputs: [{ id: 'returnValue', name: 'Return Value', kind: 'data', type: { id: 'string' } }] }, nodes: [at('entry', 'core:function.entry', { graph: 'd' })] };
    const tested: GraphDocument = { ...knight, graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], connections: [], nodes: [at('t', 'core:test.case', { name: 'Works' })] }, describe] };
    assert.deepEqual(errors(tested, registry), ["test-construct: Test Case events run on a new Knight, which can't be made without arguments: Actor's constructor takes name."]);
    const actor = actorOf(registry, knight.parent!);
    registry.register({ ...registry.get(actor.id)!, implementation: { kind: 'code-class', type: { ...actor, members: ['start', 'hit'] } } });
    assert.match(errors({ ...knight, graphs: [knight.graphs[0], describe] }, registry).join('\n'), /^inherited-name: Actor has a member named "start"/);
  });

  test('the program names the code classes its chains end in, and imports its own', () => {
    const { registry, knight } = workspace();
    const lowered = lowerDocument(knight, { registry, languageName: 'TypeScript', snippetLanguages: ['typescript'], importLanguages: ['typescript'], codeParents: true });
    assert.deepEqual(lowered.program?.codeClasses?.map((c) => c.id), [knight.parent]);
    assert.deepEqual(lowered.program?.imports.map((i) => [i.id, i.name, i.path]), [[knight.parent, 'Actor', 'src/actor.ts']]);
    assert.equal(lowered.program?.abstract, true, 'describe is left');
  });
});

describe('overriding and constructing a class from the code', () => {
  const definitionOf = (registry: NodeRegistry, doc: GraphDocument, node: GraphNode) => createResolver(registry, doc)(node);
  const node = (type: string, properties: Record<string, unknown> = {}): GraphNode => ({ id: 'n', type, position: { x: 0, y: 0 }, properties });
  const pins = (def: NodeDefinition | undefined) => def && [...def.inputs, ...def.outputs].map((p) => `${p.direction === 'input' ? '>' : '<'}${p.id}`).join(' ');

  test("Event <Method> has the method's parameters as outputs; Parent: <Method> calls the code's own (not an abstract one's)", () => {
    const { registry, knight } = workspace();
    const event = definitionOf(registry, knight, node(OVERRIDE_EVENT, { method: 'hit' }));
    assert.equal(event?.displayName, 'Event hit');
    assert.equal(pins(event), '<execOut <damage');
    const parent = definitionOf(registry, knight, node(PARENT_CALL, { function: 'score' }));
    assert.deepEqual([parent?.displayName, pins(parent)], ['Parent: score', '>execIn <execOut <returnValue']);
    assert.match(definitionOf(registry, knight, node(PARENT_CALL, { function: 'describe' }))!.displayName, /^Parent: describe \(abstract/);
    assert.equal(definitionOf(registry, knight, node(OVERRIDE_EVENT, { method: 'gone' }))?.displayName, 'Event gone (missing)');
  });

  test("Construct takes the parent constructor's arguments, also for a class extending the graph class", () => {
    const { registry, knight } = workspace();
    for (const d of classDefinitions(declaredClass(knight)!)) registry.register(d);
    const squire: GraphDocument = { ...knight, name: 'Squire', parent: 'object:Knight' };
    for (const d of classDefinitions(declaredClass(squire)!)) registry.register(d);
    assert.equal(pins(definitionOf(registry, knight, node('object:Knight.construct'))), '>execIn >name <execOut <object');
    assert.equal(pins(definitionOf(registry, knight, node('object:Squire.construct'))), '>execIn >name <execOut <object');
  });

  test('the abstract methods left: those no function or event in the chain overrides', () => {
    const { registry, knight } = workspace();
    const definition = (type: string) => registry.get(type);
    assert.deepEqual(abstractLeft(declaredClass(knight)!, definition), ['describe']);
    const done: GraphDocument = { ...knight, graphs: [...knight.graphs, { id: 'd', name: 'describe', kind: 'function', nodes: [], connections: [], comments: [], signature: { inputs: [], outputs: [{ id: 'returnValue', name: 'Return Value', kind: 'data', type: { id: 'string' } }] } }] };
    assert.deepEqual(abstractLeft(declaredClass(done)!, definition), []);
    // A subclass of Knight overriding it is whole too.
    for (const d of classDefinitions(declaredClass(knight)!)) registry.register(d);
    assert.deepEqual(abstractLeft(declaredClass({ ...done, name: 'Squire', parent: 'object:Knight' })!, definition), []);
  });

  test('Override as an event: Event <Method> wired to Parent: <Method> with its parameters (none for an abstract one)', () => {
    let n = 0;
    const graph: Graph = { id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes: [], connections: [], comments: [] };
    const event = overrideEvent(graph, { name: 'hit', inputs: [{ id: 'damage', name: 'damage', kind: 'data', direction: 'input' }] }, { x: 0, y: 200 }, () => `c${n++}`);
    assert.deepEqual(graph.nodes.map((x) => [x.type, x.properties]), [[OVERRIDE_EVENT, { method: 'hit' }], [PARENT_CALL, { function: 'hit' }]]);
    assert.deepEqual(graph.connections.map((c) => `${c.fromPin}>${c.toPin}`), ['execOut>execIn', 'damage>damage']);
    assert.equal(event.position.y, 200);
    overrideEvent(graph, { name: 'land', inputs: [], abstract: true }, { x: 0, y: 400 }, () => `c${n++}`);
    assert.equal(graph.nodes.length, 3, 'an abstract method has no Parent call');
  });

  test('Compile: overrides that do not fit, abstract methods left, Parent calls with nothing to call, constructing an abstract class', () => {
    const { registry, knight } = workspace();
    const codes = (doc: GraphDocument) => compileDocument(doc, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: `${doc.name}.vgraph` } }).diagnostics.map((d) => `${d.severity}:${d.code}`).sort();
    const fn = (name: string, outputs: string[]): Graph => ({ id: name, name, kind: 'function', nodes: [{ id: 'entry', type: 'core:function.entry', position: { x: 0, y: 0 }, properties: { graph: name } }], connections: [], comments: [], signature: { inputs: [], outputs: outputs.map((type) => ({ id: 'returnValue', name: 'Return Value', kind: 'data' as const, type: { id: type } })) } });
    // (Parent calls are checked where an event reaches them: after Start.)
    const events = (...nodes: GraphNode[]): Graph => ({ id: 'EventGraph', name: 'EventGraph', kind: 'event', nodes: [{ id: 's', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} }, ...nodes], comments: [], connections: [{ id: 'w1', fromNode: 's', fromPin: 'execOut', toNode: 'e', toPin: 'execIn' }, { id: 'w2', fromNode: 'e', fromPin: 'execOut', toNode: 'f', toPin: 'execIn' }] });
    const at = (id: string, type: string, properties: Record<string, unknown>): GraphNode => ({ id, type, position: { x: 0, y: 0 }, properties });
    // score returns an int, not a string; an event for a method returning a value; one for a method
    // that isn't there; hit overridden twice; Parent: describe (abstract) and Parent: Start (code has none).
    const wrong: GraphDocument = {
      ...knight,
      graphs: [
        events(at('a', OVERRIDE_EVENT, { method: 'score' }), at('b', OVERRIDE_EVENT, { method: 'gone' }), at('c', OVERRIDE_EVENT, { method: 'hit' }), at('d', OVERRIDE_EVENT, { method: 'hit' }), at('e', PARENT_CALL, {}), at('f', PARENT_CALL, { function: 'describe' })),
        fn('score', ['string'])
      ]
    };
    assert.deepEqual(codes(wrong), [
      'error:override-duplicate', 'error:override-mismatch', 'error:override-missing', 'error:override-returns', 'error:parent-abstract', 'error:parent-missing', 'warning:abstract-left'
    ]);
    // Constructing Knight (describe left abstract) from another graph.
    for (const d of classDefinitions(declaredClass(knight)!)) registry.register(d);
    const game: GraphDocument = {
      schemaVersion: 3, name: 'Game', kind: 'class', language: 'typescript', variables: [],
      graphs: [{ id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [], nodes: [at('start', 'core:event.start', {}), at('make', 'object:Knight.construct', { 'pin:name': 'Sir' })], connections: [{ id: 'w', fromNode: 'start', fromPin: 'execOut', toNode: 'make', toPin: 'execIn' }] }]
    };
    const result = compileDocument(game, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Game.vgraph' } });
    assert.deepEqual(result.diagnostics.map((d) => d.message), ["Knight can't be constructed: it doesn't override describe, abstract in Actor."]);
  });
});
