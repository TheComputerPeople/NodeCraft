# Roadmap

## North star

A VS Code extension that works like Unreal Engine Blueprints for **any programming language**. Someone fluent in Blueprints should be able to open a `.vgraph` file and work productively without reading documentation: same vocabulary, same visual language, same gestures, same mental model of execution.

Two requirements drive every decision below:

1. **Language-universal.** The graph never assumes a target language. Language support is a plug-in concern.
2. **Blueprint parity.** Where Unreal has an established convention (names, colors, shortcuts, panels, semantics), we copy it unless it is engine-specific. Deviations need a reason.

## The core design: what "universal" means

Unreal Blueprints are a visual layer over a host language (C++). They work because of three things: **reflection** (C++ functions and types marked `BlueprintCallable` appear as nodes), a **compiler** (graphs compile to bytecode for the Blueprint VM), and **engine events** (BeginPlay, Tick) that give graphs entry points.

We reproduce each one in a language-neutral way:

| Unreal | This extension |
|---|---|
| Blueprint graph | `.vgraph` file, the language-neutral source of truth |
| Blueprint compiler → bytecode | Graph → **Visual IR** → **generated source code** in the project's language |
| Blueprint VM | The project's own toolchain (node, python, dotnet, cargo, …) runs the generated code |
| `UFUNCTION(BlueprintCallable)` reflection | **Code interop**: functions and types from the user's code are discovered and offered as nodes |
| Blueprint debugger | Node breakpoints mapped onto generated code, driven through the language's existing **debugger (DAP)** |
| Engine events (BeginPlay, Tick) | **Entry-point events** supplied by the language pack and optional framework packs (Main, test case, HTTP handler, …) |

### Execution model: code generation (decided)

Every graph compiles to readable source code in the target language, written next to the graph (for example `Inventory.vgraph` → `Inventory.vgraph.ts`). This is the only model that scales to any language, because we never have to build or ship a runtime per language. It also means:

- Teammates without the extension can still build and run the project, since the generated code is ordinary source.
- Performance matches hand-written code.
- Every language's existing debugger, test runner, linter and packaging keep working.

The current in-extension interpreter (`GraphRuntime`) stays, but changes role: it becomes the **reference semantics** (the oracle that every language adapter's generated code is tested against) and a **quick "Simulate" mode** for graphs that use only core nodes.

### Language packs

A language pack is the unit of language support. It provides:

- **Detection**: recognizes the project's language from workspace markers (`package.json`/`tsconfig.json`, `pyproject.toml`, `*.csproj`, `CMakeLists.txt`, `Cargo.toml`, `go.mod`, …).
- **Type mapping**: maps between canonical graph types and language types.
- **Code generation**: emits source from Visual IR, along with a source map from graph nodes to generated lines.
- **Output placement**: where generated files go (next to the graph by default) and any step needed to register them with the build, such as a CMake entry or a Rust `mod` declaration.
- **Core node emitters**: how Branch, Sequence, For Each Loop, Delay, variables, etc. are written in this language.
- **Symbol import**: turns the user's functions and types into node definitions.
- **Run and debug**: the launch/task configuration for running generated code and attaching a debugger.
- **Capabilities**: which concepts the language supports (classes, inheritance, interfaces, async, generics, exceptions, …). The editor hides or disables features the active language can't express, instead of generating broken code.

Support comes in tiers:

| Tier | How it works | Examples |
|---|---|---|
| 1, Full | Hand-written adapter with precise symbol import and debugging | TypeScript/JavaScript, Python, C# |
| 2, Generic | Symbol import through the language server (LSP) and code generation from a declarative template pack | Most other languages with a VS Code language server |
| 3, User-defined | A declarative adapter written by the user (templates plus a type map) | In-house or niche languages |

### Canonical type system

Graphs use a small set of canonical types that every pack maps: `bool`, `int`, `float`, `string`, `array<T>`, `set<T>`, `map<K,V>`, `struct`, `enum`, `object<Class>`, `function`, `wildcard`. Types imported from user code that have no canonical equivalent become **native types**: pins that are type-checked by name and passed through untouched. This keeps graphs language-neutral without losing type safety on user code.

## Phases

The order is deliberate. Universality is the first requirement, so the IR and the first two language packs come **before** most of the editor-parity work. Otherwise we would build dozens of features on JavaScript-shaped assumptions and pay to undo them later.

### Phase 0: Foundations

Status: complete (October 2026).

Goal: a codebase that can carry the rest of this roadmap.

- Put the project under version control (the folder isn't a git repository yet).
- Add a test harness: unit tests for the serializer, registry and runtime; extension integration tests (`@vscode/test-electron`); interaction tests for the webview.
- Move the webview from one 1,100-line script to TypeScript modules bundled with esbuild. Keep the custom renderer (no React Flow): Blueprint feel depends on control over wires, pins and gestures.
- **`.vgraph` schema v2**, designed for everything later phases need: graph kinds (class, function library, macro library), multiple graphs per file (event graph, functions, macros), variables with container types (single/array/set/map), local variables, comments, reroute nodes, and a migration path from v1.
- Define the canonical type system and the language pack interface (in code, with the current JS behavior as the first implementation).
- Workspace Trust: code generation and Simulate are disabled in untrusted workspaces.

Exit: `npm test` passes (and runs in CI once the repo has a remote), the v1 sample graph migrates to v2 without loss, and the existing editor works on the new schema.

### Phase 1: Prove universality

Status: complete (October 2026). The conformance suite runs every fixture graph in Simulate and as generated TypeScript, JavaScript (ES modules and CommonJS) and Python with identical output. JavaScript and Python were added as packs without changing the compiler, IR or runtime.

Goal: the same graph compiles to two very different languages and behaves identically.

- **Visual IR and compiler pipeline**: validation → IR (control flow from exec wires, expressions from pure nodes) → language pack → generated file and source map, written where the pack's output placement says (next to the graph for TypeScript and Python). Phase 1 also builds the output-plan contract, generated-file naming and rename/move/delete handling from [output-placement.md](output-placement.md).
- Blueprint semantics are written down and tested, including the subtle ones (for example, pure nodes are re-evaluated each time a connected impure node executes). See [semantics.md](semantics.md).
- **TypeScript/JavaScript pack** first (the current runtime and node templates are already JS).
- **Python pack** second: different syntax, runtime and typing discipline, with low toolchain friction. It exposes JS-shaped assumptions early.
- **Compile** button plus a Compiler Results panel. Errors and warnings appear as badges on the offending nodes, as in Unreal.
- **Conformance suite**: each test graph runs in the reference interpreter and through each pack's generated code, and the execution traces must match.
- Per-graph target language, defaulting to the language detected from the workspace.

Exit: the sample graphs produce identical output in Simulate, in generated TypeScript and in generated Python, and adding a third pack needs no changes to core code.

### Phase 2: Blueprint look and feel

Status: complete (October 2026), with the deferrals below. A browser test builds the sample graph from an empty file using only Unreal's gestures (hold-key placement, the action menu, dragging from pins, inline values, F7) and checks that it compiles and prints the same result.

- **Deferred to Phase 4**, because they need nodes or types that arrive there: collapse to function/macro, Make Array and Append, wildcard pins, split struct pins, hold-key placement for D/G/F/M/N/O, event dispatchers, local variables, and container defaults.
- **Deferred to later**: action-menu favorites (per-user state that needs settings storage).
- **Deviations from Unreal**: a new Sequence node has three outputs (Unreal's has two). int and float connect directly, without a visible conversion node. Large graphs stay responsive by drawing wires from cached pin positions and redrawing only what moves, not by virtualizing nodes; a 500-node graph drags and pans in well under a frame.

Goal: a Blueprint user recognizes the editor at a glance and their hands already know the shortcuts. Everything here is language-independent.

- **Visual language**: white exec pins with triangle arrows; circular data pins colored by type using Unreal's palette (bool red, int teal, float green, string magenta, object blue, struct dark blue, wildcard grey); wires take the type color; distinct title styles for event, function, pure function and macro nodes; pure nodes have no exec pins.
- **Panels with Unreal names**: rename Inspector to **Details**; add a **My Blueprint** panel (Graphs, Functions, Macros, Variables, Event Dispatchers, Local Variables).
- **Inline pin defaults** on the node body, not only in Details.
- **Graph editing**: copy/paste (including between files, as text like Unreal), comments (C around a selection), reroute nodes (double-click a wire), straighten and align, collapse to function/macro, add-pin buttons (Sequence, Make Array, Append), wildcard pins that adopt a type when connected, split/recombine struct pins, promote pin to variable.
- **Variables**: Ctrl-drag from My Blueprint creates a Get, Alt-drag creates a Set; container-type selector.
- **Action menu**: "Context Sensitive" toggle, keyword search, favorites.
- **Auto-conversion**: connecting int to float or anything to string inserts the conversion node automatically.
- **Hold-key spawning**: e.g. B+click for Branch, S+click for Sequence, D+click for Delay.
- **Find in Blueprint** (Ctrl+F) and **Find in All Blueprints** (Ctrl+Shift+F).
- Large-graph performance (render only what's visible).

Exit: a Blueprint user, given no instructions, can build the sample graph from scratch. Every shortcut in the parity table below is implemented or deliberately marked as not applicable.

### Phase 3: Your code as nodes

Status: complete (October 2026). In a TypeScript and a Python workspace, a marked function appears as a node, a graph calls it, the generated code imports and runs it, and renaming it in code is detected (integration and conformance tests).

- **Changed from the plan:** declarations are read by scanners in `src/core` rather than the TypeScript compiler API or Python's `ast`; they are checked against `ast` and `tsc` in the tests. Tier 2 import through a language server moves to Phase 6.
- **Deferred to Phase 4:** methods and classes as nodes, async functions as latent nodes, generic functions, functions with several outputs (Unreal's out parameters, and the success flags of the file nodes), and collection nodes.
- **Deferred to Phase 5:** Simulate can't call project functions; Run does.

Goal: the equivalent of `BlueprintCallable`. The user's existing code shows up in the palette.

- Tier 1 packs import precisely (TypeScript compiler API, Python `ast`/type hints, Roslyn for C#).
- Tier 2 import through any language server: workspace/document symbols plus signature information, with types parsed into canonical or native types.
- **Explicit exposure**, as in Unreal: a lightweight marker (decorator, attribute, annotation or doc-comment tag, depending on the language) selects what becomes a node, so the palette isn't flooded. An "expose everything" setting covers small projects.
- Generated code imports what it uses; renaming or deleting a function in code flags the affected nodes.
- The standard library of each language is available as curated node packs (math, strings, collections, file and console I/O).

Exit: in a TypeScript and a Python project, a function written by hand appears as a node, can be called from a graph, and refactors are detected.

Design: [code-as-nodes.md](code-as-nodes.md). Steps, one commit each:

1. Design and plan (this list).
2. Pure nodes and function calls in the core: the IR, the compiler, Simulate and both generators, including generated imports.
3. TypeScript and JavaScript declaration scanner: markers, parameters, defaults, type mapping.
4. Python declaration scanner.
5. Workspace import: scanning and watching the project, the palette, the "expose all" setting, import specifiers and Run.
6. Refactor detection: stored signatures, badges and diagnostics, Refresh Node, Refresh All Nodes, Replace with ….
7. Standard library nodes (math, string, utilities, file).
8. Documentation and an end-to-end test in a TypeScript and a Python project.

Deliberate changes from the original plan: declarations are read by scanners in `src/core`, not the TypeScript compiler API or Python's `ast` (see the design for why). Tier 2 import through a language server moves to Phase 6, with the declarative packs it serves: every language that can generate code before then has a precise importer.

### Phase 4: Program structure

Goal: the full set of Blueprint authoring concepts, each enabled per language through its pack's capabilities.

- **Functions** (inputs, outputs, local variables, return node, pure/impure), **macros** (expanded inline at compile time, multiple exec outputs), function libraries and macro libraries.
- **Flow-control library**: For Loop, For Loop with Break, For Each Loop, While Loop, Do Once, Do N, Gate, MultiGate, Flip Flop, Switch on Int/String/Enum, Select, Is Valid.
- **Structs and enums** as assets, with Make/Break nodes.
- **Classes**: a graph can be a class (variables, functions, event graph), extend a class from user code, and implement interfaces. Includes **Cast To** with success/failure exec pins.
- **Event dispatchers** (mapped to callbacks/delegates/events/observers per language) and custom events.
- **Latent actions** such as Delay, mapped to each language's async model (async/await, coroutines, tasks).
- **Entry-point events** from the language pack (Main, test case) and optional **framework packs** that add domain events (for example HTTP request handlers, CLI commands, or game-framework lifecycle events such as an engine's start/update callbacks).

Exit: a non-trivial program (classes, functions, events, async) is built entirely in graphs and runs correctly from generated TypeScript, Python and C#.

Status: complete (October 2026), with the deferrals below. The exit program, sample/arena, is built only in graphs: an enum, a struct, a class with a function of several outputs and an event dispatcher, a subclass that overrides a function and calls its parent, and a Game that constructs both, binds a custom event to the dispatcher, fights in a For Loop with Break with a macro, switches on the enum and ends after a Delay. The conformance suite runs it in Simulate and as generated TypeScript, JavaScript (ES modules and CommonJS), Python and C# with identical output, and type-checks the TypeScript and JavaScript under `--strict`.

- **Deferred:** classes from the project's code as parent classes (Phase 3's deferral stands), Test Case events (Phase 5, with debugging), sets and map keys of structs or enums, a pure Cast To, and MultiGate's Is Random.

Design: [program-structure.md](program-structure.md). Steps, one commit each (large steps may take several):

1. Design and plan (this list).
2. C# language pack: generator, runner, conformance on every fixture, placement, and C# functions as nodes.
3. Flow control: loops, Do Once, Do N, Gate, MultiGate, Flip Flop, Switch on Int/String, and their hold keys.
4. Containers: values and defaults, Make Array/Set/Map, wildcard pins, For Each Loop, the array, set and map functions.
5. Functions: function graphs, call nodes, several outputs, local variables, pure functions, recursion, Collapse to Function, function libraries.
6. Macros: tunnels, inline expansion, macro libraries, Collapse to Macro.
7. Structs and enums: the asset kinds and their editors, Make/Break, Set Members, split pins, Switch on Enum.
8. Custom events and event dispatchers.
9. Classes: object references, Construct Object, Target pins, inheritance (graph and code classes), overrides and Parent calls, interfaces, Cast To.
10. Latent actions: Delay and Retriggerable Delay, generated as timers, Simulate's virtual clock.
11. Entry points (Main; Test Case moves to Phase 5) and the framework pack format.
12. The exit program, documentation and the parity checklist.

### Phase 5: Debugging

Goal: Blueprint debugging, powered by each language's real debugger.

- F9 toggles a breakpoint on a node. The source map turns it into a breakpoint in the generated code, set through DAP.
- When execution stops, the editor highlights the current node and the path that led to it; F10/F11 step over and step into (including into function graphs).
- Hovering a pin shows its live value (via DAP `evaluate`); **Watch this value** pins a value to the node.
- Animated pulses along exec wires during execution.
- The call stack is shown in graph terms (graph and node names, not generated line numbers).
- Simulate mode supports the same breakpoints and stepping without a toolchain.

Exit: the debugging loop works in TypeScript, Python and C# without the user ever opening a generated file.

Status: complete (October 2026), with the deferrals below. The exit check is in the integration suite: a graph whose Start calls a function graph stops at a breakpoint on the call, steps into the function graph (the call stack in graph terms), reads the function's input, resumes to a breakpoint in the function graph, reads a computed value, steps out to the caller and runs to the end, with the graph editor in front throughout. It runs in generated TypeScript and JavaScript on every run, and in Python and C# with `npm run test:integration:debuggers` (which loads the Python Debugger and C# extensions). Simulate's debugger does the same in the unit tests, without a toolchain.

- **Narrow editors** (fixed before the merge): the side panels narrow with the editor and collapse to strips (Details below 760 px, My Blueprint and the Palette below 540 px, or with their buttons; the user's choice is kept). Toolbar buttons never wrap, the graph's name and the status shrink, and the bar scrolls only when the buttons don't fit. The browser tests check the layout at 1088, 700 and 480 px.
- **Deferred:** stepping into a macro's graph (a macro use steps as one node); pin values in frames other than the innermost one running a graph; pure nodes' values in generated code (they aren't stored, so the bubble says so); xUnit test files for C# (C# tests run through Run's project); syncing a mirrored breakpoint's enabled state from VS Code back to the graph; Simulate calling project functions (Phase 3's deferral: Debug runs the real code instead).

Design: [debugging.md](debugging.md). Steps, one commit each (large steps may take several):

1. Design and plan (this list).
2. Breakpoints in the editor: F9, Ctrl+Shift+F9, the node menu, markers; stored per workspace.
3. Debugging in Simulate: the runtime's debug hook, the worker, pausing at breakpoints, Resume and Step Over/Into/Out, the current node and path, the call stack in graph terms.
4. Values while paused in Simulate: pin hover, Watch this value.
5. Exec wire pulses during Simulate.
6. Debugging generated TypeScript and JavaScript through js-debug: breakpoints mirrored from nodes, stopped frames mapped to nodes, stepping by node, the call stack, pin values through `evaluate`.
7. Debugging generated Python (debugpy) and C# (coreclr).
8. Test Case events, Assert nodes and Run Tests (moved from Phase 4).
9. Documentation, the parity checklist and the exit check.

### Phase 6: Language breadth

Goal: support for most languages without a hand-written adapter for each.

- Declarative language pack format (templates plus a type map plus capabilities) for Tier 2 and Tier 3.
- Tier 1 packs beyond the first three, prioritized by demand. Candidates and their design implications are in [language-notes.md](language-notes.md): C++ first (closest to Unreal), then Rust and Java; C as a declarative Tier 2/3 pack. Go and others to be assessed the same way.
- A public extension API so language packs and framework packs can ship as separate VS Code extensions.
- Library versioning and dependency manifests for node libraries (building on `node-package.schema.json`).
- The conformance suite is published, so pack authors can verify their adapter.

Exit: a new language pack, written as a separate extension using only the public API, passes the conformance suite.

Status: complete (October 2026), with the deferrals below.

- **The exit check:**
  - The C pack (`examples/c-language-pack`) is its own VS Code extension: a declarative definition that `extension.js` registers with `registerDeclarativePack`, and nothing else.
  - With gcc, it passes the 15 fixtures it can express in the published suite, both from the SDK's `blueprint-conformance` and in the repository's tests. The other 5 are not applicable because of capabilities C lacks: containers, dispatchers, Delay, and the two object programs.
  - The integration suite loads it as a second extension, compiles and runs a C graph, and with the C/C++ extension loaded it passes the Debug test and the Phase 5 debugging exit check.
- **The rest of the phase:**
  - Capabilities are enforced by the compiler and the editor.
  - The pack SDK and the published conformance suite.
  - The public API, and output plans with consented build hooks.
  - C++, Rust, Java and Go as Tier 1 packs, each with placement, symbol import and debugging. Java and Go were added after the exit check, once their toolchains were installed.
    - Java passes all 20 fixtures; Go passes all but the arena (inheritance), as Rust does.
    - Java debugs with the Debugger for Java, Go with Delve. Both pass the Debug test and the Phase 5 exit check.
    - Go imports project functions through gopls.
  - The declarative format, with workspace packs and Tier 2 symbol import through the language server.
  - Versioned node packages.
- **Deferred:**
  - Rust traits (Blueprint interfaces), and inheritance in Go (embedding has no virtual calls).
  - Java project methods with `int` or other non-canonical types (they're native pins, since Java won't narrow the generated `long`s), and methods that declare checked exceptions.
  - In Go: Run for graphs in `package main`, and latent actions shared between packages (each package has its own queue).
  - MSVC's `cl` for C++.
  - CodeLLDB (Rust's debugger outside Windows), which is untested here.
  - Probing with `cargo metadata` or CMake's File API (placement reads files).
  - Under Run, Rust project modules that need the crate's dependencies.
  - In the declarative format: object references, inheritance, interfaces, dispatchers and latent actions. In the C pack: containers, structs and enums.
  - Node packages from a registry: they come from the workspace and from extensions.

Design: [language-breadth.md](language-breadth.md). Java was deferred at first (no JDK here), then added with Go once their toolchains were installed (steps 14 to 18); C is the declarative pack and the exit check's separate extension. Steps, one commit each (large steps may take several):

1. Design and plan (this list).
2. Capabilities enforced: finer flags, nodes' `requires`, `unsupported` diagnostics, and the editor hiding what a language can't express.
3. The pack SDK package and the published conformance runner (applicability by capability), with the built-in packs' conformance tests moved onto it.
4. The public API: registering language packs, declarative packs and node libraries at runtime, with API versions; editors follow the changes.
5. Output plans: extension-owned files and consented one-time hooks.
6. C++: the generator and runner, passing the conformance suite.
7. C++: CMake placement, symbol import, debugging and tests.
8. Rust: the generator and runner, passing the conformance suite.
9. Rust: `mod` placement, symbol import, debugging and tests.
10. The declarative pack format: schema, template interpreter, helpers, and workspace (Tier 3) packs.
11. Tier 2 symbol import through the language server.
12. Node library packages: manifests, versions, dependencies, and graphs remembering versions.
13. The exit check: the C pack as a separate extension in `examples/`, passing the published suite; documentation and the parity checklist.
14. Java: the generator and runner, passing the conformance suite.
15. Java: package placement, symbol import, debugging and tests.
16. Go: the generator and runner, passing the conformance suite.
17. Go: package placement and the runtime file, symbol import through gopls, debugging and tests.
18. The phase's checks again with Java and Go, documentation and the parity checklist.

### Phase 7: Multi-language projects

Goal: identify where multi-language workspaces break, then decide which gaps to close. This phase is analysis first, by design.

What already works: each graph targets one language, so a workspace with TypeScript graphs in one folder and Python graphs in another needs nothing new. Node libraries can already carry implementations for several languages (the `languages` map on code nodes).

Known gaps to evaluate:

- **Cross-language calls** from a graph in one language to code in another. Candidate approaches: process boundaries (CLI/HTTP/gRPC nodes generated from a shared interface), C ABI/FFI bindings, WebAssembly components.
- **Shared types** between languages (structs/enums defined once and generated per language).
- **Polyglot node libraries**: rules for when a node is available in a graph whose language its library doesn't implement.
- **Project-level settings** when folders disagree about the target language.

Exit: a written gap analysis with a recommendation per gap, then a decision on which to build.

Analysis: [multi-language.md](multi-language.md) (2026-10-27). It found a bug as well as gaps: a type from another language disappears from a graph without a compile error.

Decided (2026-10-27): all of its recommendations.

Status: complete (October 2026).

- **Built:**
  - A new graph takes the language of the project files nearest to where it's saved, and the `blueprintVisualScripting.defaultLanguage` setting can set it per folder.
  - A graph that uses another language's struct, enum, class or interface gets a compile error, and Simulate stops with it (before, the value vanished from the generated code). A type name declared in two files is reported.
  - The palette hides code nodes with no implementation in the graph's language.
  - Structs and enums can be shared: one file, generated for each of its languages.
- **Documented:** calls into another language go through a project function that crosses the boundary ([examples/multi-language](../examples/multi-language/README.md)).
- **Deferred:** generated bindings for cross-language calls (a process boundary from a shared interface), and shared classes and interfaces. Both need a call boundary between languages.

Steps, one commit each:

1. The gap analysis.
2. Report a type used from another language, and a type name declared twice.
3. A new graph's language from its folder, and a per-folder setting.
4. The palette hides nodes with no implementation in the graph's language.
5. Shared structs and enums: several target languages per type file, a generated file for each.
6. Calls into another language: the project-function pattern documented with an example; the parity checklist and status.

### Phase 8: More languages

Goal: Lua, GDScript, Ruby and PHP as Tier 1 packs, Lua and GDScript first (decided 2026-10-28). Lua and GDScript are the scripting languages of game engines, Blueprint's own audience; Ruby and PHP cover web back ends.

Exit: each passes the conformance suite and the Phase 5 debugging exit check, with placement and symbol import, as Java and Go did.

Design and steps: [more-languages.md](more-languages.md).

Status: complete (October 2026).

- **Built:** Lua, GDScript (Godot 4), Ruby and PHP as Tier 1 packs. Each passes all 25 conformance fixtures, both object programs included, and has placement and symbol import, each tested against its toolchain.
- **Debugging:** Lua (Lua Debug), GDScript (godot-tools, in a Godot project), Ruby (rdbg) and PHP (Xdebug through PHP Debug) pass the Debug test and the Phase 5 exit check.
- **Learned on the way:**
  - GDScript has no exceptions, and none of Godot's ways to end a process report a failure cleanly, so a failure is recorded and generated code returns after any statement that may fail.
  - rdbg's VS Code mode can't step out of a method, so a pack can now say its steps can't leave a function (`CodeDebugger.stepsLeaveFunctions`), and leaving one resumes to a breakpoint on the caller's next node.
  - PHP copies arrays on assignment, so its containers are the support file's objects. PHP Debug turns Xdebug's debug mode on only for its own launch of the current file, so the pack's configuration does the same.
- **Deferred:** Composer's autoloader for generated PHP classes (generated files load each other with `require_once`), GDScript's signals and other Godot events as a framework pack, and subnormal numbers in GDScript's number formatting (Godot prints them as 0).

### Phase 9: Node authoring

Goal: make nodes the ways Unreal does, from code and from other nodes, with nothing missing that Unreal's function libraries, member functions and properties offer. Decided 2026-10-28, after the utility library grew to 94 nodes: review how users make nodes, then build it as a phase.

Before it: functions marked `@blueprint` in all 12 languages, Blueprint Function and Macro Libraries, Collapse to Function and Macro, and `*.node.json` snippet nodes in versioned packages.

Gaps (the review, with a design for each: [node-authoring.md](node-authoring.md)):

- Function libraries serve one language.
- Code classes' methods and properties aren't nodes.
- Code functions have one output and can't be async.
- No way from a node to its definition.
- Less metadata than Unreal's (Compact Node Title, Deprecated, Advanced pins, ExpandBoolAsExecs).
- Little feedback while writing code or snippet nodes.
- Library graphs can't be packaged.

Exit: a TypeScript and Python workspace that uses every path (a library for both languages, code classes through Target pins with several outputs and an async function, a tested node library, an added graph package), running from Run in both languages; each language's interop test covers code classes and several outputs.

Status: complete (October 2026), with the deferrals below. The exit check is sample/node-authoring, a TypeScript and Python workspace:

- **What it uses.**
  - A code class in each language: Construct, a method, Get and Set, several outputs, and an async method as a latent node.
  - A function library generated for both languages.
  - A snippet node with examples.
  - A graph package as Add Blueprint Package leaves it.
- **The conformance test.** It builds the workspace's nodes as the extension does. Its graphs run in both languages and print the same output. Every node reaches its definition, the package's version is recorded, and the node library's examples pass in both languages.
- **The integration suite.** It covers each part in VS Code:
  - Go to Definition and Find References;
  - the warnings and Expose quick fixes;
  - New Node and node file problems;
  - Test Node Library;
  - Add Blueprint Package.
- **Interop tests.** Each language's covers code classes, several outputs (all but GDScript, which has none) and, where the language has a standard future, async functions.

Design and steps: [node-authoring.md](node-authoring.md), with what each step built.

- **Deferred:**
  - Async functions in Rust, Go, C++, Lua, Ruby, PHP and GDScript: no standard future, or one that needs an executor or a framework.
  - Code classes as parents of graph classes.
  - Generic functions in C++ (templates), Go, Lua (`---@generic`) and PHP (`@template`), and generic functions with more than two type parameters.
  - A package registry: packages come from folders and extensions.

### Phase 10: Release

Marketplace packaging waits until the platform is complete and robust (decided 2026-10-28).

- A "Coming from Unreal" guide that maps every Unreal concept to its equivalent here, and lists what doesn't apply.
- An onboarding sample per Tier 1 language.
- Marketplace packaging, accessibility pass (keyboard-only graph editing, screen-reader labels), settings documentation.

## Non-goals

- **Converting code back into graphs.** Generated code is output; the graph is the source. Editing generated files by hand isn't supported (they carry a do-not-edit header and are overwritten on compile).
- **Reproducing the Unreal engine.** Actors, components, levels, and the Tick loop are engine features. Framework packs can provide equivalents for specific frameworks, but the core stays engine-agnostic.
- **Running every language inside the extension.** Execution happens in the project's own toolchain; Simulate covers core nodes only.

## Decisions

Confirmed on 2026-10-08:

1. **Code generation.** Graphs compile to source code in the project's language and run through the project's own toolchain. No interpreter is built per language; the reference interpreter stays only as the semantic oracle and for Simulate mode.
2. **First packs: TypeScript, then Python, then C#**, covering dynamic, gradually typed and statically compiled languages before the architecture hardens. Notes on C, C++, Rust, Java and JavaScript, including where they strain the design, are in [language-notes.md](language-notes.md).
3. **Webview: TypeScript plus esbuild with the existing custom renderer**, rather than React Flow (implemented in Phase 0).
4. **Generated code is committed next to its graph**, so the project builds for people who don't have the extension. Some languages can't follow this as-is (Java's package directories, build-file registration for C/C++, Rust `mod` declarations), so each language pack detects the project's structure and places and registers output accordingly. It keeps next-to-the-graph wherever the language allows, and edits user-owned build files only through a one-time, consented hook. See [output-placement.md](output-placement.md).

## Appendix: Blueprint parity checklist

Use this as the tracking list. Status: ✅ done, 🟡 partial, ⬜ not started. The expected behaviors, with sources, are in [unreal-conventions.md](unreal-conventions.md); Epic's Blueprint Editor Cheat Sheet is the reference where it covers a behavior.

| Area | Unreal behavior | Status | Phase |
|---|---|---|---|
| Navigation | Right-mouse drag pans; wheel zooms | ✅ | — |
| Navigation | Home zooms to fit the selection | ✅ | — |
| Selection | Shift+click adds, Ctrl+click toggles | ✅ | — |
| Selection | Marquee: drag replaces, Shift+drag adds, Ctrl+drag removes | ✅ | — |
| Wiring | Drag pin to pin | ✅ | — |
| Wiring | Drag pin to empty space opens a filtered action menu | ✅ | — |
| Wiring | Exec inputs accept many wires; exec outputs and data inputs accept one | ✅ | — |
| Wiring | Alt+click a pin breaks its links | ✅ | — |
| Wiring | Ctrl+drag a pin moves all its links | ✅ | — |
| Wiring | Hovering a pin highlights its wires | ✅ | — |
| Wiring | Double-click a wire adds a reroute node (community) | ✅ | — |
| Wiring | Alignment menu; Q straightens, Shift+W/A/S/D align (community) | ✅ | — |
| Nodes | Right-click action menu with "Context Sensitive" toggle; keyword search | ✅ | — |
| Nodes | Separate right-click menus for the background, a node, a pin (pin actions above node actions) and a comment | ✅ | — |
| Nodes | Hold-key + click placement: B, S, C, P | ✅ | — |
| Nodes | Hold-key + click placement: G, M, N, O | ✅ | — |
| Nodes | Hold-key + click placement: F | ✅ | — |
| Nodes | Hold-key + click placement: D (Delay) | ✅ | — |
| Nodes | Cut/copy/paste (also between graphs and files, as text), Ctrl+D duplicate | ✅ | — |
| Nodes | Arrow keys move the selection; F2 renames comments, variables and graphs | ✅ | — |
| Nodes | C wraps the selection in a comment; comments move their nodes, resize, rename | ✅ | — |
| Nodes | Collapse to Function | ✅ (one exec way in and out, as in Unreal) | — |
| Nodes | Collapse to Macro | ✅ (several exec ways in and out) | — |
| Nodes | Inline default values on pins | ✅ | — |
| Nodes | Add-pin (+) on Sequence, MultiGate and Switch; remove a pin from its menu | ✅ (Sequence starts with 3 outputs, Unreal's with 2) | — |
| Nodes | Make Array/Set/Map, wildcard pins | ✅ | — |
| Nodes | Split struct pins (Split Struct Pin, Recombine Struct Pin) | ✅ | — |
| Nodes | Automatic conversion nodes | ✅ (bool/int/float → string via To String) | — |
| Visuals | Exec pins white arrows, data pins and wires colored by type | ✅ | — |
| Visuals | Title styles for event/function/pure/macro; compact variable getters | ✅ | — |
| Panels | Details panel (node details, variable settings) | ✅ | — |
| Panels | My Blueprint panel: graphs, functions, macros, variables, local variables, event dispatchers | ✅ | — |
| Variables | Get/Set nodes bound to a variable | ✅ | — |
| Variables | Ctrl-drag → Get, Alt-drag → Set, drag onto a pin | ✅ | — |
| Variables | Promote pin to variable | ✅ | — |
| Variables | Container types (array/set/map), defaults edited in Details, Unreal's array/set/map functions | ✅ | — |
| Search | Find in Blueprint (Ctrl+F) / Find in All Blueprints (Ctrl+Shift+F) | ✅ | — |
| Palette | Favorites | ⬜ (per-user, needs settings storage) | later |
| Compile | Compile button, Compiler Results, error badges on nodes | ✅ | — |
| Compile | F7 compiles | ✅ | — |
| Structure | Functions: entry and return nodes, inputs and outputs, pure functions, local variables, recursion | ✅ | — |
| Structure | Function libraries, called from any graph in the same language | ✅ | — |
| Structure | Macros: tunnels with exec and data pins, expanded where used, macro libraries | ✅ | — |
| Structure | Flow-control library: For Loop (with Break), While Loop, Do Once, Do N, Gate, MultiGate, Flip Flop, Switch on Int/String | ✅ (MultiGate's Is Random later) | — |
| Structure | For Each Loop (with Break) | ✅ | — |
| Structure | Structs, enums, Make/Break, Set Members, Switch on Enum, the structure and enumeration editors | ✅ (sets and map keys of structs or enums later) | — |
| Structure | Object references: Construct, Self, Is Valid, Target pins on variables, functions, events and dispatchers | ✅ | — |
| Structure | Inheritance from class graphs: Parent Class, Override, Parent calls, virtual calls | ✅ (code classes as parents later) | — |
| Structure | Blueprint Interfaces (implemented in Class Settings, interface calls), Cast To class or interface | ✅ (pure Cast later) | — |
| Structure | Access (Public, Protected, Private) for variables and functions | ✅ | — |
| Structure | Entry points: Main with command-line arguments; framework packs' events; Test Case events with Assert nodes and Run Tests | ✅ (C# tests run through Run's project, not xUnit) | — |
| Structure | Custom events (Call), event dispatchers (Call, Bind, Unbind, Unbind all, Assign), on this object or another | ✅ | — |
| Structure | Latent actions: Delay, Retriggerable Delay | ✅ (more latent nodes with demand) | — |
| Interop | Project functions appear as nodes (`BlueprintCallable`, `BlueprintPure`, Category, DisplayName, Keywords) | ✅ (TypeScript, JavaScript, Python, C#, C++ headers, Rust, Java, Lua, GDScript, Ruby, PHP; Go and other languages through their language server) | — |
| Interop | Nodes keep their pins when code changes; Refresh Node, Refresh All Nodes | ✅ (plus Replace with … for renamed or moved functions) | — |
| Interop | Member functions with a Target pin, constructors, and BlueprintReadWrite / BlueprintReadOnly properties from code | ✅ (all twelve languages; code classes as parents of graph classes deferred) | — |
| Interop | Out parameters and several return values from code; latent (async) functions | ✅ (several outputs in every language but GDScript, which has none; async functions in TypeScript, JavaScript, Python, C# and Java, the languages with a standard future) | — |
| Interop | Function metadata: Compact Node Title, Deprecated, Advanced Display, pin display names, ExpandBoolAsExecs / ExpandEnumAsExecs | ✅ (graph functions and macros in Details; code through tags and each language's deprecation marker) | — |
| Interop | Double-click a node to open its definition (library graph, or code in the editor); Find References | ✅ (also F12 and Shift+F12; node files open at their type) | — |
| Library | Standard math, string, utility and file nodes, with containers' functions; more of Unreal's (Lerp, Map Range, trigonometry, string and set functions, array functions as new arrays) and everyday utilities (text, maps, time, encoding, UUIDs) | ✅ (array functions return new arrays where Unreal's change theirs) | — |
| Library | Plugins: node packages with versions and dependencies; a new major version marks the package's nodes for Refresh Node | ✅ (from the workspace and extensions, not a registry) | 6 |
| Library | Blueprint Function Libraries usable from graphs in each of several languages; plugins that carry library graphs | ✅ (a library is generated for each of its languages; packages carry graphs, added with Add Blueprint Package) | — |
| Languages | (Beyond Unreal's C++) Graphs compile to TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, Lua, GDScript, Ruby and PHP; other languages come as packs from extensions or as declarative definitions, checked by the published conformance suite | ✅ (Rust has no inheritance or interfaces, Go no inheritance) | 6, 8 |
| Languages | (Beyond Unreal) Workspaces with graphs in several languages: a new graph takes its folder's language, structs and enums can be shared between languages, and another language's code is reached through project functions | ✅ (generated cross-language bindings deferred) | 7 |
| Debugging | F9 breakpoints, Ctrl+Shift+F9 clears them; stepping | ✅ (Simulate, and generated TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, Lua, GDScript, Ruby, PHP and declarative packs' code) | — |
| Debugging | Pin value hover, Watch this value | ✅ (Simulate, and generated TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, Lua, GDScript, Ruby, PHP and declarative packs' code) | — |
| Debugging | Execution flow highlighting | ✅ (run trail and exec wire pulses, in Simulate) | — |
