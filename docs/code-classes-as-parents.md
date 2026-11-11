# Code classes as parents (Phase 13)

Phase 13 of the [roadmap](roadmap.md): a graph class can extend a class written in the project's code, as a Blueprint extends a C++ class. Decided on 2026-10-29 as its own phase, after Phase 9 (node authoring) gave code classes nodes; Language context, Project integration and the Codebase Map came first.

In Unreal, the C++ class does the heavy lifting and the Blueprint fills in behaviour:

- **The parent has to allow it.** A Blueprint can only extend a C++ class marked `Blueprintable`.
- **What the Blueprint sees.** It sees only the parent's `BlueprintCallable` functions and `BlueprintReadWrite` properties, and uses them on Self with no Target wire.
- **What it can override.** It implements the parent's `BlueprintImplementableEvent`s and overrides its `BlueprintNativeEvent`s. C++ calls them, and the Blueprint's version runs. Calling Parent runs the C++ version.

This phase brings that to the 12 languages, as far as each language's inheritance allows.

A "Built" section after each step says what it built.

## Today

- **Graph classes extend graph classes** ([program-structure.md](program-structure.md), "Inheritance"):
  - Class Settings' Parent Class is stored as `parent: "object:<Name>"`.
  - The parent's variables, functions, events and dispatchers are Self's.
  - My Blueprint's **Override** makes a function wired to **Parent: <Function>**.
  - Generated code uses each language's `extends`.
  - Simulate runs an object as a chain of its classes.
- **Code classes are nodes** ([node-authoring.md](node-authoring.md), gap 2), in all 12 languages:
  - `@blueprint` on a class's members makes **Construct <Class>**, methods with a **Target** pin, and Get and Set.
  - Their nodes are typed `fn:<language>:<path>#<Class>:new`, `:<method>`, `:get:<property>` and `:set:<property>`.
  - The pin type is the class's `native:` type.
  - A subclass's objects wire where its base is expected (`codeClassBases`).
- **What's missing:**
  - Class Settings lists graph classes only.
  - Nothing knows which code methods may be overridden. The scanners don't read `virtual`, `abstract` or `final`.
  - A generated class has no constructor, so it couldn't pass arguments to a parent's.
  - A graph object's type (`object:<Name>`) never wires to a code class's Target pin.

## Part 1: choosing the parent

- **Class Settings' Parent Class** lists the workspace's code classes in the graph's language, beside its graph classes, each with its file. A code class is offered when its code says it may be extended (decision 1). Abstract classes are offered too: a graph can be what makes them whole.
- **Stored as** `parent: "code:<language>:<path>#<Class>"`, the prefix its member nodes already share, so the graph names the class's file. The class's pin type stays its `native:` type.
- **When the class goes missing** (renamed, moved, its marker removed), the graph shows an error on Class Settings, as for a missing graph parent. Its nodes keep their pins until it's fixed, as Refresh Node works for functions.
- **Languages without inheritance:** Rust and Go offer no code classes as parents (decision 3). The C pack has no classes at all.

## Part 2: inherited members

- **On Self.** The parent's exposed methods and properties are Self's: the action menu offers them, and their Target defaults to Self, with no wire, as for a graph parent's members. That includes those it inherits from its own code parents.
- **The object's type.** A graph class extending `Actor` is an `Actor`: its objects wire to `Actor`'s Target pins and to any code function taking an `Actor`, and to its own and its graph ancestors' pins as before. Self, passed to code, is the object itself.
- **Overriding.** My Blueprint's **Override** lists the parent's overridable methods (decision 1).
  - A method returning nothing can be overridden as an **event**, in the event graph (Unreal's implementable and native events). One returning values is overridden as a **function**.
  - Either way, **Parent: <Method>** runs the code's own version.
  - An **abstract** method must be overridden: Compile says which are left, and the class can't be constructed until they are.
- **Constructing.** Construct <GraphClass> runs the parent's constructor, then the graph's Start, as now (decision 2).
- **Names.** A graph class's variables, functions and events may not reuse its code parent's member names, as for graph parents. A code member that isn't exposed is unknown to the graph; generated code keeps its internal names apart from it, as it does from a graph parent's private ones.

## Part 3: generated code

Each language extends the class as its code would, and imports it as its member nodes already do (`importKey`).

| Language | Extends | Overrides | Parent call | Constructor |
|---|---|---|---|---|
| TypeScript, JavaScript | `extends Actor` | a method of the same name (`override` in TypeScript) | `super.hit(…)` | `constructor(…) { super(…); }` |
| Python | `class Knight(Actor)` | a method of the same name | `super().hit(…)` | `__init__` calling `super().__init__(…)` |
| C# | `: Actor` | `override` (the method is `virtual` or `abstract`) | `base.Hit(…)` | `: base(…)` |
| C++ | `: public Actor` | `override` (the method is `virtual`) | `Actor::hit(…)` | the base's constructor in its initializer list |
| Java | `extends Actor` | `@Override` | `super.hit(…)` | `super(…)` first |
| Lua | the class table's `__index` is the parent; `new` builds on the parent's | a function of the same name | `Actor.hit(self, …)` | the parent's `new`, then the class's metatable |
| GDScript | `extends "res://…/actor.gd"` | a function of the same name | `super.hit(…)` | `_init` calling `super(…)` |
| Ruby | `class Knight < Actor` | a method of the same name | `super` | `initialize` calling `super(…)` |
| PHP | `extends Actor` | a method of the same name | `parent::hit(…)` | `parent::__construct(…)` |

- **Objects that cross.** In C++, graph objects are `std::shared_ptr<Knight>`, and code objects travel in a `vgraph::CodeObject`. A graph object passed to code is wrapped as itself and as each code class it extends, so `code_object<Actor>` finds it. The other languages pass objects as they are.
- **Checked by the project's checkers.** Generated subclasses pass the strictest settings Phase 11 set: `override` where required, no unused parameters, the parent's own types in signatures.
- **Godot.** A GDScript parent that extends a Node class makes the graph class a Node. Run builds it as a script on a node of the scene it starts, as Godot attaches scripts. In a project opened in the Godot editor, the class is a script like any other.

## Part 4: Simulate, Run and debugging

- **Simulate can't run project code** (it never could). A class with a code parent says so when Simulate starts, as a code node does. Run runs it.
- **Debugging across the boundary.** Run under the debugger (F5) stops at node breakpoints in the graph and at the code's own breakpoints.
  - Step Into on a node that calls a parent method opens the code, stopped at its first line.
  - Stepping out of that code returns to the graph, at the node after the call.
  - When the code calls a method the graph overrides, the debugger stops in the graph.

  This uses each language's debugger as Phase 5 does. It covers the languages whose debuggers the integration run with debuggers already drives.

## Decisions

The three choices this design needs:

1. **What a class allows (recommended: say it in the code, as Unreal does).**
   - A class may be extended when it is marked `@blueprint` (Unreal's `Blueprintable`), or has marked members.
   - A method may be overridden when it's marked `@blueprint overridable` (Unreal's `BlueprintNativeEvent`) or is abstract (`BlueprintImplementableEvent`), and the language allows overriding it. In C# and C++ that means `virtual` or `abstract`; Java and PHP rule out `final`.

   **Alternative:** every exposed method the language lets you override can be overridden. That's fewer markers, but any method becomes a place where a graph can change the code's behaviour, which Unreal deliberately doesn't allow.
2. **A parent's constructor arguments (recommended: Construct passes them).** Construct <GraphClass> gets the parent constructor's parameters as input pins, and the generated constructor passes them on. A parent with no constructor, or one with defaults for everything, adds no pins.

   **Alternative:** only classes constructible without arguments may be parents, as Unreal's `UObject`s are. That's simpler, but it rules out most real classes outside game engines.
3. **Rust and Go (recommended: not offered, and said why).** Neither language has inheritance. Go's struct embedding gives the parent's methods, but the parent's own code calling one of them never reaches an override, so an override would silently do nothing. Class Settings lists no code classes in Rust or Go graphs, and a graph that names one is an error explaining this.

   **Alternative:** Go embedding without overrides, for the inherited members alone. It's honest only if Override is hidden there, and then it adds little over a Target wire.

## Exit check

- **Every language with inheritance** (TypeScript, JavaScript, Python, C#, C++, Java, Lua, GDScript, Ruby, PHP). A code `Actor` with:
  - a constructor taking a name;
  - a method the graph calls on Self;
  - a property the graph reads and sets;
  - a "template method" in the code that calls an overridable method and an abstract one.

  A graph class `Knight` extends it, overrides the overridable method (calling Parent) and implements the abstract one. Constructing `Knight` and running the template method prints the same lines in every language, under the project's strictest checkers (Phase 11's).
- **The corpus:** one layout per language with inheritance gets such a graph, and builds, checks and runs as Phase 11's corpus does.
- **The editor:** Class Settings lists the code class, the action menu offers its members on Self, Override lists what may be overridden, and Compile reports an abstract method left unimplemented.
- **Debugging:** in TypeScript and Python, Step Into from the graph reaches the parent's code and steps back out, and a breakpoint in an overriding event is hit when the code calls it.
- **Rust and Go** say why they can't, in Class Settings and in Compile.

## Steps

1. This design, the roadmap entry and the decisions above.
2. The model: a code class as `parent`, what the scanners read about classes (marked classes, overridable and abstract methods, `virtual`, `final`, constructors), Class Settings' list, a missing parent's error, and graph objects wiring to their code ancestors' pins.
3. The editor: the parent's members on Self, Override and Parent calls for code methods, events overriding methods, abstract methods left unimplemented, and Construct's parent-constructor pins.
4. Generated code in TypeScript, JavaScript, Python and C#.
5. Generated code in C++ and Java.
6. Generated code in Lua, GDScript, Ruby and PHP.
7. Rust and Go reported; Simulate's message.
8. Debugging across the boundary.
9. The exit check, docs, the parity checklist and status.

## Not in this phase

- **Code classes extending graph classes:** the other way round. Generated code is output, and code can import it already.
- **Interfaces from code** that graph classes implement. Graph interfaces stay as they are.
- **Generics:** a parent class with type parameters (`Repository<T>`). Generic code functions are nodes (Phase 9), but a generic parent needs its type arguments chosen in Class Settings; that's later, with generics in C++, Go, Lua and PHP.
- **Engine classes beyond Godot's:** Unity's `MonoBehaviour` or Unreal's own classes as parents need those engines' build steps; they come with framework packs.
