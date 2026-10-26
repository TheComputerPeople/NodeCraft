# Debugging (Phase 5 design)

Phase 5 of the [roadmap](roadmap.md): Blueprint debugging for graphs, in Simulate and in the generated code through each language's real debugger, without the user ever opening a generated file. This document records the design decisions: the Unreal behavior copied, how each piece maps to Simulate and to the Debug Adapter Protocol (DAP), and what is left out.

## What Unreal does (the behavior to copy)

- **Breakpoints** are set on nodes: F9 toggles one on the selected node, and the node menu adds, removes, enables and disables them. A breakpoint shows as a red marker on the node's corner (hollow when disabled). Breakpoints are editor state, not part of the asset.
- When execution reaches a node with a breakpoint, the game pauses and the editor shows that node, highlighted, with the exec wires that led to it. **Resume** (F5), **Step Over** (F10), **Step Into** (F11, into function and macro graphs) and **Step Out** move on node by node.
- While paused, **hovering a pin** shows its current value, and **Watch this value** (pin menu) keeps a value bubble on the pin.
- The **Blueprint Debugger** lists the call stack in graph terms (graph and node names) and the watched values; clicking a frame shows its node.
- During execution, exec wires **pulse** to show the flow.

Shortcut sources are in [unreal-conventions.md](unreal-conventions.md). Unreal steps out with Alt+Shift+F11; we also accept VS Code's Shift+F11.

## Breakpoints

- Stored per workspace (VS Code's workspace state), keyed by the graph file, graph id and node id, with an enabled flag. Toggling a breakpoint never changes the `.vgraph` file, so it never shows as an unsaved change or a diff.
- The editor draws them on nodes and offers them in the node menu (Add Breakpoint, Remove Breakpoint, Disable/Enable Breakpoint); Ctrl+Shift+F9 removes all of the file's breakpoints.
- Breakpoints on nodes that don't run on their own (pure nodes, which run where their values are read) stop when the node that reads them runs, as in Unreal.
- For generated-code debugging, each graph breakpoint is mirrored as a VS Code breakpoint on its node's first line in the generated file (`GeneratedCode.nodeLines`), updated whenever the file is compiled. They appear in VS Code's Breakpoints view too.

## Debugging in Simulate

- The reference interpreter (src/core/runtime.ts) stays synchronous. It gains a debug hook, called before each node runs with the node, its graph and file, and the call stack in graph terms (function, event and macro frames). The hook may block.
- The extension runs a debug Simulate in a worker thread. When the hook decides to pause (an enabled breakpoint, or a step that has arrived), the worker posts "paused" with the location and stack, then blocks on `Atomics.wait`. Commands from the editor (continue, step over/into/out, stop, read a value) arrive as messages; the editor wakes the worker with `Atomics.notify`, and the worker takes the message with `receiveMessageOnPort`. Reading a value answers right away and blocks again; the others resume. The interpreter needs no async rewrite.
- **Stepping** is by node: Step Into pauses at the next node that runs anywhere; Step Over at the next node at the same call depth or shallower (a function call runs to its end); Step Out at the next node shallower than now.
- **Values**: an output pin's value is the one the node stored (impure nodes) or is computed on demand (pure nodes, evaluated as reading them would, without running anything impure); an input pin shows the value it would read; variables and function inputs are read from the frame. A pin is read in the innermost frame of the call stack that runs its graph; a graph not on the stack has no values, and an impure node that hasn't run yet says so. Reading never pauses, prints or reports errors: a pure function evaluated for a value runs quietly, and an error becomes the bubble's text. Text values are shown in quotes.
- **Watch this value** (pin menu) is kept per workspace like breakpoints. At each pause the editor reads every watched pin and shows its value in a bubble over the pin; the values stay while running, as in Unreal, and go when the run ends.
- Simulate's normal Run stays as it is (in the extension host, no worker); Simulate with enabled breakpoints anywhere in the workspace uses the worker. Breakpoints changed during the run apply at the next node.
- The nodes of one macro use run as one node: the debugger shows the macro's node and Step Over/Into move past its insides (Unreal steps into macro graphs; that waits for the macro graph to be shown with the values of one use).
- While paused, the editor shows a **Blueprint Debugger** panel under the graph: the node it stopped at, Resume, Step Over, Step Into, Step Out and Stop, and the call stack (clicking a frame shows its node, opening its file if it is another one). The paused node gets Unreal's arrow and a highlight; the editor opens the graph, and the file, it stopped in.
- F5, F10, F11, Shift+F11 (and Alt+Shift+F11) and Shift+F5 are VS Code keybindings that apply only while a graph editor has focus and the debugger is paused (Shift+F5: running), so they never reach VS Code's own debugger or full-screen toggle.

## Debugging generated code (DAP)

- **Debug** (toolbar, and F5 in the graph editor) compiles, then starts a VS Code debug session with the language's debugger, launching the same entry Run uses (Start, then Main, then latent actions):
  - TypeScript and JavaScript: js-debug (`node`, built into VS Code), with Run's resolve hook for TypeScript imports.
  - Python: debugpy (`debugpy`, from the Python extension).
  - C#: coreclr (from the C# extension), after `dotnet build` of Run's scaffold project.
  When the language's debugger isn't installed, the editor says which extension to install.
- **Where execution is**: a debug adapter tracker watches the session's `stopped` events; the extension asks for the stack (`stackTrace`) and maps each frame's file and line back to a graph node through the generated file's `nodeLines` (the node whose code contains the line). The editor highlights the top frame's node; the call stack lists graph frames (frames in other code are shown, dimmed, by their own names).
- **Stepping by node**: Step Over/Into/Out in the graph editor send DAP `next`/`stepIn`/`stepOut` repeatedly until the location maps to a different node (or leaves generated code), so one step moves one node, never one generated line. VS Code's own stepping keeps working on lines.
- **Values**: each generator reports, per stored pin (an impure node's output slot, a variable, a function input), the expression that reads it in a paused frame (`GeneratedCode.pinExpressions`). Hovering a pin sends DAP `evaluate` with that expression in the top frame of the node's method; a pure node's value isn't stored, and the bubble says so rather than running it.
- **Pulses** come from Simulate's events; generated code doesn't report each node as it runs (that would slow it down), so pulses show only in Simulate.

## Exec wire pulses

- During a Simulate run, each exec wire a node leaves through gets a short animated pulse, as Unreal animates them; the run trail (nodes that ran) stays as it is today. The runtime names the wire each node was entered through (`connectionId` on `node.enter`), and the editor draws a bright dash running along it for 0.7 s (an SVG path over the wire, redrawn with its elapsed time when the wires are redrawn). A normal Simulate runs in one burst, so its wires pulse together; under the debugger they pulse as execution reaches them. With reduced motion requested, there are no pulses.

## Test Case (moved from Phase 4)

- A **Test Case** event (with a name) and **Assert** nodes (Assert True, Assert Equal) make a graph's tests. Each language pack writes them to a separate generated test file (`node:test`, `unittest`; C# when the project references xUnit) so a normal Run doesn't run them, and a **Run Tests** command runs them and reports each test in the Output panel. Simulate runs them too.

## Exit check

In each of TypeScript, Python and C#: set a breakpoint on a node in a function graph, Debug, stop there with the node highlighted and the call stack shown in graph terms, read a pin's value by hovering, step into and out of a function graph, and continue to the end, all without opening a generated file. Simulate does the same without a toolchain. The TypeScript path runs in the integration suite (js-debug is built into VS Code); Python and C# need their debugger extensions, so they are checked by hand and their launch configurations by unit tests.
