# Simulate, with breakpoints

**Simulate** runs the graph inside the editor, with no toolchain. Set a breakpoint first:

| Key | What it does |
|---|---|
| F9 | Toggle a breakpoint on the selected nodes |
| F10 | Step over, to the next node |
| F11 / Shift+F11 | Step into a function / out of it |
| F5 | Go on, to the next breakpoint |
| Shift+F5 | Stop |

While it's paused, hover a pin to see its value, or pick **Watch this value** in the pin's menu. The
Blueprint Debugger panel shows the call stack in graph terms.

Simulate runs the editor's own nodes. Graphs that call your code run with Run and Debug.
