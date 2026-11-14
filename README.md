# NodeCraft

NodeCraft brings Unreal Blueprint-style visual scripting to VS Code. Build node graphs that compile to readable code in 12 languages (TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, Lua, GDScript, Ruby and PHP), then run, test and debug them node by node with each language's own tools. Your own functions become nodes.

Generated code is committed next to each graph, so the project builds without the extension. NodeCraft is not affiliated with or endorsed by Epic Games; Unreal Engine and Blueprint are Epic's trademarks, named here only to describe what the editor follows.

## Where to start

VS Code's **Welcome** page has a walkthrough, **Get Started with NodeCraft** (Command Palette: **Welcome: Open Walkthrough...**), that goes through the steps below one at a time.

- **Getting it:** install **NodeCraft** from the Visual Studio Marketplace (in VS Code's Extensions view, search for NodeCraft), or [run it from source](#run-it-from-source).
- **A new project:** run **NodeCraft: New Project...** from the Command Palette, pick a language and start from the Tour ([Graphs in your project](#graphs-in-your-project)).
- **A codebase you have:** **NodeCraft: Set Up in This Project** says what graphs there need, and changes nothing until you apply it.
- **Coming from Unreal:** [docs/coming-from-unreal.md](docs/coming-from-unreal.md) (**NodeCraft: Coming from Unreal** opens it) maps each of Unreal's Blueprint concepts to its equivalent here, and says which don't apply. The gestures and shortcuts are Unreal's ([Editor interaction reference](#editor-interaction-reference)).
- **Running graphs:** [Run, Simulate and Debug](#run-simulate-and-debug) lists what each language needs.
- **Settings:** [Settings](#settings).
- **Working on the extension itself:** [Development](#development).

## What is included

- A `.vgraph` custom editor that looks and behaves like Unreal Engine's Blueprint editor: the same gestures, shortcuts, pin colors and node styles, so Blueprint users can start without relearning (see the reference below).
- **Blueprints**: a `.vgraph` file is a class, function library or macro library holding graphs, functions, macros and variables, managed in the **My Blueprint** panel and opened in **tabs** above the graph, with Back and Forward as in Unreal. Classes construct each other, inherit from each other or from a class in your code (with overrides and Parent calls), implement Blueprint Interfaces and Cast To them; custom events, event dispatchers and Delay work as in Unreal. sample/countdown is a small program built only in graphs that uses all of it. Functions and macros work as in Unreal, including Collapse to Function and Collapse to Macro, and the functions and macros of library files can be used from any graph in the library's languages (a function library can be generated for several), including through **Collapse to Function in Library**. **Structures** and **enumerations** are files too, edited in a field or value list, with Make, Break, Set Members and Switch on nodes.
- **Execution and data pins**, with Unreal's wiring rules, inline values for unconnected inputs, automatic **To String** conversion, reroute nodes, comment boxes, copy and paste, alignment tools and Find.
- **Your code as nodes**, the equivalent of Unreal's `BlueprintCallable` and `BlueprintReadWrite`: functions marked `@blueprint` in the project's code, in all twelve languages (C++: in headers; Go: through gopls), appear in the palette, and generated code imports them. So do classes' constructors, methods and properties (with Target pins), functions with several outputs, and async functions (as latent nodes). Nodes notice when the code changes, double-click (F12) opens the code, and the code shows warnings and **Expose** quick fixes (see below). sample/node-authoring uses all of it in TypeScript and Python.
- **In your language's terms**: the Language menu changes what the editor calls things (Python's Make List, `list[int]` and Dict; C#'s List, HashSet and Dictionary). Hovering a node in the palette or the Add Node menu shows its code in the language, and each language has its standard library's own nodes: regular expressions (Lua's patterns in Lua) and MD5, SHA-1 and SHA-256 hashes. An audit runs every node in every language against Simulate ([docs/language-context.md](docs/language-context.md)).
- Built-in Flow, Debug and Variable nodes (Start, Branch, Sequence, Print, Get and Set, To String, End), and Unreal's **standard library** of math, string, utility and file nodes, plus everyday utilities (case conversion, Slugify, Truncate, Format Bytes, strict parsing, Unique, Median, Pick, Normalize Path and more), with the same meaning in every language.
- Workspace `*.node.json` user node libraries, with a code snippet per language (example: `Double`), checked as you write them, with **New Node** to start one and **Test Node Library** to run their examples. **Packages**: a `*.vgraph-package.json` manifest gives node files and library graphs a name, a version and dependencies, and **Add Blueprint Package…** adds one from a folder, an extension or npm (an npm package with a `blueprint` field; see docs/node-authoring.md, gap 9). Graphs remember the version of each package they use, and a new major version marks its nodes for Refresh Node.
- **Code generation**: each graph compiles to readable source code in its target language, written next to the graph and meant to be committed. TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, Lua, GDScript (Godot 4), Ruby and PHP are supported (Rust without inheritance or interfaces, Go without inheritance). Other languages can be added as **language packs** from other extensions, or as declarative packs: a workspace `*.vgraph-language.json` file of templates, types and how to run the code (see [the pack SDK](packages/pack-sdk/README.md)). [examples/c-language-pack](examples/c-language-pack/README.md) adds C this way, as its own extension.
- Unreal-style **Compile** (F7) and **Compiler Results**, with error and warning badges on nodes and entries in the Problems panel.
- **Run** (the generated code, through the language's own toolchain) and **Simulate** (the editor's built-in interpreter). With breakpoints set (F9), Simulate pauses at them: step node by node, see the call stack in graph terms, hover a pin to see its value, or **Watch this value** from the pin's menu.
- **Tests**: Test Case events with Assert True and Assert Equal nodes. **Run Tests** runs them in the graph's language (with its own test tool where it has one: `node --test`, `unittest`), **Simulate Tests** in the editor.
- **Debug** (F5): runs the generated code under the language's own debugger (VS Code's built-in one for TypeScript and JavaScript, the Python Debugger extension for Python, the C# extension for C#, the C/C++ extension for C++, for Rust the C/C++ extension on Windows or CodeLLDB elsewhere, the Debugger for Java for Java, the Go extension (Delve) for Go, Lua Debug for Lua, godot-tools for GDScript in a Godot project, the VSCode rdbg Ruby Debugger for Ruby, and PHP Debug with Xdebug for PHP), stopping at the same node breakpoints, stepping node by node and showing pins' values, without opening the generated file.
- The **Codebase Map**: your whole workspace, code and graphs, drawn top to bottom in four views to drill through (architecture, structure, call flow, a function's control flow), with Expose as Node and Open Graph on its boxes (see below).
- Saving goes through VS Code's text document, so undo, redo, dirty state and source control work as usual.

## Run it from source

To work on the extension, or try changes before they're published:

1. Open this folder in VS Code and run `npm install`.
2. Press `F5` (or choose **Run NodeCraft Extension** in Run and Debug). An Extension Development Host opens the `sample` workspace.
3. Open `sample/demo.vgraph`.
4. Click **Compile**. The graph's target language is JavaScript, so `demo.vgraph.js` appears next to it. Pick another language in the toolbar to generate TypeScript (`demo.vgraph.ts`) or Python (`demo_vgraph.py`) instead. Saving the graph also compiles it (setting: `nodecraft.compileOnSave`).
   **New Graph** (Command Palette) starts a graph in the language of the project files nearest to where it's saved, so a repository with a TypeScript `web/` and a Python `api/` gets the right one in each; the `nodecraft.defaultLanguage` setting overrides that per folder. Structs and enums can be shared between those languages, and [examples/multi-language](examples/multi-language/README.md) shows a graph calling code in another language ([docs/multi-language.md](docs/multi-language.md)).
5. Click **▶ Run** to run the generated code with the language's toolchain (below), or **Simulate** to run the graph inside the editor. Output appears in the `NodeCraft` Output channel.

## Run, Simulate and Debug

**Simulate** runs a graph's built-in nodes inside the editor, in any language and in no toolchain; it can't run your own code. **Run**, **Run Tests** and **Debug** run the generated code with the language's toolchain, found on the PATH (the `nodecraft.runCommands` setting names another), and Debug with the language's VS Code debugger:

| Language | Run needs | Debug needs |
|---|---|---|
| TypeScript, JavaScript | Node.js 22.18 or later (it runs TypeScript directly) | VS Code's own JavaScript debugger |
| Python | Python 3.8 or later | the Python Debugger extension |
| C# | the .NET SDK, 8 or later | the C# extension |
| C++ | g++ or clang++, with C++20 | the C/C++ extension |
| Rust | Cargo | the C/C++ extension on Windows, CodeLLDB elsewhere |
| Java | a JDK, 17 or later | the Debugger for Java |
| Go | Go | the Go extension (Delve) |
| Lua | Lua 5.4 | Lua Debug |
| GDScript | Godot 4: its console executable as `godot`, or in the `GODOT` environment variable | godot-tools, with the graph in a Godot project |
| Ruby | Ruby 3.3 or later | the VSCode rdbg Ruby Debugger (the debug gem) |
| PHP | PHP 8.3 or later, with mbstring | PHP Debug, with Xdebug loaded in php.ini |

Languages that build first (C#, C++, Rust, Java, Go) build in a small project the extension keeps in the temporary folder, with your project's sources the graph uses. Run, Run Tests, Simulate and Debug need a trusted workspace; in Restricted Mode graphs can be edited and compiled, and the Codebase Map drawn.

How graphs behave when they run is specified in [docs/semantics.md](docs/semantics.md); every language's generated code is tested against it.

## Development

The TypeScript configuration includes the DOM library definitions because VS Code extension-host Node versions expose the standard `TextEncoder`/`TextDecoder` globals used for `.vgraph` file serialization. This does not add a browser runtime dependency.


| Command | What it does |
|---|---|
| `npm run compile` | Compiles the extension host with `tsc` and bundles the webview with esbuild into `dist/` |
| `npm run watch` / `npm run watch:webview` | Rebuild the extension host / the webview on change |
| `npm run check` | Type-checks the extension, the webview and the tests without emitting output |
| `npm test` | Runs every test: unit tests, then browser tests of the webview |
| `npm run test:unit` / `npm run test:webview` | Run one group |
| `npm run test:conformance` | Runs every fixture graph in Simulate and as generated TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, Lua, GDScript, Ruby and PHP, and checks they print the same output (part of `npm test`; needs Node.js 22.18+, Python 3, the .NET SDK, g++ or clang++, Cargo, a JDK, Go, Lua 5.4, Godot 4 as `godot` or in the `GODOT` environment variable, Ruby, and PHP with mbstring; missing tools skip their tests) |
| `npm run corpus:tools` | Installs the Node.js tools the corpus of project layouts runs (TypeScript 5, ESLint with typescript-eslint, Node.js's types) into a cache folder outside the repository, and downloads PHP's (Composer, PHPStan and PHP_CodeSniffer, each a `.phar`) into it; the other languages' tools (mypy, Pyright, Ruff, pnpm, dotnet, Maven, Gradle, cargo, go, staticcheck, CMake, make, RuboCop, luacheck, Godot as `GODOT` or `godot`) come from the PATH. The corpus (`test/conformance/corpus.test.ts`, part of `npm test`) copies each project in `test/fixtures/projects`, compiles graphs into it as Compile does, then runs the project's own build, checkers, tests and entry point. A missing tool skips its step; a layout with skipped steps is reported as todo, and `NODECRAFT_CORPUS_REQUIRE_TOOLS=1` makes it fail instead |
| `npm run test:integration` | Launches VS Code with the extension and runs smoke tests inside it, in the sample workspace, a multi-root workspace, and the sample again in Restricted Mode (not part of `npm test`) |
| `npm run test:integration:debuggers` | The same, with your installed VS Code extensions loaded, so debugging generated Python (Python Debugger extension), C# (C# extension), C++ and Rust (C/C++ extension), Java (Debugger for Java), Go (Go extension), Lua (Lua Debug), GDScript (godot-tools, with the `GODOT` environment variable set), Ruby (rdbg) and PHP (PHP Debug, with Xdebug in php.ini) is tested too |
| `npm run package` | Builds `nodecraft-<version>.vsix` with `vsce`, then checks it (`scripts/check-package.js`): every module its code needs and every file package.json points to is inside, and nothing only for development |
| `npm run test:package` | Installs the newest `.vsix` into a VS Code of its own and checks the installed extension activates, makes a project and opens the Codebase Map |
| `npm run build:sdk` / `npm run test:sdk` | Builds the language pack SDK (`packages/pack-sdk`, with the conformance suite and its `nodecraft-conformance` command) / and runs its command once |

The browser tests drive the real webview bundle in an installed Microsoft Edge or Google Chrome through `playwright-core` (no browser download). Set `NODECRAFT_TEST_BROWSER` to a Chromium executable to use a different one; without any browser those tests are skipped.

Source layout:

- `src/core/`: the graph model, serializer, node registry, reference runtime, graph-editing operations, the compiler and language packs, and the declaration scanners that read project functions (`src/core/importing/`). It must not import `vscode` or Node built-ins, so it can be shared with the webview and tested in plain Node (a unit test enforces this).
- `src/extension/`: VS Code integration (activation, the custom editor, compiling and running, workspace node libraries, project functions and function libraries, webview markup).
- `src/webview/`: the graph editor UI, written in TypeScript and bundled by esbuild. It has no runtime dependencies.
- `test/unit/`: unit tests for `src/core`.
- `test/webview/`: browser tests for the editor UI.
- `test/conformance/`: the conformance suite. Fixture graphs in `test/fixtures/graphs/` declare their expected output; golden files in `test/fixtures/codegen/` record generated code (`UPDATE_GOLDEN=1 npm run test:unit` rewrites them).
- `test/integration/`: tests that run inside a real VS Code.

The integration tests download the minimum supported VS Code version (from `engines.vscode`) into `.vscode-test/` on first run, and open a VS Code window while they run. They work from a VS Code terminal too: the launcher clears `ELECTRON_RUN_AS_NODE`, which VS Code sets for its child processes.

## Your code as nodes

As Unreal exposes C++ functions marked `UFUNCTION(BlueprintCallable)`, the extension exposes functions whose documentation comment contains `@blueprint`:

```ts
/**
 * Subtracts an amount from a value, never going below zero.
 * @blueprint
 * @category Math
 */
export function subtractToZero(value: number, amount = 10): number {
  return Math.max(0, value - amount);
}
```

```python
def is_positive(value: float) -> bool:
    """@blueprint pure"""
    return value > 0
```

```csharp
public static class Rates
{
    /// <summary>A rate that grows with each step.</summary>
    /// @blueprint pure
    public static double RateAt(int step) => 0.1 + step * 0.01;
}
```

```cpp
// shapes.h
namespace shapes {
/// @blueprint pure
double area(double width, double height);
}
```

- `@blueprint` makes a node with exec pins (`BlueprintCallable`); `@blueprint pure` makes one without (`BlueprintPure`). `@category`, `@displayName`, `@keywords`, `@compactTitle`, `@deprecated` (or the language's own marker, such as `[Obsolete]`), `@advanced`, `@pinName` and `@execs` work as Unreal's metadata does. Parameters become input pins (literal defaults become pin values) and the return value becomes **Return Value**.
- A class's marked constructor, methods and properties become **Construct**, method nodes with a **Target** pin, and **Get** and **Set** nodes. Out parameters, tuples and records give several outputs, and an async function is a latent node whose **Completed** runs when it finishes ([docs/code-as-nodes.md](docs/code-as-nodes.md)).
- **A graph class can extend a class marked `@blueprint`**, as a Blueprint extends a `Blueprintable` C++ class. Pick it in Class Settings' **Parent Class**. Its marked members work on Self with no Target wire. **Override** lists its abstract methods and the ones marked `@blueprint overridable`. One that returns nothing becomes an **Event**, as Unreal's native and implementable events are, and the others become functions, each wired to a **Parent** call. **Construct** takes the parent constructor's arguments. When the code calls an overridden method, the graph's version runs, and the debugger steps between the two. It works in every language with inheritance (Rust and Go say why they can't), and Run runs it (Simulate can't run your code). See [docs/code-classes-as-parents.md](docs/code-classes-as-parents.md).

  ```ts
  /** @blueprint */
  export abstract class Item {
    /** @blueprint */
    count = 100;
    readonly name: string;
    /** @blueprint */
    protected constructor(name: string) { this.name = name; }
    /** @blueprint overridable */
    take(amount: number): void { this.count -= amount; }
    /** @blueprint */
    abstract describe(): string;
  }
  ```
- TypeScript and JavaScript functions must be exported; Python functions are top-level `def`s; C# methods are `public` or `internal` static methods (C# has no free functions); C++ functions are free functions declared in a header (generated code includes it), called by their namespace; Rust functions are `pub` free functions, called through their module in the crate (`crate::app::values::clamp`), or in another crate of the workspace by its name (`corpus_core::text::title`). Run compiles the C# project's files with the generated one, for C++ the implementation file next to each header, and for Rust the crate's modules. The palette shows only the functions the graph's language can call (a TypeScript graph can also call JavaScript).
- Generated code imports each function the way the project does: relative TypeScript imports follow `tsconfig.json`, JavaScript uses the module's own extension, and Python imports by module name. **Run** finds them too.
- A marked function that can't be a node (a generator, rest parameters, generics, …) gets a warning in its file with the reason. On one that could be, the lightbulb offers **Expose as Blueprint node**.
- **Expose Functions as Nodes...**, on a source file in the Explorer (or the editor's context menu), marks the functions you pick in one edit you review first. On a C or C++ source file it works through the file's header: it marks the declarations there, adds the missing ones, or makes the header (with `extern "C"` for a C file).
- When a function's signature changes, its nodes keep their old pins and show a warning until you choose **Refresh Node** in the node's menu, or **Refresh All Nodes** in the Command Palette. A renamed or moved function shows an error, and the node menu offers **Replace with …** when it can tell where the function went.
- The setting `nodecraft.exposeAllFunctions` exposes every public function, by each language's rule, without markers.

sample/node-authoring has marked TypeScript and Python code, used from graphs in both. The full design is in [docs/code-as-nodes.md](docs/code-as-nodes.md).

## Graphs in your project

To start one, run **NodeCraft: New Project...** and pick a language and a folder. It writes a small project in that language's usual layout (a `package.json`, `pyproject.toml`, `.csproj`, `CMakeLists.txt`, `Cargo.toml`, `pom.xml`, `go.mod`, `project.godot`, ...) with a first graph, an entry point that runs it, a `.gitignore`, a `.gitattributes` marking generated files, and a README saying how to run it with and without VS Code. The first graph is either Hello, which prints "Hello from Blueprint", or the **Tour**: a graph with a variable, a For Loop, a pure function, a structure, Branch and a Test Case, whose comments say what to try (a breakpoint in Simulate, Run, Run Tests, Debug). Then it opens the graph and offers Run.

In a codebase you have, **NodeCraft: Set Up in This Project** (also in a folder's menu in the Explorer) reports each project it finds: its build, its language version against what generated code needs, where graphs would generate, and its checkers. It also lists what generated code needs before it builds (a CMake include, a Rust module block), what can't be done and why, and optional changes (`.gitattributes`, Ruff's and Prettier's ignores, a Composer classmap, a first graph). Each change has **Show Change** and **Apply**, and nothing changes until you apply it.

A graph's generated file sits next to it, in the project's own style, and the project's code uses it like any other module ([docs/project-integration.md](docs/project-integration.md)):

```ts
import { Report } from './graphs/Report.vgraph.ts';

new Report().start();
```

- **It passes the project's checks.** Generated code builds under the strictest settings: `tsc` with every strictness option, mypy `--strict` and Pyright strict, C# with `AnalysisLevel` `latest-all` and warnings as errors, `javac -Xlint:all -Werror`, `-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Werror`, clippy's pedantic lints, `go vet` and staticcheck, PHPStan at level 9, and Godot's warnings as errors. Each file is marked generated for the tools that skip such files: `// <auto-generated/>` in C#, `/* eslint-disable */` in TypeScript and JavaScript, `# flake8: noqa` and `# pylint: skip-file` in Python, Go's `// Code generated ... DO NOT EDIT.`, `# rubocop:disable all`, `-- luacheck: ignore` and `// phpcs:ignoreFile`.
- **Delay and async nodes** wait in a queue that Run drives. When your own code runs a class with them, run the queue after `start()`: `run_latent_actions()` from the generated module in Python, `Report.RunLatentActions()` in C#, `Report.runLatentActions()` in Java, and the support module's in the other languages (docs/code-as-nodes.md). TypeScript and JavaScript need nothing.
- **Your project's language version.** When the project declares an older version than generated code needs (Java 11 in `pom.xml`, where generated Java needs 17), Problems shows a warning once, on the file that declares it. The graph still compiles: the project may build with a newer toolchain.
- **Constants are worked out when compiling.** A Branch on a constant leaves only the side that runs, and a value nothing reads leaves no code. A breakpoint on a node that left no code can't stop when debugging the generated code, and Debug says which ones. Simulate still stops there.
- **A float wired into an int is truncated toward zero** (7.5 becomes 7), as Unreal converts it, in Simulate and every language ([docs/semantics.md](docs/semantics.md)).
- **Large workspaces.** Scanning stops at `nodecraft.scanLimit` files of each kind (5000), and says so when it does.

## The Codebase Map

**NodeCraft: Show Codebase Map** (also in a folder's menu in the Explorer) draws the workspace's code and graphs, flowing top to bottom. It reads every file with tree-sitter in all twelve languages, runs nothing, and works in Restricted Mode ([docs/codebase-map.md](docs/codebase-map.md)).

- **Four views:**
  - **Architecture:** projects, folders and files, with their imports. Importers sit above what they import, and cycles are outlined.
  - **Structure:** types and functions, parents above their children, with each type's members listed.
  - **Call flow:** from the entry points (or any function), what calls what, a few levels at a time; or its callers, from above. Graphs and code share one picture. Calls are found statically, so a guess is dashed.
  - **Control flow:** one function's flowchart, its loops coming back up.
- **Moving around:** Find (Ctrl+F), filters by project, language and kind, focus on a box's callers and calls, the path between two boxes, Back and Forward, a minimap, and keyboard moves along the arrows. Hovering a type or function shows its signature and doc comment.
- **From the map into Blueprint:** a function's box offers **Expose as Node**, a graph's box opens it on its tab, and any box opens its code. **Show in Codebase Map**, **Show Call Flow** and **Show Control Flow** start from a file in the Explorer or the function at the cursor.
- **In the Explorer,** the **Codebase Map** view lists the same projects, files, types and functions as a tree, for the keyboard and screen readers.

## Custom node libraries

Place node definitions anywhere in the workspace using the `*.node.json` suffix. The extension scans the workspace for these files on activation.

Example:

```json
{
  "type": "studio.math.double",
  "version": 1,
  "displayName": "Double",
  "category": "Math",
  "inputs": [
    { "id": "execIn", "name": "", "kind": "exec", "direction": "input" },
    { "id": "value", "name": "Value", "kind": "data", "direction": "input", "type": { "id": "float" }, "defaultValue": 2 }
  ],
  "outputs": [
    { "id": "execOut", "name": "", "kind": "exec", "direction": "output" },
    { "id": "result", "name": "Result", "kind": "data", "direction": "output", "type": { "id": "float" } }
  ],
  "implementation": {
    "kind": "code",
    "defaultLanguage": "javascript",
    "languages": {
      "javascript": "return ${value} * 2;",
      "typescript": "return ${value} * 2;",
      "python": "return ${value} * 2"
    }
  }
}
```

The `languages` map holds one snippet per target language, by language id (`typescript`, `javascript`, `python`, `csharp`, ...). A snippet is a function body: its data inputs are parameters (`${pinId}` always works, and ids that are valid identifiers can be used directly) and its return value is the node's first data output. Compiling a graph to a language whose snippet is missing is a compile error. Simulate can run JavaScript snippets only; other languages run through generated code.

Node files are checked against the node schema as you write them. Their problems show in the editor: a `${pin}` with no such input, a type another file defines too, a language the workspace uses with no snippet. **New Node** writes one to start from. A node may list `examples` (inputs and the outputs they give), and **Test Node Library** runs them in Simulate and in each language the workspace's graphs use; `nodecraft-conformance <pack> --nodes <folder>` does the same from the command line ([docs/node-authoring.md](docs/node-authoring.md)).

### Framework events

A node library can also add events that a framework runs, such as a command-line tool's commands. An event definition uses the implementation `{ "kind": "event", "method": "OnCommand" }`; its data outputs are the event's parameters. Each class that uses the event gets a public method named after `method` (`onCommand` in TypeScript and JavaScript, `on_command` in Python, `OnCommand` in C#), which the framework's host code calls. See `sample/visual-nodes/CLI/OnCommand.node.json`.

A graph's **Main** event is the program's entry point: Run calls it after Start, with the `nodecraft.runArguments` setting as its Args.


## Settings

| Setting | Default | What it does |
|---|---|---|
| `nodecraft.compileOnSave` | `true` | Compile a graph whenever it's saved. When off, graphs compile on Compile (F7), Run, Run Tests and Debug. |
| `nodecraft.defaultLanguage` | empty | The language of new graphs in a folder, by language id (`typescript`, `python`, `gdscript`, ...). Set it per folder; when empty, New Graph uses the nearest project files. |
| `nodecraft.runCommands` | `{}` | The command Run, Run Tests and Debug start for a language, by language id, in place of the one on the PATH: `{ "python": ["C:/Python313/python.exe"] }`. |
| `nodecraft.runArguments` | `[]` | The arguments a graph's **Main** event gets (its Args) under Run, Simulate and Debug, passed as they are. |
| `nodecraft.exposeAllFunctions` | `false` | Show every public function as a node, by each language's rule, without `@blueprint`. Class members still need it. |
| `nodecraft.scanLimit` | `5000` | The most files of each kind the extension scans in a workspace (source files, graphs, node files, package manifests), and the Codebase Map in each folder. A scan that reaches it says so. |
| `nodecraft.autoSaveDelay` | `150` | Milliseconds the graph editor waits after a change before writing it to the file's text document (the file still saves as usual). |

In Restricted Mode, `runCommands` and `runArguments` are read from your user settings only, never from the workspace's.

## Architecture

```text
VS Code Custom Text Editor
        |
        +--> Webview Graph UI
        |
        +--> Language-neutral Graph Model
                    |
                    +--> Node Registry
                    +--> Type System
                    +--> Runtime / Debug Events
                    +--> Visual IR --> Code Generators (language packs)
                    +--> Declaration scanners --> project functions as nodes
```

The extension uses VS Code's `CustomTextEditorProvider`, which is the intended API for editable text-based custom formats. See:

- https://code.visualstudio.com/api/extension-guides/custom-editors
- https://code.visualstudio.com/api/extension-guides/webview
- https://code.visualstudio.com/api/references/vscode-api

## Roadmap

[docs/roadmap.md](docs/roadmap.md) has the plan toward a language-universal, Blueprint-equivalent editor, phase by phase, and the decisions behind it.

## Editor interaction reference

The editor follows Unreal Engine 5's Blueprint editor. [docs/unreal-conventions.md](docs/unreal-conventions.md) lists every convention with its source, the pin colors and the node title styles. On macOS, Ctrl is Cmd and Alt is Option.

### Navigation and selection

| Action | Gesture |
|---|---|
| Pan | Right-drag (middle-drag also works) |
| Zoom | Mouse wheel |
| Zoom to the selection, or the whole graph | Home |
| Select / add / toggle | Click / Shift + click / Ctrl + click a node |
| Marquee select (replace / add / remove) | Drag / Shift + drag / Ctrl + drag the background |
| Select all | Ctrl + A |

### Nodes

| Action | Gesture |
|---|---|
| Add a node (graph action menu) | Right-click the background; the palette on the left also works |
| Node actions (alignment, break links, delete…) | Right-click a node |
| Pin actions, then the node's actions | Right-click a pin |
| Rename or delete a comment | Right-click its title bar |
| Place Branch, Sequence, Start or Delay | Hold B, S, P or D and click (also G, M, N, O, F for Gate, MultiGate, Do N, Do Once, For Each Loop) |
| Comment around the selection | C (hold C and click to place an empty comment) |
| Move | Drag a node; Ctrl + arrow keys move the selection (the arrows alone move the keyboard's focus, below) |
| Delete | Delete |
| Cut / copy / paste / duplicate | Ctrl + X / C / V / D |
| Align top / left / bottom / right | Shift + W / A / S / D |
| Straighten connections | Q |
| Rename a comment, graph or variable | F2 or double-click |
| Context Sensitive | Checkbox in the action menu: only nodes that fit the dragged pin |

### Wires and pins

| Action | Gesture |
|---|---|
| Connect | Drag from a pin to a pin. An exec output takes one wire, a data input one; connecting replaces the old wire. |
| Create a connected node | Drag from a pin to empty space |
| Break all links | Alt + click a pin, or right-click it → Break Link(s) |
| Move all links to another pin | Ctrl + drag from a pin |
| Highlight a pin's wires | Hover the pin |
| Add a reroute node | Double-click a wire |
| Edit an unconnected input | Type in the field on the node |
| Convert a number or bool to text | Connect it to a string pin; a To String node is inserted |
| Promote to Variable | Right-click a data pin |
| Add / remove a Sequence output | "Add pin +" on the node / right-click the pin → Remove Execution Pin |

### Variables (My Blueprint)

| Action | Gesture |
|---|---|
| Add | **+** next to Variables |
| Get node / Set node | Ctrl + drag / Alt + drag the variable into the graph |
| Choose Get or Set | Drag the variable into the graph |
| Get or Set as appropriate | Drag the variable onto a compatible pin |
| Type, default value, rename | Select the variable; edit it in Details |

### Editor commands

| Action | Gesture |
|---|---|
| Compile | F7, or **Compile** in the toolbar |
| Save | Ctrl + S |
| Undo / redo | Ctrl + Z / Ctrl + Y |
| Find in this file | Ctrl + F |
| Find in all graph files | Ctrl + Shift + F |
| Toggle a breakpoint on the selected nodes / remove all of the file's breakpoints | F9 / Ctrl + Shift + F9 (also Add, Remove, Disable and Enable Breakpoint in the node menu) |
| Debug (run the generated code under the debugger) | F5, or **Debug** in the toolbar |
| While paused at a breakpoint: Resume, Step Over, Step Into, Step Out, Stop | F5, F10, F11, Shift + F11, Shift + F5 (also the Blueprint Debugger panel's buttons) |
| Cancel the current gesture or close a menu | Escape |

### From the keyboard

| Action | Keys |
|---|---|
| Reach the graph | Tab: the keyboard starts on the node last focused, the selected one, or the top-left one |
| Move to the nearest node in a direction (it's selected) | Arrow keys |
| Go into a node's pins / move between them / come back out | Enter / arrow keys (Left and Right cross sides) / Escape |
| Wire a pin, or add a node from it, without dragging | Enter on the pin (or Shift + F10): **Connect to…** lists the pins it fits; **Add Node from Here…** opens Add Node as dropping a wire does |
| Edit an input's value on the node | F2 on the pin; Enter or Escape gives the keyboard back |
| Leave the node: nothing focused or selected | Escape |
| Open the menu a right-click would: the focused pin's, the selected node's, the selected comment's, or Add Node with nothing selected | Shift + F10 or the Menu key |
| Move through a menu / use an item / close it | Arrow keys, Home, End / Enter or Space / Escape |
| Add Node: choose a result / add it | Type to search, Up and Down / Enter (the first result until you move) |
| My Blueprint's graphs, variables and dispatchers | Tab to them; Enter opens or selects, F2 renames, Delete deletes, Shift + F10 opens the item's menu |
| The palette | Tab to a node; Enter adds it to the graph |

With a screen reader, the graph reads out the node or pin the keyboard is on: a node's title, kind,
breakpoint and problems ("Branch, flow control"), and a pin's name, type, direction and what it's
wired to or its value ("Value, Wildcard input, connected to Add: Result"). The status line
announces each node added, wire made, node deleted and compile result. In high contrast themes the
editor uses the system's colors, and selection and the keyboard's focus use its highlight color.

## License

Copyright (C) 2026 Devin Brasher.

NodeCraft is free software under the [GNU General Public License, version 3](LICENSE) only, with two additional permissions ([LICENSING.md](LICENSING.md)):

- **The code it writes is yours.** Generated code, the support code written with it, build lines and the files New Project writes may be used under any terms you choose, in open or closed projects. Your graphs are yours too.
- **Language packs can have their own license.** A pack that adds a language through NodeCraft's API, pack formats or pack SDK doesn't have to be under the GPL.

Changes to NodeCraft itself that you distribute stay under the GPL, with their source. The name NodeCraft isn't licensed: a modified version needs a name of its own.

Contributions are welcome under the [Contributor License Agreement](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md). Version 0.1.1 and earlier were released under the MIT License.
