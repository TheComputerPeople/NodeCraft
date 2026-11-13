# Coming from Unreal

If you know Unreal Engine's Blueprints, you already know most of this editor. The gestures,
shortcuts, pin colors and node styles are Unreal's; [unreal-conventions.md](unreal-conventions.md)
lists them. This page is about the concepts: what each part of Unreal's Blueprints is here, what
works differently, and what doesn't apply, since there's no engine.

## The big difference

An Unreal Blueprint runs inside the engine: the Blueprint compiler makes bytecode, and the
Blueprint VM runs it next to the engine's C++.

Here a graph compiles to readable source code in your project's language, written next to the graph
and committed with it. Your project's own toolchain builds and runs that code, and teammates without
the extension build it like any other source. There's no engine, so there's no world, no actors and
no game loop. A graph is a class, a library or a type in an ordinary program.

| Unreal | Here |
|---|---|
| The Blueprint compiler and its bytecode | **Compile** (F7): the graph becomes source code in TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, Lua, GDScript, Ruby or PHP |
| The Blueprint VM | The language's own toolchain: Node.js, Python, .NET, Cargo, a JDK, Go, Lua, Godot, Ruby, PHP |
| Play In Editor | **Run** runs the generated code. **Simulate** runs the graph's built-in nodes inside the editor, without a toolchain. |
| The engine's C++, with reflection | Your project's code: what you mark `@blueprint` becomes a node ([below](#c-and-blueprints-your-code-and-graphs)) |
| A project's `.uproject` and its plugins | Your project as it is (`package.json`, `pyproject.toml`, `Cargo.toml`, ...), and Blueprint packages |
| Blueprint nativization | What always happens: the generated code is the program |

## Assets

**NodeCraft: New Graph** offers the same assets as Unreal's Content Browser. Each one
is a `.vgraph` file.

| Unreal asset | Here |
|---|---|
| Blueprint Class | **Blueprint Class**: a class with an event graph, functions, macros, variables and event dispatchers |
| Blueprint Function Library | **Blueprint Function Library**: functions any graph in its languages can call; a library can be generated for several languages |
| Blueprint Macro Library | **Blueprint Macro Library** |
| Blueprint Interface | **Blueprint Interface** |
| Structure | **Structure**: fields edited in a list, with Make, Break and Set Members nodes |
| Enumeration | **Enumeration**: values edited in a list, with Switch on, == and != nodes |
| Level Blueprint | Doesn't apply: there are no levels. A program starts from a graph's Main event, or from your own code. |
| Data Asset, Data Table | Don't apply. Use a Structure for the shape, and your own code (or Load File to String) for the data. |
| Plugins | **Blueprint packages**: node files and library graphs with a name, a version and dependencies, added with **NodeCraft: Add Blueprint Package...** from a folder, an extension or npm |

## The editor

| Unreal | Here |
|---|---|
| My Blueprint | **My Blueprint**: graphs, functions, macros, variables, local variables and event dispatchers |
| Details | **Details**: the selected node, variable, function or pin |
| Class Settings and Class Defaults | **Class Settings**, shown in Details when nothing is selected in an event graph: Parent Class and Implemented Interfaces. Variables' defaults are set on each variable. |
| Graph tabs, with Back and Forward | The same, above the graph |
| The Palette | The palette on the left, and the Add Node menu on a right-click, with **Context Sensitive** |
| Compile and Compiler Results | **Compile** (F7) and **Compiler Results**. Problems also appear in VS Code's Problems panel. |
| Find in Blueprint / Find in All Blueprints | Ctrl+F / Ctrl+Shift+F (**NodeCraft: Find in All Blueprints**) |
| Reference Viewer | **NodeCraft: Show Codebase Map**: the code and graphs of the whole workspace |
| Save, Undo and Redo | VS Code's: a `.vgraph` file is a text document, so source control and diffs work as usual |
| Blueprint Diff | Your source control's diff, of the `.vgraph` file or of its generated code |

## Events and entry points

| Unreal | Here |
|---|---|
| Event BeginPlay | **Start**: it runs when the object is made (Construct), as BeginPlay runs when an actor is spawned. Hold P and click to place one, as in Unreal. |
| Construction Script | **Start** too. Nothing runs in the editor, so there's no separate editor-time script. |
| Event Tick | Doesn't apply: there's no game loop. A **Delay** whose Completed leads back to it repeats on a timer, and a framework pack can give its own events. |
| Input events | A framework pack's events, such as a command-line tool's commands. Graphs have no input system of their own. |
| (No Unreal counterpart) | **Main**: the program's entry point. Run calls it after Start, with the command-line arguments as its Args. |
| Custom Event | **Custom Event**, called with **Call Event** |
| Event Dispatchers | **Event Dispatchers**: Call, Bind Event to, Unbind Event from, Unbind all Events from |
| Functional tests, Automation | **Test Case** events, with **Assert True** and **Assert Equal**. **Run Tests** runs them in the language; **Simulate Tests** runs them in the editor. |

## Nodes

Unreal's standard library is here under the same names, where the meaning is the same in every
language. Where a name differs, this table gives it.

| Unreal | Here |
|---|---|
| Branch, Sequence, For Loop, For Each Loop, While Loop, Do Once, Do N, Gate, MultiGate, Flip Flop | **Branch**, **Sequence**, **For Loop**, **For Each Loop**, **While Loop**, **Do Once**, **Do N**, **Gate**, **MultiGate**, **Flip Flop**, also with **For Loop with Break** and **For Each Loop with Break** |
| Switch on Int, Switch on String, Switch on (an enum) | **Switch on Int**, **Switch on String**, and **Switch on** each enumeration |
| Delay, Retriggerable Delay | **Delay**, **Retriggerable Delay** |
| Print String | **Print**: its text goes to the Output panel. There's no screen to print on. |
| Format Text | **Format String** |
| Append (string) | **Append** |
| Select | **Select** |
| Is Valid | **Is Valid** |
| Make Array, Make Set, Make Map | **Make Array**, **Make Set**, **Make Map** |
| Make Literal | An unconnected input's own value, typed on the node |
| Construct Object from Class, Spawn Actor from Class | **Construct**, one for each class: it makes the object and runs its Start. It takes the arguments of a parent class from your code. |
| Get, Set (variables) | **Get Variable**, **Set Variable**: Ctrl-drag and Alt-drag the variable, as in Unreal |
| Cast To | **Cast To** each class and interface, with Cast Succeeded and Cast Failed |
| Get Display Name | Doesn't apply. Printing an object is a compile error, as it would need a name the object doesn't have. |
| Timeline | Doesn't apply: it's driven by the engine's tick. **Delay** and **Lerp** cover simple cases. |
| Set Timer by Event | A **Delay** loop, or your language's timers through your code |

Math, strings, arrays, sets, maps, random numbers and trigonometry have Unreal's nodes. There are
two differences in arrays ([semantics.md](semantics.md)):

- Add, Insert and Remove change the array, as in Unreal, but Reverse, Shuffle and the other functions
  that rearrange one return a new array.
- An index out of range stops the run with an error. Unreal returns a default and logs a warning.

Each language also has its standard library's own nodes (regular expressions, hashes), and the
Language menu shows the editor in that language's terms.

## Variables and types

| Unreal | Here |
|---|---|
| Boolean, Integer, Float | `bool`, `int`, `float`. A float wired into an int is truncated toward zero, as Unreal converts it. |
| Integer64, Byte | `int`. How large it can be is the language's: 32 bits in C#, as Unreal's Integer, and a double in TypeScript and JavaScript ([semantics.md](semantics.md)). |
| String, Name, Text | `string` |
| Vector, Rotator, Transform | Don't come built in. Make a Structure for the ones you need, or use your own code's types. |
| Object reference | A class's type, such as `object:Report` |
| Class reference, soft references | Don't apply: classes aren't loaded at run time, and there are no assets to load |
| Arrays, Sets, Maps | The same, with Unreal's functions |
| Instance Editable, Expose on Spawn | Not here yet. Set a variable after Construct, with a **Set Variable** node on the new object. |
| Private, Access Specifier | **Access**: Public, Protected or Private |
| Local variables | The same, in functions |

## Functions, macros and classes

- **Functions and macros** work as in Unreal:
  - a function has a Function Entry and a Return Node, and can be pure, recursive and called on
    another object;
  - a macro is expanded where it's used;
  - Collapse to Function and Collapse to Macro work as in Unreal.
  - Collapse Nodes into a collapsed graph doesn't: collapse to a function or a macro instead.
- **Latent nodes** belong in event graphs, as in Unreal: a function runs to its end at once.
- **Inheritance:**
  - Parent Class is in Class Settings;
  - My Blueprint's **Override** makes a function, wired to a **Parent** call;
  - functions are virtual, as in Unreal.
- **Interfaces:** they're implemented in Class Settings and called with **Interface Call** nodes.
  A function a class doesn't implement does nothing and returns defaults.
- **Self**, **Target** pins and "Accessed None" work as in Unreal: an unconnected Target is Self,
  and an empty one stops the run with an error.

## C++ and Blueprints: your code and graphs

Unreal exposes C++ to Blueprints with reflection macros. Here the documentation comment of a
function, class or property says the same thing, in each of the twelve languages
([code-as-nodes.md](code-as-nodes.md)).

| Unreal | Here |
|---|---|
| `UFUNCTION(BlueprintCallable)` | `@blueprint` |
| `UFUNCTION(BlueprintPure)` | `@blueprint pure` |
| `UPROPERTY(BlueprintReadWrite)` | `@blueprint` on a property: Get and Set nodes with a Target pin |
| `UCLASS(Blueprintable)` | `@blueprint` on a class: a graph's Parent Class can be it |
| `BlueprintNativeEvent` | `@blueprint overridable` on a method |
| `BlueprintImplementableEvent` | An abstract method |
| `Category`, `DisplayName`, `Keywords`, `CompactNodeTitle`, `AdvancedDisplay`, `ExpandEnumAsExecs` | `@category`, `@displayName`, `@keywords`, `@compactTitle`, `@advanced`, `@execs` |
| `DeprecatedFunction` | `@deprecated`, or the language's own marker (`[Obsolete]`, `#[deprecated]`) |
| Latent actions (`FLatentActionInfo`, async action nodes) | Async functions: a latent node whose Completed runs when the function finishes |
| Out parameters | Out parameters, tuples and records: a node with several outputs |
| Refresh Nodes after the C++ changes | **Refresh Node**, and **NodeCraft: Refresh All Nodes** |

**NodeCraft: Expose Functions as Nodes...** marks the functions you pick in a file.
Generated code imports your code the way the project does, and your code uses a graph's class like
any other.

## Debugging

| Unreal | Here |
|---|---|
| Breakpoints (F9), stepping | The same keys, in Simulate and under each language's own debugger (**Debug**, F5) |
| Watch this value, hovering a pin | The same |
| Execution flow highlighting | Shown in Simulate |
| The Blueprint Debugger's call stack | The Blueprint Debugger panel, in graph terms |
| Print String's on-screen messages | The Output panel |

## What doesn't apply

These are engine features. A graph here is part of an ordinary program, so they have no equivalent.
Where there's something to use instead, it's listed.

- **Actors, Components, levels and the world:** use classes, and Construct their objects.
- **Event Tick and the game loop:** use a Delay loop, or a framework pack's events.
- **Timelines, animation, materials, widgets (UMG), sound and physics.**
- **Game Mode, Pawns, Controllers, Player State and input:** use your code or a framework pack.
- **Replication and networking:** use your language's libraries, through your code.
- **Save Game objects:** use **Save String to File** and **Load File to String**, or your code.
- **Hot reload and Live Coding:** a graph compiles when it's saved, and Run uses the latest code.
- **Bookmarks, Favorites in the palette, Validated Get and pure Cast:** not here yet.
