# Blueprint Visual Scripting for VS Code

A language-neutral, Blueprint-style visual scripting editor for Visual Studio Code. This repository is a runnable MVP project intended to be opened directly in VS Code and launched with the Extension Development Host.

## What is included

- A `.vgraph` custom editor that looks and behaves like Unreal Engine's Blueprint editor: the same gestures, shortcuts, pin colors and node styles, so Blueprint users can start without relearning (see the reference below).
- **Blueprints**: a `.vgraph` file is a class, function library or macro library holding graphs, functions, macros and variables, managed in the **My Blueprint** panel. Classes construct each other, inherit (with overrides and Parent calls), implement Blueprint Interfaces and Cast To them; custom events, event dispatchers and Delay work as in Unreal. sample/arena is a small program built only in graphs that uses all of it. Functions and macros work as in Unreal, including Collapse to Function and Collapse to Macro, and the functions and macros of library files can be used from any graph in the same language. **Structures** and **enumerations** are files too, edited in a field or value list, with Make, Break, Set Members and Switch on nodes.
- **Execution and data pins**, with Unreal's wiring rules, inline values for unconnected inputs, automatic **To String** conversion, reroute nodes, comment boxes, copy and paste, alignment tools and Find.
- **Your code as nodes**, the equivalent of Unreal's `BlueprintCallable`: functions marked `@blueprint` in the project's TypeScript, JavaScript, Python or C# code appear in the palette, generated code imports them, and nodes notice when the code changes (see below).
- Built-in Flow, Debug and Variable nodes (Start, Branch, Sequence, Print, Get and Set, To String, End), and Unreal's **standard library** of math, string, utility and file nodes, with the same meaning in every language.
- Workspace `*.node.json` user node libraries, with a code snippet per language. Example: `Double`.
- **Code generation**: each graph compiles to readable source code in its target language, written next to the graph and meant to be committed. TypeScript, JavaScript, Python and C# are supported.
- Unreal-style **Compile** (F7) and **Compiler Results**, with error and warning badges on nodes and entries in the Problems panel.
- **Run** (the generated code, through the project's own Node.js or Python) and **Simulate** (the editor's built-in interpreter). With breakpoints set (F9), Simulate pauses at them: step node by node, see the call stack in graph terms, hover a pin to see its value, or **Watch this value** from the pin's menu.
- **Debug** (F5): runs the generated code under the language's own debugger (VS Code's built-in one for TypeScript and JavaScript, the Python Debugger extension for Python, the C# extension for C#), stopping at the same node breakpoints, stepping node by node and showing pins' values, without opening the generated file.
- Saving goes through VS Code's text document, so undo, redo, dirty state and source control work as usual.

## Open and run

1. Open this folder in VS Code and run `npm install`.
2. Press `F5` (or choose **Run Blueprint Visual Scripting Extension** in Run and Debug). An Extension Development Host opens the `sample` workspace.
3. Open `sample/demo.vgraph`.
4. Click **Compile**. The graph's target language is JavaScript, so `demo.vgraph.js` appears next to it. Pick another language in the toolbar to generate TypeScript (`demo.vgraph.ts`) or Python (`demo_vgraph.py`) instead. Saving the graph also compiles it (setting: `blueprintVisualScripting.compileOnSave`).
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
| `npm run test:conformance` | Runs every fixture graph in Simulate and as generated TypeScript, JavaScript, Python and C#, and checks they print the same output (part of `npm test`; needs Node.js 22.18+, Python 3 and the .NET SDK; missing tools skip their tests) |
| `npm run test:integration` | Launches VS Code with the extension and runs smoke tests inside it (not part of `npm test`) |
| `npm run test:integration:debuggers` | The same, with your installed VS Code extensions loaded, so debugging generated Python (Python Debugger extension) and C# (C# extension) is tested too |

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

- `@blueprint` makes a node with exec pins (`BlueprintCallable`); `@blueprint pure` makes one without (`BlueprintPure`). `@category`, `@displayName` and `@keywords` work as Unreal's metadata does. Parameters become input pins (literal defaults become pin values) and the return value becomes **Return Value**.
- TypeScript and JavaScript functions must be exported; Python functions are top-level `def`s; C# methods are `public` or `internal` static methods (C# has no free functions). Run compiles the C# project's files with the generated one. The palette shows only the functions the graph's language can call (a TypeScript graph can also call JavaScript).
- Generated code imports each function the way the project does: relative TypeScript imports follow `tsconfig.json`, JavaScript uses the module's own extension, and Python imports by module name. **Run** finds them too.
- Functions that can't be nodes (async functions, generators, rest parameters, generics, …) are listed in the **Blueprint Visual Scripting** output channel with the reason.
- When a function's signature changes, its nodes keep their old pins and show a warning until you choose **Refresh Node** in the node's menu, or **Refresh All Nodes** in the Command Palette. A renamed or moved function shows an error, and the node menu offers **Replace with …** when it can tell where the function went.
- The setting `blueprintVisualScripting.exposeAllFunctions` exposes every exported or public function without markers.

The sample workspace has two marked functions in `sample/lib/combat.js`. The full design is in [docs/code-as-nodes.md](docs/code-as-nodes.md).

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
