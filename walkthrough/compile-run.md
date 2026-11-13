# Compile and Run

**Compile** (F7) turns the graph into source code next to it, in the project's style. Commit the code
with the graph: teammates build it without the extension.

| Graph | Generated |
|---|---|
| `Main.vgraph` in TypeScript | `Main.vgraph.ts` |
| `Main.vgraph` in Python | `main_vgraph.py` |
| `Main.vgraph` in C# | `Main.vgraph.cs` |

Saving a graph compiles it too.

**Run** runs the generated code with the language's own toolchain (Node.js, Python, .NET, Cargo, a
JDK, Go, ...) and shows what it prints in the **Blueprint Visual Scripting** output. Problems show on
the nodes, in **Compiler Results** and in the Problems panel.
