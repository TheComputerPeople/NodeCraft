# Codebase Map (Phase 12)

Phase 12 of the [roadmap](roadmap.md): the extension scans a project or a whole workspace and draws an interactive map of its structure and flow, from the whole codebase down to one function's body, flowing **top to bottom**. Asked for on 2026-11-09, before Phase 11 was merged.

The user chose:

- **All four views**, as levels to drill through: the architecture (projects, modules, files and their dependencies), the code structure (types, inheritance, members), the call flow (from entry points down through what calls what), and the control flow inside one function.
- **Explore, with bridges into Blueprint.** The map is read-only: it pans, zooms, expands, searches, filters and opens the code. From it, a function can be exposed as a node and a graph's box opens its graph. Editing code through the map isn't part of it: "converting code back into graphs" stays a [non-goal](roadmap.md#non-goals), and the map is a view of the code, never a `.vgraph`.
- **Vertical in the map only.** The map flows top to bottom; Blueprint graphs stay left to right, as in Unreal.
- **Order:** Phase 11 and the graph tabs were merged into `main` first. This phase comes before code classes as parents (now Phase 13); Release is Phase 14.

Unreal has no equivalent for code. Its closest tools are the Reference Viewer (an asset's dependencies, as a graph) and Size Map. The map is beyond Unreal parity, like project integration.

A "Built" section after each design says what each step built.

## Decisions: the parser and the layout

Two choices add the extension's first runtime dependencies. The user confirmed both on 2026-11-09 ("Continue", after they were put to them), as recommended here; the alternatives are kept below each.

1. **Parsing: tree-sitter** (`web-tree-sitter`, WebAssembly, MIT), with a grammar for each language: TypeScript and TSX, JavaScript, Python, C#, C, C++, Rust, Java, Go, Lua, GDScript, Ruby and PHP.
   - **Why:** the control-flow view needs each function's body as a syntax tree, in every language. The scanners read declarations with patterns, and language servers give symbols and (some of them) call hierarchies, but no server gives control flow. One parser for all 12 languages also gives imports and calls uniformly, works without any language extension installed, and works in Restricted Mode, because parsing runs nothing from the project.
   - **Cost:** the grammars' `.wasm` files add an estimated 10 to 25 MB to the extension. Step 2 measures it and checks that a maintained grammar exists for each language (GDScript's is a community grammar). (Measured: 17.5 MB; see "Built (step 2)".)
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
- **Scale:** this repository and the largest corpus layout are indexed in under 5 seconds on a cold cache, and a changed file updates the index in under a second. (Measured in step 3: this repository's 409 files in 1.1 s cold and 0.14 s warm; the largest corpus layout's 88 files in 0.3 s.)
- **Bridges:** Expose as Node from the map makes a node; Open Graph opens the graph; Show in Codebase Map from a function in the code editor opens its call flow.
- **Restricted Mode:** the map works in an untrusted workspace.

## Steps

1. This design, the roadmap entry and the decisions above.
2. The parser foundation: `web-tree-sitter` and the 13 grammars loaded in a worker, their size measured, and their notices added.

### Built (step 2)

- **The grammars** are built by `npm run build:grammars` (scripts/build-grammars.js) into `grammars/`, one `.wasm` per grammar, and committed. The 14 grammars are 13 languages plus TSX.
  - **How they're built:** the script fetches each grammar's npm package with `npm pack`, so no install script runs, and compiles its generated parser with tree-sitter CLI 0.27.1.
  - **Why commit them:** only changing a grammar needs the build. The CLI must match the runtime, web-tree-sitter 0.27.1, so the two share one ABI; the script refuses a mismatch. The CLI also fetches wasi-sdk, about 600 MB, into its own cache the first time.
  - **Versions:** the newest release of each grammar package at least two weeks old. Those are tree-sitter-typescript 0.23.2 (TypeScript and TSX), -javascript 0.25.0, -python 0.25.0, -c-sharp 0.23.5, -c 0.24.1, -cpp 0.23.4, -rust 0.24.0, -java 0.23.5, -go 0.25.0, @tree-sitter-grammars/tree-sitter-lua 0.4.1, tree-sitter-gdscript 6.1.0, tree-sitter-ruby 0.23.1 and tree-sitter-php 0.24.2. All are MIT-licensed.
  - **No single prebuilt set would do:** neither VS Code's own `@vscode/tree-sitter-wasm` nor `tree-sitter-wasms` has all 13 languages, and GDScript's package ships no `.wasm`.
  - **The manifest:** `grammars/grammars.json` records each grammar's package, version, CLI, license, size and SHA-256.
  - **The notices:** the script writes the licenses into THIRD_PARTY_NOTICES.md, between markers.
- **Size:** 17.5 MB in all, plus web-tree-sitter's own 0.2 MB.
  - C# is 5.3 MB, C++ 3.4 MB and Ruby 2.1 MB.
  - TypeScript and TSX are 1.4 MB each, Rust 1.1 MB and PHP 1.1 MB.
  - C, Python, Java and JavaScript are 0.4 to 0.6 MB each, and GDScript, Go and Lua under 0.3 MB.
- **The parser** is `src/extension/code-parser.ts`. It loads each grammar the first time a file needs it and summarizes a parse: its node count and its first syntax errors, with lines. It's in the extension, not in core, because core imports no packages. The table of which grammar parses which file is in core (`src/core/parsing/grammars.ts`); `.h` headers are parsed as C++.
- **The worker:** `src/extension/parse-service.ts` runs the parser in a worker thread (`parse-worker.ts`), with no vscode API, as Simulate's session does. Trees stay in the worker, and only plain data comes back.
- **Tested** (test/unit/parsing.test.ts):
  - each grammar on a snippet of its language;
  - the committed `.wasm` files against the manifest and the notices;
  - without a single syntax error: all 105 source files of the 28 corpus layouts, every fixture's generated code in all 12 languages (over 300 files), and this repository's own 283 source files.
  - One parser handles about 3.7 MB/s here: the repository's 3.4 MB parse in 0.9 s, loading the grammars included.
- **A grammar bug found:** tree-sitter-typescript 0.23.2, its latest release, takes a member named `abstract` for the modifier. The test lists such bugs with an example that must keep failing, so a fixed grammar is noticed. tree-sitter's error recovery keeps the rest of such a file readable; step 3 has to rely on that.
- **Packaging:** the extension's `dependencies` are web-tree-sitter only; ELK arrives with step 6.
3. The code index: entities, imports with resolution through the module rules, containment, graph files, the cache and incremental updates, entry points.

### Built (step 3)

- **What each file declares and imports** (`src/core/codemap/facts.ts`) comes from a tree-sitter query per grammar, kept in core as text.
  - The worker runs the query and sends back the matches as plain data. A pure function reads them per language into the file's facts: its declarations (with their containers and lines), its imports as written, the package or namespace it declares, and its entry points.
  - Declarations nest by their ranges. A C++ `A::f` defined outside its class, a Go method's receiver, a Rust `impl` block and Lua's `M.f` and `M:f` all put the function in its type or table.
  - Statements with structure of their own are read from their text: Rust's use trees, PHP's group uses, Java's static imports and Python's `from . import a, b`. Rust's `#[path]` attaches to the `mod` after it.
- **The index** (`src/core/codemap/code-index.ts`) is pure and built from the facts, the graph files and the projects.
  - **Structure:** projects (from Phase 11's project model, the deepest first, plus one for code outside them all), then their folders as modules, then files, then types and functions, each with a stable id. Parents always come before their children.
  - **Graph files** stand in for their generated code. A generated file (found by its header) is shown as its graph, and its imports become the graph's, so a graph imports the code and graphs it uses. The languages' support files (`vgraph_runtime.*`) are hidden. A graph's project-function nodes count as imports too, before it's compiled.
- **Imports resolve per language:**
  - **TypeScript and JavaScript:** relative paths with extensions, index files and `.js` written for `.ts`, and a monorepo's packages by name.
  - **Python:** relative imports by level, and absolute ones from the project, `src/`, the project's parent and a script's own folder, including submodules imported by name.
  - **C#, Java and PHP:** namespaces, packages and types, to the files declaring them.
  - **C and C++:** includes relative to the file, else the nearest file ending with that path.
  - **Rust:** `mod` (and `#[path]`), `crate::`, `self::` and `super::` paths, and a workspace crate by name.
  - **Go:** packages by `go.mod`'s module path.
  - **Lua:** `require` from the usual roots.
  - **Ruby:** `require_relative`, and `require` from `lib/`.
  - **GDScript:** `res://` paths.
- **Outside the workspace:**
  - **External packages** are one entity per package and ecosystem; a TypeScript and a JavaScript file import the same npm package.
  - **Left out,** because they aren't packages: standard libraries (Python's, Node's built-ins, Ruby's, Go's and Rust's, C and C++ headers, `System.*`, `java.*`) and imports of data and assets (JSON, styles, images).
  - **Unresolved:** a relative import that finds nothing is recorded as unresolved.
- **Entry points:**
  - functions: `main` (Go's only in package `main`, Python's only when the file runs it), tests by each language's convention, Godot's callbacks;
  - whole files: a Python file with a `__main__` block, C#'s top-level statements, the files a `package.json` names in `bin`, `main` and its scripts (`node src/server.js`), the module `index.html` loads, and Lua, Ruby and PHP programs in `bin/`, `exe/` or `scripts/` or at a project's top;
  - graphs: Start and Main events, and test cases.

  Framework handlers (routes, controllers) need calls, and move to step 4.
- **The indexer** (`src/extension/code-indexer.ts`, vscode-free) walks a folder.
  - **Folders skipped:** dependencies, plus `bin/`, `obj/`, `build/`, `target/` and `x64/` only beside their build's project file. A Node or Lua project's `bin/` holds its programs.
  - **Reading files:** each file is read by the worker. Results are cached by content hash, in a cache that's discarded when the queries or grammars change. Files over 1 MB are indexed by name.
  - **Settings:** it follows `scanLimit` and `files.exclude`.
- **The service** (`src/extension/code-map-service.ts`) keeps each workspace folder's index in the extension, cached in workspace storage.
  - Nothing is parsed until something asks for an index.
  - After that, file changes rebuild it (reading only what changed) and fire an event.
  - It works in Restricted Mode.
- **Tested:**
  - **Facts:** each language's from a snippet, plus Rust's and PHP's import forms.
  - **The index's rules:** projects and modules, generated code shown as graphs, resolution in every language, standard libraries, externals, entry points and nesting.
  - **The corpus:** each of the 28 layouts, with its graphs compiled in, has no unresolved imports, shows no generated file as a file, and has its expected entry points and imports. Those include the entry file to its graphs, the graphs to the code they call, and the imports between a monorepo's packages, a Cargo workspace's crates, Gradle's modules and Go's workspace.
  - **The cache:** only a changed file is parsed again.
  - **The limit** leaves files out and counts them.
  - **Integration:** the service indexes the integration workspace inside VS Code and follows a new file.
4. Calls and inheritance: call extraction and resolution, ambiguous and unresolved calls, and the language server's definition for one call on request.

### Built (step 4)

- **Facts** add each file's call sites, its types' bases and its declarations' decorators, from more of each grammar's query.
  - **Call sites:** a call records its callee, its receiver as written and the declaration it's in. Its position is the callee's name, which is where a language server finds the definition.
  - **Receivers:** `this`, `self`, `$this`, `@` and `Self` are read as *self*; `super`, `base` and `parent` as *super*. A new object's method is its type's: `new A().f()`, `A().f()`, `A::new().f()`, `A.new.f`. An expression too complex to read is `?`.
  - **Rust's macros:** calls inside them (`println!("{}", m::f())`) are read from the macro's tokens, which tree-sitter doesn't parse.
  - **Import names:** an import records the name it binds, as in `import G from`, `const r = require()`, `local m = require()`, `import a.b as x` and `const G = preload()`.
  - **Decorators** go with the declaration they head. In Python, TypeScript and Rust that's the declaration after them; in Java, C# and PHP they're part of it.
- **Framework handlers** are entry points:
  - functions decorated as routes, commands, tasks, listeners or jobs (`@app.route`, `@GetMapping`, `[HttpGet]`, `#[get]`, `#[Route]`, `@Get()`, `@click.command`, `@shared_task` and the like);
  - the methods of controllers and class-based views (`ApplicationController`, `Controller`, `ControllerBase`, `APIView`, `View`, …) and of classes marked `[ApiController]` or `@RestController`;
  - `#[tokio::main]` functions, as `main`.

  A function that's merely exported and never called isn't marked: in a library, that would be most of its API.
- **Resolution** (`src/core/codemap/calls.ts`) is static, as decided:
  - **`self` and `super`:** the caller's type and its bases, transitively.
  - **A plain call:** the type's own method in languages where `this` is implicit (Java, C#, C++, Ruby, GDScript). Otherwise a free function in the file, then in what it sees: the files it imports, its package (Go's folder, Java's package, C#'s and PHP's namespace) and the sources of the C and C++ headers it includes.
  - **A call on a name:** the module an import bound to it, a type's static methods, or a module's or table's functions (a Python module, Go's package, Lua's table).
  - **Anything else:** each same-named method in sight.
  - **Certainty:** a call with one answer is certain. One with up to five is drawn to each, uncertain. One with more is recorded as unresolved, with its count. A name the workspace never declares belongs to a library, and isn't recorded at all.
- **Graphs:**
  - A graph's calls come from its nodes: its functions and macros, library graphs, and project functions. A function a C or C++ header only declares resolves to the source that defines it.
  - Its generated code adds only the certain calls out of the graph that its nodes don't already give, such as a class member's node.
  - Support code that several generated files each carry (C++'s headers do) isn't shown, and calls into it aren't either.
- **Inheritance** resolves bases to the workspace's types, a GDScript file's class by its `class_name`, or keeps a library's base by its name. A generated class's bases count only when they're the workspace's: a graph class's parent, not the runtime's `Object`.
- **The language server, on request:** `definitionAt` asks the file's language server for one call's definition, and maps the answer to its entity (generated code to its graph). Some servers know only open files: TypeScript's, for a file in no `tsconfig`, resolved nothing until the imported file was open. So when a server has no answer, the files this file imports are opened, and it's asked again.
- **Tested:**
  - **Facts:** each language's calls, bases, decorators and handlers from a snippet, and the callee's position.
  - **Resolution rules:** `self` and `super` through bases, implicit `this`, imports and import names, types and modules, guesses and the unresolved limit, graphs' nodes and their generated code, support code, inheritance, and the entity at a line.
  - **The corpus:** in all 28 layouts, the entry point calls its graphs and the graphs call the code they use, all certain, across every language's module system. That includes a C++ graph calling a definition in another folder's `.cpp`, Rust through `println!`, and Lua, JavaScript and GDScript through import names. The workspace's own inheritance is found in six languages.
  - **Integration:** inside VS Code, a guessed call (a method on a variable) is resolved by TypeScript's server to the exact method.
- **Scale:** this repository's index, with about 15,000 calls (6,800 certain) and 1,000 left unresolved, takes 1.4 s cold and 0.22 s warm, with a 3.3 MB cache.
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
