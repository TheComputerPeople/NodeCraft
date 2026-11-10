# Codebase Map (Phase 12)

Phase 12 of the [roadmap](roadmap.md): the extension scans a project or a whole workspace and draws an interactive map of its structure and flow, from the whole codebase down to one function's body, flowing **top to bottom**. Asked for on 2026-11-09, before Phase 11 was merged.

The user chose:

- **All four views**, as levels to drill through: the architecture (projects, modules, files and their dependencies), the code structure (types, inheritance, members), the call flow (from entry points down through what calls what), and the control flow inside one function.
- **Explore, with bridges into Blueprint.** The map is read-only: it pans, zooms, expands, searches, filters and opens the code. From it, a function can be exposed as a node and a graph's box opens its graph. Editing code through the map isn't part of it: "converting code back into graphs" stays a [non-goal](roadmap.md#non-goals), and the map is a view of the code, never a `.vgraph`.
- **Vertical in the map only.** The map flows top to bottom; Blueprint graphs stay left to right, as in Unreal.
- **Order:** Phase 11 and the graph tabs were merged into `main` first. This phase comes before code classes as parents (now Phase 13); Release is Phase 14.

Unreal has no equivalent for code. Its closest tools are the Reference Viewer (an asset's dependencies, as a graph) and Size Map. The map is beyond Unreal parity, like project integration.

A "Built" section after each design says what each step built.

## Decisions to confirm before step 2

Two choices add the extension's first runtime dependencies. They're recommended here, and the alternatives are below each.

1. **Parsing: tree-sitter** (`web-tree-sitter`, WebAssembly, MIT), with a grammar for each language: TypeScript and TSX, JavaScript, Python, C#, C, C++, Rust, Java, Go, Lua, GDScript, Ruby and PHP.
   - **Why:** the control-flow view needs each function's body as a syntax tree, in every language. The scanners read declarations with patterns, and language servers give symbols and (some of them) call hierarchies, but no server gives control flow. One parser for all 12 languages also gives imports and calls uniformly, works without any language extension installed, and works in Restricted Mode, because parsing runs nothing from the project.
   - **Cost:** the grammars' `.wasm` files add an estimated 10 to 25 MB to the extension. Step 2 measures it and checks that a maintained grammar exists for each language (GDScript's is a community grammar).
   - **Alternatives:**
     - **Language servers only.** Call hierarchies exist for most languages but not all (Lua, GDScript, Ruby and PHP vary by extension). There's no control flow, and every user needs every language's extension.
     - **Hand-written parsers** in the scanners' style, for 12 languages. This is far more work and less accurate.
2. **Layout: ELK** (`elkjs`, EPL-2.0), its layered algorithm with direction `DOWN`, run in a web worker.
   - **Why:** the map nests boxes (a project holds modules, which hold files, which hold types, which hold functions), and wires cross those levels. ELK lays out nested graphs with edges between levels, which a vertical map of a codebase needs.
   - **License:** EPL-2.0 is a weak, file-level copyleft. Shipping it unmodified needs a notice in THIRD_PARTY_NOTICES.md.
   - **Alternatives:**
     - **dagre** (MIT): smaller, but it can't route edges between nested boxes well.
     - **Our own layered layout:** a long project of its own.

Everything else follows from the user's choices.

## Today

What the map can build on:

- **Declaration scanners in all 12 languages** (`src/core/importing/*-scanner.ts`): functions, classes, members, properties and doc comments, with lines. For other languages, Tier 2 import reads the language server's document symbols ([language-breadth.md](language-breadth.md)).
- **The project model** (`src/extension/projects.ts`, Phase 11): each project in the workspace, its build system, its workspace (npm, pnpm, Cargo, Go, Maven, Gradle, CMake, .NET) and its source roots, plus `scanLimit` for large codebases.
- **Placement's module rules** ([output-placement.md](output-placement.md)), which already know how each language names and finds a module. Examples are TypeScript's import extensions, Python's packages and src layouts, Java's packages, Go's modules, Rust's crates, PHP's PSR-4 namespaces and Lua's require root. Import resolution reuses them.
- **Graph files** know what they call: a project function node names its file and function (`fn:<language>:<path>#<name>`), and generated code names its graph.
- **The webview:** pan and zoom, a canvas, panels, Find, and the graph tabs with Back and Forward.

What's missing:

1. Nothing reads function bodies, imports, or calls.
2. Nothing lays a graph out automatically: Blueprint graphs are placed by hand.
3. The editor draws every node as DOM. A whole codebase has tens of thousands of functions, which needs aggregation and level of detail, not one box per symbol.

## Part 1: the code index

One index of the workspace, in the extension host, that every view reads.

- **Entities,** nested:
  - workspace folder;
  - project (from the project model);
  - module (a package, namespace, crate or folder, in each language's own sense);
  - file;
  - type (class, interface, struct, enum or trait);
  - function, method or property.

  Graph files (`.vgraph`) and their event graphs, functions and macros are entities too.
- **Relations:**
  - **contains:** the nesting above;
  - **imports:** file to file, resolved through each language's module rules, and outside the workspace to a named package that the map shows as one box;
  - **inherits and implements:** type to type;
  - **calls:** function to function;
  - **graph and code:** a graph's nodes call project functions, and the graph's generated file belongs to its graph.
- **Generated files are hidden behind their graphs.** A generated file is shown as its graph. Its calls and imports are the graph's, and its box opens the graph.
- **Entry points** are marked:
  - `main` in each language;
  - `package.json` `bin` and `scripts` targets;
  - test functions;
  - Godot's `_ready` and `_process`;
  - a graph's Start, Tick and custom events;
  - anything the user marks as an entry point.

  Framework handlers (routes, controllers, commands) are found by their decorators and attributes where a language has them. Where it doesn't, they're found from what is never called inside the workspace but is exported.
- **Scale:**
  - Files are parsed in a worker, cached in workspace storage by content hash, and re-parsed only when they change.
  - The `scanLimit` setting and `files.exclude` apply, and generated build folders (the corpus's list) are skipped.
  - Huge files are indexed by their declarations only.
- **Restricted Mode:** the index only parses files, so it works in untrusted workspaces.

## Part 2: imports, calls and control flow

Each language has one **rules module**: a table from its tree-sitter node types to the index's concepts. This is the same idea as a language pack, kept small and testable.

- **Imports:** the import, `require`, `use`, `include`, `using` and `preload` forms, resolved to files through the module rules. A dynamic import whose target is a computed string is shown as unresolved.
- **Calls:** each call's callee name and receiver, resolved in this order:
  1. a local or imported function by name;
  2. a method through the receiver's declared type, or `self`/`this`;
  3. through inheritance.

  A call that stays ambiguous (dynamic dispatch, a callback, reflection) is drawn dashed to every candidate, or as "?" when there isn't one. When the language's server is installed, its definition provider resolves such a call when its box is opened. The map never runs the code: calls are static and approximate, and the map says so in its legend.
- **Control flow:** a shared builder turns a function's body into a flowchart, with each language's rules saying which nodes are what:
  - statement blocks;
  - decisions (if, switch or match, the ternary operator);
  - loops, with their back edge;
  - break, continue, return and throw;
  - try, catch and finally;
  - `await` and `yield`;
  - calls, which open their callee's flowchart.

  Expressions with their own flow (short-circuit operators, comprehensions) stay inside one box, which shows their code.

## Part 3: the views

One webview panel, the **Codebase Map**, with four levels. You drill down by expanding a box, and step back up with Back. The map reuses the graph editor's tabs and Back and Forward.

1. **Architecture.** Projects, modules and files as nested boxes, with their import edges aggregated: a collapsed box shows one edge per neighbour, weighted by how many imports it carries. Layers run top to bottom, from entry points and applications down to libraries and external packages. Cycles are marked.
2. **Structure.** A module or file opens to its types and functions. Inheritance runs downward from parents to children, and members are listed in each type's box. Graph classes sit beside code classes, with their parents.
3. **Call flow.** From an entry point, or any function, the calls it makes run downward, a few levels at a time. Expanding a call goes further. Recursion is a back edge, and calls into graphs and out of them cross the language boundary in one picture. "Callers" turns the view upside down: everything that reaches a function, from above.
4. **Control flow.** One function's flowchart, top to bottom. Decisions branch, loops return upward on the left, and a call box opens the callee's flowchart in a new tab.

Across all four:

- **Vertical layered layout** (ELK, direction down), computed in a worker. Expanding a box lays out only what changed, so the rest doesn't jump.
- **Level of detail:** boxes are aggregated beyond a visible limit (measured in step 6, starting at about 1,500 boxes). Zoomed out, a box shows its name and size. Zoomed in, it shows members, signatures and code.
- **Interaction:**
  - pan and zoom as in the graph editor;
  - expand and collapse;
  - Find (Ctrl+F) over the whole index;
  - filters by project, language and kind;
  - **focus** on a box's callers and callees N levels away;
  - **path** between two boxes;
  - a breadcrumb and Back and Forward;
  - a minimap;
  - hovering shows the signature and doc comment;
  - a click opens the code at its line, or peeks it.
- **Bridges into Blueprint:**
  - **Expose as Node** on a function, the same command as the Explorer's (Phase 11);
  - **Open Graph** on a graph's box;
  - **Show in Codebase Map** from the graph editor, the Explorer (a folder or file) and the code editor (a function: its call flow or its control flow).
- **Accessibility:** the same index in a VS Code tree view (Codebase Map: Structure), so everything on the map can be reached by keyboard and screen reader. The map's boxes are keyboard-focusable, and arrow keys follow edges.

## Exit check

- **The corpus** (Phase 11's 28 layouts in 12 languages, test/fixtures/projects):
  - Each layout's architecture view shows its projects, modules and the imports between them, matching a hand-written expected list.
  - Each layout's call flow from its entry point reaches its graphs and the project functions they call.
  - The control flow of one fixture function per language matches its expected flowchart, which has a branch, a loop with a break, a try/catch where the language has one, and an early return.
- **Layout:** in every view, every edge points down except loops' and recursion's back edges, and boxes don't overlap.
- **Scale:** this repository and the largest corpus layout are mapped within a time budget (set in step 3) on a cold cache, and a changed file updates the map in under a second.
- **Bridges:** Expose as Node from the map makes a node; Open Graph opens the graph; Show in Codebase Map from a function in the code editor opens its call flow.
- **Restricted Mode:** the map works in an untrusted workspace.

## Steps

1. This design, the roadmap entry and the decisions above.
2. The parser foundation: `web-tree-sitter` and the 13 grammars loaded in a worker, their size measured, and their notices added.
3. The code index: entities, imports with resolution through the module rules, containment, graph files, the cache and incremental updates, entry points.
4. Calls and inheritance: call extraction and resolution, ambiguous and unresolved calls, and the language server's definition for one call on request.
5. Control flow: the shared builder and the 12 languages' rules, with golden flowcharts.
6. The map's shell: the Codebase Map panel, ELK in a worker, rendering with level of detail, pan, zoom, expand and collapse, and opening the code.
7. Architecture and structure views.
8. Call flow, with callers.
9. Control flow.
10. Interaction: Find, filters, focus, path, breadcrumb, minimap, the Explorer, editor and graph editor commands, the Blueprint bridges, and the accessible tree view.
11. The exit check, docs, the parity checklist and status.

## Not in this phase

- **Editing code from the map,** including renaming or moving. That stays a non-goal.
- **Runtime tracing:** the call flow a run actually took, for example from the debugger. The map is static; the graph editor's debugger already shows a graph's own run.
- **Exporting the map** as an image or a document.
- **Metrics overlays** (size, complexity, churn from git) beyond a box's count of what it holds.
