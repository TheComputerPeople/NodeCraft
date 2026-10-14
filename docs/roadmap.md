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

Goal: the equivalent of `BlueprintCallable`. The user's existing code shows up in the palette.

- Tier 1 packs import precisely (TypeScript compiler API, Python `ast`/type hints, Roslyn for C#).
- Tier 2 import through any language server: workspace/document symbols plus signature information, with types parsed into canonical or native types.
- **Explicit exposure**, as in Unreal: a lightweight marker (decorator, attribute, annotation or doc-comment tag, depending on the language) selects what becomes a node, so the palette isn't flooded. An "expose everything" setting covers small projects.
- Generated code imports what it uses; renaming or deleting a function in code flags the affected nodes.
- The standard library of each language is available as curated node packs (math, strings, collections, file and console I/O).

Exit: in a TypeScript and a Python project, a function written by hand appears as a node, can be called from a graph, and refactors are detected.

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

### Phase 5: Debugging

Goal: Blueprint debugging, powered by each language's real debugger.

- F9 toggles a breakpoint on a node. The source map turns it into a breakpoint in the generated code, set through DAP.
- When execution stops, the editor highlights the current node and the path that led to it; F10/F11 step over and step into (including into function graphs).
- Hovering a pin shows its live value (via DAP `evaluate`); **Watch this value** pins a value to the node.
- Animated pulses along exec wires during execution.
- The call stack is shown in graph terms (graph and node names, not generated line numbers).
- Simulate mode supports the same breakpoints and stepping without a toolchain.

Exit: the debugging loop works in TypeScript, Python and C# without the user ever opening a generated file.

### Phase 6: Language breadth

Goal: support for most languages without a hand-written adapter for each.

- Declarative language pack format (templates plus a type map plus capabilities) for Tier 2 and Tier 3.
- Tier 1 packs beyond the first three, prioritized by demand. Candidates and their design implications are in [language-notes.md](language-notes.md): C++ first (closest to Unreal), then Rust and Java; C as a declarative Tier 2/3 pack. Go and others to be assessed the same way.
- A public extension API so language packs and framework packs can ship as separate VS Code extensions.
- Library versioning and dependency manifests for node libraries (building on `node-package.schema.json`).
- The conformance suite is published, so pack authors can verify their adapter.

Exit: a new language pack, written as a separate extension using only the public API, passes the conformance suite.

### Phase 7: Multi-language projects

Goal: identify where multi-language workspaces break, then decide which gaps to close. This phase is analysis first, by design.

What already works: each graph targets one language, so a workspace with TypeScript graphs in one folder and Python graphs in another needs nothing new. Node libraries can already carry implementations for several languages (the `languages` map on code nodes).

Known gaps to evaluate:

- **Cross-language calls** from a graph in one language to code in another. Candidate approaches: process boundaries (CLI/HTTP/gRPC nodes generated from a shared interface), C ABI/FFI bindings, WebAssembly components.
- **Shared types** between languages (structs/enums defined once and generated per language).
- **Polyglot node libraries**: rules for when a node is available in a graph whose language its library doesn't implement.
- **Project-level settings** when folders disagree about the target language.

Exit: a written gap analysis with a recommendation per gap, then a decision on which to build.

### Phase 8: Release

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
| Nodes | Hold-key + click placement: D, G, F, M, N, O (need Phase 4 nodes) | ⬜ | 4 |
| Nodes | Cut/copy/paste (also between graphs and files, as text), Ctrl+D duplicate | ✅ | — |
| Nodes | Arrow keys move the selection; F2 renames comments, variables and graphs | ✅ | — |
| Nodes | C wraps the selection in a comment; comments move their nodes, resize, rename | ✅ | — |
| Nodes | Collapse to function/macro | ⬜ | 4 (needs callable functions) |
| Nodes | Inline default values on pins | ✅ | — |
| Nodes | Add-pin (+) on Sequence; remove a pin from its menu | ✅ (Sequence starts with 3 outputs, Unreal's with 2) | — |
| Nodes | Make Array, wildcard pins, split struct pins | ⬜ | 4 (needs container and struct operations) |
| Nodes | Automatic conversion nodes | ✅ (bool/int/float → string via To String) | — |
| Visuals | Exec pins white arrows, data pins and wires colored by type | ✅ | — |
| Visuals | Title styles for event/function/pure/macro; compact variable getters | ✅ | — |
| Panels | Details panel (node details, variable settings) | ✅ | — |
| Panels | My Blueprint panel: graphs, functions, macros, variables | ✅ (event dispatchers and local variables need Phase 4) | — |
| Variables | Get/Set nodes bound to a variable | ✅ | — |
| Variables | Ctrl-drag → Get, Alt-drag → Set, drag onto a pin | ✅ | — |
| Variables | Promote pin to variable | ✅ | — |
| Variables | Container types (array/set/map) | 🟡 (type picker; container defaults and operations need Phase 4) | 4 |
| Search | Find in Blueprint (Ctrl+F) / Find in All Blueprints (Ctrl+Shift+F) | ✅ | — |
| Palette | Favorites | ⬜ (per-user, needs settings storage) | later |
| Compile | Compile button, Compiler Results, error badges on nodes | ✅ | — |
| Compile | F7 compiles | ✅ | — |
| Structure | Functions, macros, local variables | ⬜ | 4 |
| Structure | Flow-control library (loops, Do Once, Gate, …) | 🟡 (Branch, Sequence) | 4 |
| Structure | Structs, enums, Make/Break | ⬜ | 4 |
| Structure | Classes, inheritance, interfaces, Cast To | ⬜ | 4 |
| Structure | Event dispatchers, custom events | ⬜ | 4 |
| Structure | Latent actions (Delay) | ⬜ | 4 |
| Interop | Native functions appear as nodes (`BlueprintCallable`) | 🟡 (hand-written `*.node.json`) | 3 |
| Debugging | F9 breakpoints, Ctrl+Shift+F9 clears them; stepping | ⬜ | 5 |
| Debugging | Pin value hover, Watch this value | ⬜ | 5 |
| Debugging | Execution flow highlighting | 🟡 (run trail) | 5 |
