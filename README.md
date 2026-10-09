# Blueprint Visual Scripting for VS Code

A language-neutral, Blueprint-style visual scripting editor for Visual Studio Code. This repository is a runnable MVP project intended to be opened directly in VS Code and launched with the Extension Development Host.

## What is included

- `.vgraph` text-backed custom editor.
- Blueprint-style **execution pins** and **data pins**.
- Drag nodes around the canvas.
- Drag from a pin to another pin to connect it.
- Drag from a pin to empty space to open a compatible-node creation menu.
- Typed data connections with basic compatibility checks.
- Node palette with search and categories.
- Inspector for editing unconnected input defaults.
- JSON persistence with VS Code text-document undo/save behavior.
- Built-in Flow, Math, Debug, and Variable nodes: Start, Add, Branch, Print, Set/Get Variable, Sequence, End.
- Workspace-loaded `*.node.json` user node libraries, with code snippets per language. Example: `Double`.
- **Code generation**: each graph compiles to readable source code in its target language, written next to the graph and meant to be committed. TypeScript, JavaScript and Python are supported.
- Unreal-style **Compile** button and **Compiler Results**, with error and warning badges on nodes and entries in the Problems panel.
- **Run** (generated code, through the project's own Node.js or Python) and **Simulate** (the editor's built-in interpreter).

## Open and run

1. Open this folder in VS Code and run `npm install`.
2. Press `F5` (or choose **Run Blueprint Visual Scripting Extension** in Run and Debug). An Extension Development Host opens the `sample` workspace.
3. Open `sample/demo.vgraph`.
4. Click **Compile**. The graph's target language is JavaScript, so `demo.vgraph.js` appears next to it. Pick another language in the toolbar to generate TypeScript (`demo.vgraph.ts`) or Python (`demo_vgraph.py`) instead. Saving the graph also compiles it (setting: `blueprintVisualScripting.compileOnSave`).
5. Click **▶ Run** to run the generated code with Node.js (22.18 or later, which runs TypeScript directly) or Python 3, or **Simulate** to run the graph inside the editor. Output appears in the `Blueprint Visual Scripting` Output channel.

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
| `npm run test:conformance` | Runs every fixture graph in Simulate and as generated TypeScript, JavaScript and Python, and checks they print the same output (part of `npm test`; needs Node.js 22.18+ and Python 3) |
| `npm run test:integration` | Launches VS Code with the extension and runs smoke tests inside it (not part of `npm test`) |

The browser tests drive the real webview bundle in an installed Microsoft Edge or Google Chrome through `playwright-core` (no browser download). Set `BLUEPRINT_TEST_BROWSER` to a Chromium executable to use a different one; without any browser those tests are skipped.

Source layout:

- `src/core/`: the graph model, serializer, node registry, reference runtime and graph-editing operations. It must not import `vscode` or Node built-ins, so it can be shared with the webview and tested in plain Node (a unit test enforces this).
- `src/extension/`: VS Code integration (activation, the custom editor, workspace node-library loading, webview markup).
- `src/webview/`: the graph editor UI, written in TypeScript and bundled by esbuild. It has no runtime dependencies.
- `test/unit/`: unit tests for `src/core`.
- `test/webview/`: browser tests for the editor UI.
- `test/conformance/`: the conformance suite. Fixture graphs in `test/fixtures/graphs/` declare their expected output; golden files in `test/fixtures/codegen/` record generated code (`UPDATE_GOLDEN=1 npm run test:unit` rewrites them).
- `test/integration/`: tests that run inside a real VS Code.

The integration tests download the minimum supported VS Code version (from `engines.vscode`) into `.vscode-test/` on first run, and open a VS Code window while they run. They work from a VS Code terminal too: the launcher clears `ELECTRON_RUN_AS_NODE`, which VS Code sets for its child processes.

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
                    +--> Future Visual IR / Code Generators
```

The extension uses VS Code's `CustomTextEditorProvider`, which is the intended API for editable text-based custom formats. See:

- https://code.visualstudio.com/api/extension-guides/custom-editors
- https://code.visualstudio.com/api/extension-guides/webview
- https://code.visualstudio.com/api/references/vscode-api

## Roadmap

The MVP deliberately focuses on the graph/editor contract. See [docs/roadmap.md](docs/roadmap.md) for the plan toward a language-universal, Blueprint-equivalent editor.

## Editor interaction reference

- **Left-drag a node header:** move the node; when multiple nodes are selected, the whole selection moves.
- **Shift/Ctrl/Cmd-click a node:** add/remove it from the selection.
- **Left-drag the canvas background:** box-select nodes.
- **Ctrl/Cmd-click a wire:** pick the nearest end of the wire and drag that end to a different pin. Releasing off a pin removes the connection.
- **Ctrl/Cmd-click a connected pin:** rewire the nearest connection from that pin.
- **Alt-click a pin:** break all connections on that pin.
- **Alt-click a wire:** remove that connection.
- **Right-click the background:** open a floating node search menu at that location.
- **Right-click a node:** open node actions such as Duplicate, Disconnect All Connections, Select Connected Nodes, Center View, and Delete.
- **Middle-drag:** pan the canvas.
- **Mouse wheel:** zoom around the cursor.
- **Delete/Backspace:** delete the current selection.
- **Ctrl/Cmd+A:** select all nodes.
- **Escape:** close menus and cancel active connection/selection gestures.
### Core canvas gestures

The editor uses the desktop mouse event path for its two primary interactions: left-drag any node body to move it, and left-drag any input/output pin to create or reconnect a wire. Background left-drag creates the selection marquee.

