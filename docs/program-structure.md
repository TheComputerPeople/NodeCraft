# Program structure

Phase 4 of the [roadmap](roadmap.md): the rest of Blueprint's authoring concepts, so that a real program (classes, functions, events, async) can be built entirely in graphs and run from generated TypeScript, Python and C#. This document records the design decisions for each feature: the Unreal behavior copied, how it maps to each language, and how Simulate runs it. [semantics.md](semantics.md) gains the execution rules as each feature lands.

Each feature is implemented for every language pack at once, so C# comes first: once it generates today's graphs, every later feature is built and tested in four targets (TypeScript, JavaScript, Python, C#).

## C# language pack

- **Generated file:** `Name.vgraph.cs` next to the graph, one class per graph, in a namespace taken from the nearest `.csproj`'s `RootNamespace` (else its file name) plus the folders below it, as Visual Studio does. SDK-style projects compile every `.cs` file, so placement needs no registration (docs/output-placement.md).
- **Types:** `bool`, `int` (C# `int`, 32-bit, as Unreal's `int32`), `float` (C# `double`, as Unreal 5's float pins), `string`, arrays as `List<T>`, sets as `HashSet<T>`, maps as `Dictionary<K, V>`, `any` as `object?`. Nullable reference types are enabled.
- **Values print** with the same rules as everywhere else (semantics.md, "Values"), through a generated formatting helper, since C#'s `double.ToString()` differs from JavaScript's.
- **Run:** a project needs no setup. Run builds a small console project the extension owns (under the operating system's temporary folder) that includes the generated file and the project's own `.cs` files, then calls `Start()`. In a project with a `.csproj`, Run uses the project's references.
- **Your code as nodes:** public static methods of public classes, marked with `/// @blueprint` in their XML documentation comment (C# has no free functions; instance methods come with classes, below). A scanner in `src/core` reads them, as for TypeScript and Python.
- **Simulate** runs C# graphs' JavaScript snippets, as for Python; C# code runs through Run.

## Flow control

Unreal's standard macros, as built-in nodes with Unreal's pins:

| Node | Behavior |
|---|---|
| For Loop | Runs Loop Body for each Index from First Index to Last Index (both included), then Completed. |
| For Loop with Break | The same; running its Break input stops the loop after the current Loop Body. |
| While Loop | Runs Loop Body while Condition (read before each pass) is true, then Completed. |
| For Each Loop (with Break) | Loop Body for each Array Element and Array Index, then Completed. Arrives with containers. |
| Do Once | Runs Completed the first time; again only after Reset. Start Closed starts it closed. |
| Do N | Runs Exit, counting in Counter, the first N times; Reset starts over. |
| Gate | Exit runs Enter only while open; Open, Close and Toggle change it; Start Closed. |
| MultiGate | Each Enter runs the next output (Out 0, Out 1, …); Is Random and Loop as in Unreal; Reset. |
| Flip Flop | Alternates A and B, starting with A; Is A tells which ran. |
| Switch on Int / String | Runs the output whose case equals Selection, else Default. Cases are added on the node, like Sequence pins. |

- Exec wires still may not loop back; loops come only from loop nodes, as in Unreal.
- A node's remembered state (Do Once's closed flag, Gate's open flag, Do N's counter, Flip Flop's side, MultiGate's position) belongs to the object in event graphs and lasts across events. In a function it is local to each call, as Unreal's macros are inside functions.
- **Infinite loops:** Simulate stops a loop after 1,000,000 passes with an error, as Unreal's editor does. Generated code has no limit.
- Hold-key placement for the new nodes, as in Unreal: F For Each Loop, G Gate, M MultiGate, N Do N, O Do Once (D Delay arrives with latent actions).

## Containers

- Arrays, sets and maps get real values: defaults in Details, **Make Array**, **Make Set** and **Make Map** with add-pin buttons, and Unreal's array, set and map functions (Length, Get, Set Array Elem, Add, Add Unique, Insert, Remove Index, Remove Item, Find, Contains, Clear, Last Index, Is Valid Index, Keys, Values, Find (map), Add (map)…).
- **Wildcard pins** adopt the type of the first wire connected to them, as in Unreal, and drop it when all their wires are gone. The node resolver gives wildcard nodes their adopted type, so everything downstream (editor, compiler, Simulate) agrees.
- Containers are reference values, as in Unreal: getting an array variable and adding to it changes the variable. Printing a container shows compact JSON (semantics.md, "Values").
- Get on an index out of range is an error that stops the run (Unreal returns a default and logs; an error is easier to find and is what each target language does anyway).

## Functions

- A **function graph** has one entry node (exec out, plus an output pin per input) and any number of **Return Nodes** (exec in, plus an input pin per output), as in Unreal. The signature is edited in Details: inputs, outputs, pure, description, category, and local variables.
- Placing a function: drag it from My Blueprint, or pick it from the action menu (its category). The call node takes the function's name and pins; renaming the function or changing its signature updates every call node (wires on removed pins are dropped, as Refresh Node does).
- Reaching the end of a function without a Return Node returns the outputs' defaults. Recursion works.
- **Local variables** start at their default on every call.
- **Pure functions** have no exec pins on their call nodes and are called wherever their outputs are used (semantics.md, "Data flow"); their own graph still runs from entry to return.
- **Generated code:** a method per function. One output is the return value; several outputs return an object with a field per output (TypeScript), a tuple (Python) or a named tuple (C#).
- **Function libraries** (`kind: functionLibrary`) generate a module of free functions (TypeScript, Python) or a static class (C#). Their functions appear in the palette of every graph in the same language, and generated code imports them, as it imports project functions.
- **Collapse to Function** (node menu) moves the selected nodes into a new function, with inputs and outputs for the wires that crossed the selection, and calls it in their place, as Unreal does.

## Macros

- A **macro graph** has an Inputs tunnel and an Outputs tunnel with any number of exec and data pins (several exec outputs are what makes macros useful, as Unreal's flow-control macros show).
- Macros are **expanded inline** where they are used, at compile time and in Simulate; there is no macro method in generated code. Each use is a separate copy, so state nodes inside a macro (Do Once…) are separate per use.
- A macro may not use itself, directly or through other macros (a compile error).
- **Macro libraries** (`kind: macroLibrary`) work like function libraries, but their macros are expanded where used, so nothing is imported.
- **Collapse to Macro**, as Collapse to Function.

## Structs and enums

- Two more `.vgraph` kinds, as Unreal's assets: **`structure`** (named fields with types and defaults) and **`enumeration`** (named values). They open in a field or value list editor rather than a graph.
- They are workspace types: `struct:<Name>` and `enum:<Name>` pin types refer to them by name, the type pickers list them, and generated code imports them from their own generated file.
- Structs are values (copied on assignment), as in Unreal: generated as a class with a copy on assignment in TypeScript, a dataclass in Python and a `record struct` in C#.
- Nodes: **Make** and **Break** for each struct, **Set Members** (Unreal's "Set Members in"), **split struct pins** (right-click a struct pin → Split Struct Pin, and Recombine), and for enums **Switch on**, **==**, and **To String** (the value's name).
- Enum values are generated as the language's enum (TypeScript string enum, Python `enum.Enum`, C# `enum`).

## Custom events and event dispatchers

- **Custom Event** nodes in event graphs, with parameters edited in Details, called by **Call Custom Event** nodes. Each becomes a method in generated code.
- **Event Dispatchers** are declared in My Blueprint with a signature. Nodes, as in Unreal: **Call** (broadcast to every bound event), **Bind Event to**, **Unbind Event from**, **Unbind All Events from**, and **Assign** (binds a new Custom Event in one step). The red event pin on a Custom Event connects to Bind.
- Bound events run in the order they were bound. Binding the same event twice binds it once.
- Generated as a list of callbacks with `bind`, `unbind`, `clear` and `broadcast`, in a small helper each target already has the pieces for (TypeScript arrays of functions, Python lists, C# `event Action<…>`).

## Classes

- Every `kind: class` graph is a class: its variables, functions, custom events and dispatchers are members; Start is its constructor-time entry (`start()`).
- **Object references:** `object:<Class>` pins. **Construct Object** (Unreal's "Construct Object from Class") creates an instance of a graph class; **Self** refers to the object the graph belongs to.
- **Target pins:** calling a function, getting or setting a variable, binding a dispatcher or calling a custom event on another object uses the node's Target pin, as in Unreal; unconnected Target means Self.
- **Inheritance:** a class graph may extend another class graph, or a class from the project's code (its public methods marked `@blueprint` become nodes with a Target pin, completing Phase 3's deferral). Functions can be **overridden**; the overriding graph can call the **Parent** function.
- **Interfaces:** an `interface` `.vgraph` kind declares function signatures; classes implement them in their class settings. **Cast To** a class or interface has Cast Succeeded and Cast Failed exec outputs and the cast object as output, as in Unreal; a pure version is available too.
- **Visibility:** variables and functions are public, protected or private, as in Unreal's Details; generated code uses the language's spelling (Python's leading underscore).

## Latent actions

- **Delay** (Duration in seconds) and **Retriggerable Delay**, with Unreal's rules: while a Delay is pending, running it again does nothing; a Retriggerable Delay restarts its countdown. More latent nodes follow the same model (Delay Until Next Tick, and Phase 3's async project functions as latent nodes, with **Completed** exec outputs).
- As in Unreal, latent nodes are allowed in event graphs (and in macros used there), not in functions.
- **Generated code:** every event that can reach a latent node becomes an `async` method (TypeScript `async`/`await` with a timer, Python `asyncio`, C# `async Task` with `Task.Delay`). `start()` runs the Start events and the program ends when every pending latent action has finished.
- **Simulate** runs latent actions on a virtual clock: a Delay doesn't wait in real time, and pending actions resume in order of their due time (ties in the order they were scheduled). Generated code waits in real time, which gives the same order when the delays differ; graphs that rely on two delays of the same length finishing in a particular order are not portable, and the documentation says so.

## Entry points and framework packs

- Language packs add entry-point events beyond Start: **Main** (the program's entry point, with command-line arguments) and **Test Case** (generated as a test in the language's standard framework: `node:test`, `unittest`, xUnit), so graphs can be tests.
- **Framework packs** add domain events and nodes as node libraries with event definitions (for example an HTTP request handler or a CLI command). The format is defined and one example pack ships; more come with demand.

## Exit check

A sample program built only in graphs exercises classes, inheritance, functions with several outputs, a macro, a struct, an enum, a loop, an event dispatcher and a Delay, and prints the same output from generated TypeScript, Python and C# (and Simulate). It joins the conformance suite.
