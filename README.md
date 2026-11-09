# Blueprint Visual Scripting for VS Code

A language-neutral, Blueprint-style visual scripting editor for Visual Studio Code. This repository is a runnable MVP project intended to be opened directly in VS Code and launched with the Extension Development Host.

## What is included

- A `.vgraph` custom editor that looks and behaves like Unreal Engine's Blueprint editor: the same gestures, shortcuts, pin colors and node styles, so Blueprint users can start without relearning (see the reference below).
- **Blueprints**: a `.vgraph` file is a class, function library or macro library holding graphs, functions, macros and variables, managed in the **My Blueprint** panel. Classes construct each other, inherit (with overrides and Parent calls), implement Blueprint Interfaces and Cast To them; custom events, event dispatchers and Delay work as in Unreal. sample/arena is a small program built only in graphs that uses all of it. Functions and macros work as in Unreal, including Collapse to Function and Collapse to Macro, and the functions and macros of library files can be used from any graph in the library's languages (a function library can be generated for several), including through **Collapse to Function in Library**. **Structures** and **enumerations** are files too, edited in a field or value list, with Make, Break, Set Members and Switch on nodes.
- **Execution and data pins**, with Unreal's wiring rules, inline values for unconnected inputs, automatic **To String** conversion, reroute nodes, comment boxes, copy and paste, alignment tools and Find.
- **Your code as nodes**, the equivalent of Unreal's `BlueprintCallable` and `BlueprintReadWrite`: functions marked `@blueprint` in the project's code, in all twelve languages (C++: in headers; Go: through gopls), appear in the palette, and generated code imports them. So do classes' constructors, methods and properties (with Target pins), functions with several outputs, and async functions (as latent nodes). Nodes notice when the code changes, double-click (F12) opens the code, and the code shows warnings and **Expose** quick fixes (see below). sample/node-authoring uses all of it in TypeScript and Python.
- **In your language's terms**: the Language menu changes what the editor calls things (Python's Make List, `list[int]` and Dict; C#'s List, HashSet and Dictionary). Hovering a node in the palette or the Add Node menu shows its code in the language, and each language has its standard library's own nodes: regular expressions (Lua's patterns in Lua) and MD5, SHA-1 and SHA-256 hashes. An audit runs every node in every language against Simulate ([docs/language-context.md](docs/language-context.md)).
- Built-in Flow, Debug and Variable nodes (Start, Branch, Sequence, Print, Get and Set, To String, End), and Unreal's **standard library** of math, string, utility and file nodes, plus everyday utilities (case conversion, Slugify, Truncate, Format Bytes, strict parsing, Unique, Median, Pick, Normalize Path and more), with the same meaning in every language.
- Workspace `*.node.json` user node libraries, with a code snippet per language (example: `Double`), checked as you write them, with **New Node** to start one and **Test Node Library** to run their examples. **Packages**: a `*.vgraph-package.json` manifest gives node files and library graphs a name, a version and dependencies, and **Add Blueprint Package…** adds one from a folder, an extension or npm (an npm package with a `blueprint` field; see docs/node-authoring.md, gap 9). Graphs remember the version of each package they use, and a new major version marks its nodes for Refresh Node.
- **Code generation**: each graph compiles to readable source code in its target language, written next to the graph and meant to be committed. TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, Lua, GDScript (Godot 4), Ruby and PHP are supported (Rust without inheritance or interfaces, Go without inheritance). Other languages can be added as **language packs** from other extensions, or as declarative packs: a workspace `*.vgraph-language.json` file of templates, types and how to run the code (see [the pack SDK](packages/pack-sdk/README.md)). [examples/c-language-pack](examples/c-language-pack/README.md) adds C this way, as its own extension.
- Unreal-style **Compile** (F7) and **Compiler Results**, with error and warning badges on nodes and entries in the Problems panel.
- **Run** (the generated code, through the project's own Node.js or Python) and **Simulate** (the editor's built-in interpreter). With breakpoints set (F9), Simulate pauses at them: step node by node, see the call stack in graph terms, hover a pin to see its value, or **Watch this value** from the pin's menu.
- **Tests**: Test Case events with Assert True and Assert Equal nodes. **Run Tests** runs them with the language's test tool (from a generated test file: `node --test`, `unittest`), **Simulate Tests** in the editor.
- **Debug** (F5): runs the generated code under the language's own debugger (VS Code's built-in one for TypeScript and JavaScript, the Python Debugger extension for Python, the C# extension for C#, the C/C++ extension for C++, for Rust the C/C++ extension on Windows or CodeLLDB elsewhere, the Debugger for Java for Java, the Go extension (Delve) for Go, Lua Debug for Lua, godot-tools for GDScript in a Godot project, the VSCode rdbg Ruby Debugger for Ruby, and PHP Debug with Xdebug for PHP), stopping at the same node breakpoints, stepping node by node and showing pins' values, without opening the generated file.
- Saving goes through VS Code's text document, so undo, redo, dirty state and source control work as usual.

## Open and run

1. Open this folder in VS Code and run `npm install`.
2. Press `F5` (or choose **Run Blueprint Visual Scripting Extension** in Run and Debug). An Extension Development Host opens the `sample` workspace.
3. Open `sample/demo.vgraph`.
4. Click **Compile**. The graph's target language is JavaScript, so `demo.vgraph.js` appears next to it. Pick another language in the toolbar to generate TypeScript (`demo.vgraph.ts`) or Python (`demo_vgraph.py`) instead. Saving the graph also compiles it (setting: `blueprintVisualScripting.compileOnSave`).
   **New Graph** (Command Palette) starts a graph in the language of the project files nearest to where it's saved, so a repository with a TypeScript `web/` and a Python `api/` gets the right one in each; the `blueprintVisualScripting.defaultLanguage` setting overrides that per folder. Structs and enums can be shared between those languages, and [examples/multi-language](examples/multi-language/README.md) shows a graph calling code in another language ([docs/multi-language.md](docs/multi-language.md)).
5. Click **▶ Run** to run the generated code with Node.js (22.18 or later, which runs TypeScript directly), Python 3 or the .NET SDK (8 or later; C# graphs are built in a small project the extension keeps in the temporary folder), or **Simulate** to run the graph inside the editor. Output appears in the `Blueprint Visual Scripting` Output channel.

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
| `npm run corpus:tools` | Installs the Node.js tools the corpus of project layouts runs (TypeScript 5, ESLint with typescript-eslint, Node.js's types) into a cache folder outside the repository, and downloads PHP's (Composer, PHPStan and PHP_CodeSniffer, each a `.phar`) into it; the other languages' tools (mypy, Pyright, Ruff, pnpm, dotnet, Maven, Gradle, cargo, go, staticcheck, CMake, make, RuboCop, luacheck, Godot as `GODOT` or `godot`) come from the PATH. The corpus (`test/conformance/corpus.test.ts`, part of `npm test`) copies each project in `test/fixtures/projects`, compiles graphs into it as Compile does, then runs the project's own build, checkers, tests and entry point. A missing tool skips its step; a layout with skipped steps is reported as todo, and `BLUEPRINT_CORPUS_REQUIRE_TOOLS=1` makes it fail instead |
| `npm run test:integration` | Launches VS Code with the extension and runs smoke tests inside it (not part of `npm test`) |
| `npm run test:integration:debuggers` | The same, with your installed VS Code extensions loaded, so debugging generated Python (Python Debugger extension), C# (C# extension), C++ and Rust (C/C++ extension), Java (Debugger for Java), Go (Go extension), Lua (Lua Debug), GDScript (godot-tools, with the `GODOT` environment variable set), Ruby (rdbg) and PHP (PHP Debug, with Xdebug in php.ini) is tested too |
| `npm run build:sdk` / `npm run test:sdk` | Builds the language pack SDK (`packages/pack-sdk`, with the conformance suite and its `blueprint-conformance` command) / and runs its command once |

The browser tests drive the real webview bundle in an installed Microsoft Edge or Google Chrome through `playwright-core` (no browser download). Set `BLUEPRINT_TEST_BROWSER` to a Chromium executable to use a different one; without any browser those tests are skipped.

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
 * Subtracts damage from health, never going below zero.
 * @blueprint
 * @category Combat
 */
export function applyDamage(health: number, amount = 10): number {
  return Math.max(0, health - amount);
}
```

```python
def is_alive(health: float) -> bool:
    """@blueprint pure"""
    return health > 0
```

```csharp
public static class Loot
{
    /// <summary>A random drop chance.</summary>
    /// @blueprint pure
    public static double DropChance(int level) => 0.1 + level * 0.01;
}
```

```cpp
// combat.h
namespace combat {
/// @blueprint pure
double critChance(long long level);
}
```

- `@blueprint` makes a node with exec pins (`BlueprintCallable`); `@blueprint pure` makes one without (`BlueprintPure`). `@category`, `@displayName`, `@keywords`, `@compactTitle`, `@deprecated` (or the language's own marker, such as `[Obsolete]`), `@advanced`, `@pinName` and `@execs` work as Unreal's metadata does. Parameters become input pins (literal defaults become pin values) and the return value becomes **Return Value**.
- A class's marked constructor, methods and properties become **Construct**, method nodes with a **Target** pin, and **Get** and **Set** nodes. Out parameters, tuples and records give several outputs, and an async function is a latent node whose **Completed** runs when it finishes ([docs/code-as-nodes.md](docs/code-as-nodes.md)).
- TypeScript and JavaScript functions must be exported; Python functions are top-level `def`s; C# methods are `public` or `internal` static methods (C# has no free functions); C++ functions are free functions declared in a header (generated code includes it), called by their namespace; Rust functions are `pub` free functions, called through their module in the crate (`crate::game::combat::damage`), or in another crate of the workspace by its name (`corpus_core::text::title`). Run compiles the C# project's files with the generated one, for C++ the implementation file next to each header, and for Rust the crate's modules. The palette shows only the functions the graph's language can call (a TypeScript graph can also call JavaScript).
- Generated code imports each function the way the project does: relative TypeScript imports follow `tsconfig.json`, JavaScript uses the module's own extension, and Python imports by module name. **Run** finds them too.
- A marked function that can't be a node (a generator, rest parameters, generics, …) gets a warning in its file with the reason. On one that could be, the lightbulb offers **Expose as Blueprint node**.
- When a function's signature changes, its nodes keep their old pins and show a warning until you choose **Refresh Node** in the node's menu, or **Refresh All Nodes** in the Command Palette. A renamed or moved function shows an error, and the node menu offers **Replace with …** when it can tell where the function went.
- The setting `blueprintVisualScripting.exposeAllFunctions` exposes every public function, by each language's rule, without markers.

sample/node-authoring has marked TypeScript and Python code, used from graphs in both. The full design is in [docs/code-as-nodes.md](docs/code-as-nodes.md).

## Graphs in your project

To start one, run **Blueprint Visual Scripting: New Project...** and pick a language and a folder. It writes a small project in that language's usual layout (a `package.json`, `pyproject.toml`, `.csproj`, `CMakeLists.txt`, `Cargo.toml`, `pom.xml`, `go.mod`, `project.godot`, ...) with a first graph that prints "Hello from Blueprint", an entry point that runs it, a `.gitignore`, a `.gitattributes` marking generated files, and a README saying how to run it with and without VS Code. Then it opens the graph and offers Run.

In a codebase you have, **Blueprint Visual Scripting: Set Up in This Project** (also in a folder's menu in the Explorer) reports each project it finds: its build, its language version against what generated code needs, where graphs would generate, and its checkers. It also lists what generated code needs before it builds (a CMake include, a Rust module block), what can't be done and why, and optional changes (`.gitattributes`, Ruff's and Prettier's ignores, a Composer classmap, a first graph). Each change has **Show Change** and **Apply**, and nothing changes until you apply it.

A graph's generated file sits next to it, in the project's own style, and the project's code uses it like any other module ([docs/project-integration.md](docs/project-integration.md)):

```ts
import { Game } from './graphs/Game.vgraph.ts';

new Game().start();
```

- **It passes the project's checks.** Generated code builds under the strictest settings: `tsc` with every strictness option, mypy `--strict` and Pyright strict, C# with `AnalysisLevel` `latest-all` and warnings as errors, `javac -Xlint:all -Werror`, `-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Werror`, clippy's pedantic lints, `go vet` and staticcheck, PHPStan at level 9, and Godot's warnings as errors. Each file is marked generated for the tools that skip such files: `// <auto-generated/>` in C#, `/* eslint-disable */` in TypeScript and JavaScript, `# flake8: noqa` and `# pylint: skip-file` in Python, Go's `// Code generated ... DO NOT EDIT.`, `# rubocop:disable all`, `-- luacheck: ignore` and `// phpcs:ignoreFile`.
- **Delay and async nodes** wait in a queue that Run drives. When your own code runs a class with them, run the queue after `start()`: `run_latent_actions()` from the generated module in Python, `Game.RunLatentActions()` in C#, `Game.runLatentActions()` in Java, and the support module's in the other languages (docs/code-as-nodes.md). TypeScript and JavaScript need nothing.
- **Your project's language version.** When the project declares an older version than generated code needs (Java 11 in `pom.xml`, where generated Java needs 17), Problems shows a warning once, on the file that declares it. The graph still compiles: the project may build with a newer toolchain.
- **Constants are worked out when compiling.** A Branch on a constant leaves only the side that runs, and a value nothing reads leaves no code. A breakpoint on a node that left no code can't stop when debugging the generated code, and Debug says which ones. Simulate still stops there.
- **A float wired into an int is truncated toward zero** (7.5 becomes 7), as Unreal converts it, in Simulate and every language ([docs/semantics.md](docs/semantics.md)).
- **Large workspaces.** Scanning stops at `blueprintVisualScripting.scanLimit` files of each kind (5000), and says so when it does.

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

The `languages` map holds one snippet per target language (`typescript`, `javascript`, `python`). A snippet is a function body: its data inputs are parameters (`${pinId}` always works, and ids that are valid identifiers can be used directly) and its return value is the node's first data output. Compiling a graph to a language whose snippet is missing is a compile error. Simulate can run JavaScript snippets only; other languages run through generated code.

Node files are checked against the node schema as you write them. Their problems show in the editor: a `${pin}` with no such input, a type another file defines too, a language the workspace uses with no snippet. **New Node** writes one to start from. A node may list `examples` (inputs and the outputs they give), and **Test Node Library** runs them in Simulate and in each language the workspace's graphs use; `blueprint-conformance <pack> --nodes <folder>` does the same from the command line ([docs/node-authoring.md](docs/node-authoring.md)).

### Framework events

A node library can also add events that a framework runs, such as a command-line tool's commands. An event definition uses the implementation `{ "kind": "event", "method": "OnCommand" }`; its data outputs are the event's parameters. Each class that uses the event gets a public method named after `method` (`onCommand` in TypeScript and JavaScript, `on_command` in Python, `OnCommand` in C#), which the framework's host code calls. See `sample/visual-nodes/CLI/OnCommand.node.json`.

A graph's **Main** event is the program's entry point: Run calls it after Start, with the `blueprintVisualScripting.runArguments` setting as its Args.


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

The MVP deliberately focuses on the graph/editor contract. See [docs/roadmap.md](docs/roadmap.md) for the plan toward a language-universal, Blueprint-equivalent editor.

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
| Move | Drag a node; arrow keys move the selection |
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
