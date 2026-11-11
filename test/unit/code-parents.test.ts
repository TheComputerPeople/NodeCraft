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
import { GraphDocument, NodeDefinition } from '../../src/core/model';
import { CodeClassInfo, classDefinitions, codeClassBases, codeClassById, declaredClass, subclassTest } from '../../src/core/objects';
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
  const info: CodeClassInfo = { kind: 'code-class', id: codeClassId('typescript', 'src/actor.ts', 'Actor'), type: 'native:Actor', base: 'native:Pawn', name: 'Actor', title: 'Actor', language: 'typescript', path: 'src/actor.ts', overridable: [] };
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

  test('Compile: a missing code class, one in another language, and (until generated) any other', () => {
    const errors = (doc: GraphDocument, registry: NodeRegistry) => compileDocument(doc, { registry, languages: builtinLanguagePacks(), generate: { sourceFileName: 'Knight.vgraph' } }).diagnostics
      .filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`);
    const missing = workspace(codeClassId('typescript', 'src/gone.ts', 'Gone'));
    assert.deepEqual(errors(missing.knight, missing.registry), ["parent-missing: There is no class Gone in src/gone.ts to inherit from: it isn't there, or isn't marked @blueprint (or has no marked members)."]);
    const python = workspace();
    assert.match(errors({ ...python.knight, language: 'python' }, python.registry).join('\n'), /^wrong-language: Actor is a TypeScript class \(src\/actor\.ts\); a Python graph can't extend it\.$/);
    const later = workspace();
    assert.deepEqual(errors(later.knight, later.registry), ["code-parent-unsupported: Generated code can't extend a class from your code (Actor) in TypeScript yet."]);
  });
});
