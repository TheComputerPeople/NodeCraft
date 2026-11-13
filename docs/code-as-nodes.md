# Your code as nodes

Phase 3 of the [roadmap](roadmap.md): the equivalent of Unreal's `UFUNCTION(BlueprintCallable)`. Functions written by hand in the project appear in the palette as nodes, graphs call them, and the generated code imports them. This document is the design; [unreal-conventions.md](unreal-conventions.md) covers how the nodes look and behave in the editor.

## Exposing a function

As in Unreal, a function becomes a node only when its author says so, so the palette isn't flooded with every helper in the project. The marker is a `@blueprint` tag in the function's documentation comment: JSDoc in TypeScript and JavaScript, the docstring in Python, and the `///` XML documentation comment in C# (where the marked functions are `public` or `internal` static methods; see [program-structure.md](program-structure.md)). A comment costs nothing at run time and needs no package, so code with markers runs and builds exactly as before.

```ts
/**
 * Doubles a number.
 * @blueprint pure
 * @category Math|Scaling
 */
export function double(value: number): number {
  return value * 2;
}
```

```python
def apply_damage(health: float, amount: float = 10) -> float:
    """Subtracts damage from health, never going below zero.

    @blueprint
    @category Combat
    """
    return max(0.0, health - amount)
```

| Tag | Unreal equivalent | Effect |
|---|---|---|
| `@blueprint` | `BlueprintCallable` | A node with exec pins: it runs when execution reaches it. |
| `@blueprint pure` | `BlueprintPure` | A node without exec pins, evaluated wherever its output is used ([semantics.md](semantics.md), "Data flow"). |
| `@category A\|B` | `Category = "A\|B"` | Palette category; `\|` nests. Default: the module's file name, under "Project". |
| `@displayName Text` | `meta = (DisplayName = "Text")` | Node title. Default: the function name in words, as Unreal shows it (`applyDamage` and `apply_damage` both become "Apply Damage"). |
| `@keywords a b` | `meta = (Keywords = "a b")` | Extra words the action menu matches. |
| `@compactTitle +` | `meta = (CompactNodeTitle = "+")` | Drawn without a title bar, the text large in the middle, as operators are. |
| `@deprecated message` | `meta = (DeprecatedFunction, DeprecationMessage = "…")` | Left out of the action menu; nodes already placed show a warning with the message and compile with it. Each language's own marker counts too (see below). |
| `@advanced a b` | `meta = (AdvancedDisplay = "a, b")` | Those inputs fold under the node's arrow until it's opened, or they're wired or set. |
| `@pinName a Text` | `UPARAM(DisplayName = "Text")` | The pin's name on the node; `returnValue` (or an output's name) for outputs. |
| `@execs` | `meta = (ExpandBoolAsExecs = "ReturnValue")`, `ExpandEnumAsExecs` | A function returning a bool gets True and False exec outputs in place of Return Value, as if a Branch followed it. One returning a graph enum gets an exec output per value, as if a Switch followed it. |

The rest of the comment becomes the node's description (its tooltip). `@param name text` describes a pin.

**Deprecation markers.** A function, method or property is deprecated by the `@deprecated` tag, or by its language's own marker:

| Language | Marker | Message |
|---|---|---|
| TypeScript, JavaScript, PHP, Ruby, Lua, GDScript | `@deprecated` in the documentation (JSDoc, PHPDoc, YARD, LuaLS, Godot) | the tag's text |
| PHP 8.4 | `#[\Deprecated]` or `#[\Deprecated(message: "…")]` | its message |
| C# | `[Obsolete]` or `[Obsolete("…")]` | its message |
| C++ | `[[deprecated]]` or `[[deprecated("…")]]` | its message |
| Rust | `#[deprecated]`, `#[deprecated = "…"]` or `#[deprecated(note = "…")]` | its note |
| Java | `@Deprecated` | Javadoc's `@deprecated` text |
| Python | PEP 702's `@deprecated("…")` (`warnings` or `typing_extensions`) | its message |
| Go | a `Deprecated:` paragraph in the doc comment, before `@blueprint` | the paragraph |

**Generic functions.** A generic function's type parameters are wildcard pins, gray until a wire is connected, as Unreal's wildcard nodes are. The first wire gives each its type, and generated code leaves the language to infer it.

```ts
/** @blueprint */
export function first<T>(items: T[]): T {
  return items[0];
}
```

This covers TypeScript's `<T>`, JSDoc's `@template T`, Python's `def f[T]` and module TypeVars, C#'s and Java's generic methods, and Rust's `<T>` (bounds and lifetimes are ignored). A function may have two type parameters: there are two kinds of wildcard pin. A node whose wildcards have no wire doesn't compile, and says to connect one.

**Graph types in code.** Code can use the structs and enums of the workspace's graph files through the types they generate (`Mood` from `Mood.vgraph`, imported from its generated file). A parameter or result of such a type gets the graph's struct or enum pin, so it connects to the graph's own nodes. The type has to be generated for the code's language. This is how `@execs` gets an enum's values.

The setting `nodecraft.exposeAllFunctions` exposes every public function as a callable node, for small projects where marking each one is a chore. Public is each language's rule: exported (TypeScript, JavaScript), not `_`-prefixed (Python, GDScript, Ruby), `public static` (C#, Java, PHP), `pub` (Rust), capitalized (Go), declared in a header (C++), in the module's table (Lua). Private functions aren't reported. Class members still need their marker. Markers still choose `pure`, category and title.

**Feedback in the code.** A marked function that can't be a node gets a warning on its declaration, in the Problems panel too: "Not a Blueprint node: rest parameters can't be pins". On a function, method, constructor or property that could be one, the lightbulb offers **Expose as Blueprint node** and **Expose as pure Blueprint node**. Each adds the marker to the documentation comment in the language's style (`/** … */`, `///`, `//`, `---`, `##`, `#`, a Python docstring), creating it when there is none. A Lua field is marked on its own `---@field` line. Go's declarations come from its language server's symbols.

**A whole file at once.** **Expose Functions as Nodes...** (a source file's menu in the Explorer, the editor's context menu, or the command palette on the active file) lists the file's functions, methods, constructors and properties that could be nodes but aren't, all picked, then asks for nodes or pure nodes. The markers go in as one edit, which opens in the Refactor Preview to apply or discard. It works on every language's files: TypeScript, JavaScript, Python, C#, C++ headers, Rust, Java, Go, Lua, GDScript, Ruby and PHP.

**C and C++ source files.** Generated C++ calls a function through the header that declares it, so on a `.c`, `.cpp`, `.cc` or `.cxx` file the command works through its header (the one beside it of its name: `.h`, `.hpp`, `.hh` or `.hxx`):

- a function the header declares is marked there;
- one it doesn't is declared there, marked, from its definition (`double area(double width, double height);`), in its namespace, before the header's closing `extern "C"` guard or its include guard's `#endif`;
- with no header, one is made: `#pragma once`, the standard headers its declarations name, and for a C file `extern "C"` guards, so C++ calls link to the C functions; the source then includes it;
- `static` functions (they belong to their file), `main` and a class's members defined outside it aren't offered.

**C functions from C++ graphs.** A header that a C file implements (a `.c` beside it, no C++ file) and that has no `extern "C"` of its own is included by generated C++ inside `extern "C" { … }`, and Run compiles the C file as C (`-x c`), so the calls link. The project's own build compiles it as the project says (CMake's `project(name C CXX)`).

## What becomes a node

- **Which functions:** exported top-level function declarations, and exported `const` arrow functions or function expressions, in TypeScript and JavaScript. Top-level `def` in Python. Members of classes: see [Classes](#classes).
- **Pins:** each parameter becomes an input pin, named in words like the title. A literal default value (number, string, boolean) becomes the pin's default. The return value becomes an output pin named "Return Value", as in Unreal; a function returning `void` or `None` has none. A function returning several values has an output for each: see [Several outputs](#several-outputs).
- **Types** map to canonical types ([semantics.md](semantics.md), "Values"):

| Canonical | TypeScript / JavaScript (JSDoc) | Python |
|---|---|---|
| `bool` | `boolean` | `bool` |
| `int` | (none; TypeScript has no integer type) | `int` |
| `float` | `number` | `float` |
| `string` | `string` | `str` |
| array of T | `T[]`, `Array<T>`, `readonly T[]` | `list[T]`, `List[T]`, `Sequence[T]` |
| set of T | `Set<T>` | `set[T]`, `Set[T]` |
| map of K to V | `Map<K, V>`, `Record<K, V>` | `dict[K, V]`, `Dict[K, V]`, `Mapping[K, V]` |
| `any` | `any`, `unknown`, no annotation | `Any`, `object`, no annotation |
| `native:<name>` | any other type, by its text | any other type, by its text |

  `T | null`, `T | undefined`, `Optional[T]` and `T | None` are T, nullable. A `native` type connects only to the same type (or `any`) and passes through untouched.
- **Async functions** are latent nodes: see [Async functions](#async-functions).
- **Not exposed, with the reason shown in the output channel:** generators (async ones too), rest parameters (`...args`, `*args`, `**kwargs`), destructured parameters, generic functions with more than two type parameters (and generic functions in C++, Go, Lua and PHP), TypeScript overloads, and marked TypeScript or JavaScript functions that aren't exported. Python keyword-only parameters with defaults are left off the node, so they keep their defaults; one without a default makes the function unexposable.

### How declarations are read

The roadmap planned to read TypeScript with the TypeScript compiler API and Python with its `ast` module. Neither fits: TypeScript 7's compiler API is unstable and runs a native binary, and `ast` means running a Python interpreter from the workspace, which Restricted Mode must not do. Instead, each language pack has a small declaration scanner in `src/core`, written in TypeScript. It reads only what a node needs (names, parameters, annotations, defaults and the documentation comment) and skips everything else by matching brackets. The tests check its results against the real tools: generated code that calls the imported functions must type-check under `tsc --strict` and run under Node.js and Python.

## Classes

A class's members become nodes too, each when its own documentation comment is marked, as Unreal's `BlueprintCallable` member functions and `BlueprintReadWrite` properties are ([node-authoring.md](node-authoring.md), gap 2):

| Member | Node | Unreal equivalent |
|---|---|---|
| Constructor | **Construct <Class>**, with exec pins and the object as Return Value | Construct Object from Class |
| Method | A node with a **Target** pin for the object, then the method's parameters | `UFUNCTION(BlueprintCallable)` on a member function |
| Property or field | **Get <Name>** (pure) and **Set <Name>**, each with a Target pin | `UPROPERTY(BlueprintReadWrite)` |
| Read-only property, or one marked `@blueprint readonly` | **Get <Name>** only | `UPROPERTY(BlueprintReadOnly)` |

- **What counts as a class member.**
  - TypeScript and JavaScript: an exported class's constructor, instance methods, fields and get/set accessors.
  - Python: `__init__`, methods, `@property` (with its setter, writable), and attributes annotated in the class body and documented by the string after them.
  - C#: a class's or record's public constructors, instance methods, properties and fields. Structs are left out: Set would change a copy.
  - C++: a class's or struct's public constructors (initializer lists included), member functions and data members (`const` ones read-only), in headers.
  - Java: a public class's public constructors, instance methods and fields (`final` ones read-only).
  - Rust: a `pub struct`'s `pub` fields, with its `impl` block's `pub` methods taking `&self` or `&mut self`, and its constructor (a function returning `Self`: a marked one, else `new`).
  - Go (through gopls): a struct's fields and its methods. Go has no constructors, so a struct's `New…` function, already a node, makes the objects; the Target pins take the pointer it returns (`*Counter`).
  - Lua: a table annotated `---@class` that the module's table reaches (`M.Counter = Counter`, or `return Counter`). Its `:` functions are methods, `.new` (or a function returning the class) its constructor, and the `---@field`s whose text says `@blueprint` its properties.
  - GDScript: a script with a `class_name`. Its non-static functions are methods, `_init` its constructor, and its `var`s properties. Its static functions stay functions.
  - Ruby: a class's `initialize`, public instance methods, and `attr_accessor` / `attr_reader` attributes (typed by `@return [Type]` above them). Methods after `private` or `protected` aren't public.
  - PHP: a class's `__construct`, public instance methods and public properties (`readonly` ones read-only).
  - Private members (and `_`-named ones in Python) and static members are reported instead. Async methods are latent nodes, as async functions are.
- **Types.** Objects travel on pins of the class's `native:` type, as functions returning the class already make them. A subclass's object connects where its base class is expected, when the subclass has a marked member (its nodes record the base). The default category is "Project / <Class>".
- **Generated code.** It imports the class and writes `new Player(…)` (`Player(…)` in Python), `target.heal(…)`, `target.health` and `target.health = …`. C# and Java pass such objects as `object`/`Object`, so they cast the Target to the class. C++ passes them in a `std::any`, as the object and as each class it extends (`vgraph::code_new<Player, Entity>(…)`), and `vgraph::code_object<Player>(target)` finds the object as the class it needs. Rust passes them as a `vgraph::Value` holding the object (`vgraph::code_new`), borrowed for each use (`vgraph::code_object::<Counter>(&target).borrow_mut().add(…)`). Go passes them as `any` and asserts the Target to the struct's pointer. An empty Target stops the run with the language's own null error (C++ and Rust: "Accessed None"), as Unreal stops on "Accessed None".
- **Languages.** All twelve. Lua, GDScript, Ruby and PHP are dynamic, so their objects need no help: generated code writes `Counter.new(…)`, `target:add(…)` (Lua), the preloaded script's `.new(…)` (GDScript), and `new \App\Counter(…)`, `$target->add(…)` (PHP).

## Several outputs

A function that gives back several values, in its language's way, has an output pin for each, as Unreal's out parameters do ([node-authoring.md](node-authoring.md), gap 3). The pins take the names the code gives the values. Where the code has none (a plain tuple), an `@outputs` tag in the documentation names them in order:

```python
def divide(a: int, b: int) -> tuple[int, int]:
    """@blueprint
    @outputs quotient remainder"""
    return a // b, a % b
```

| Language | Several outputs from |
|---|---|
| TypeScript, JavaScript | an object type (`{ quotient: number; remainder: number }`, or JSDoc's `@returns {{ quotient: number, remainder: number }}`), or a tuple, labeled (`[quotient: number, remainder: number]`) or with `@outputs` |
| Python | a `NamedTuple` class in the module, or `tuple[…]` with `@outputs` |
| C# | `out` parameters, or a tuple, named (`(int Quotient, int Remainder)`) or with `@outputs` |
| C++ | non-const reference parameters (`int& quotient`), or `std::tuple` / `std::pair` with `@outputs` |
| Rust | a tuple with `@outputs` |
| Java | a `record` declared in the same file: its components |
| Go (through gopls) | several results, named (`(quotient, remainder int)`) or with `@outputs`. A last `error` result isn't a pin: when it isn't nil, the run stops with its message |
| Lua | several `---@return type name` annotations (names, or `@outputs`) |
| Ruby | `@return [Array(Integer, Integer)]` with `@outputs` |
| PHP | parameters by reference (`int &$quotient`, after the others), or an array shape (`@return array{quotient: int, remainder: int}`, or `array{int, int}` with `@outputs`) |
| GDScript | none: Godot functions return one value |

- **Out parameters** follow the value the function returns, if any, which keeps its Return Value pin first. They aren't inputs.
- **Exec pins.** The node always has them, even when marked `@blueprint pure`, since the function runs once for all its outputs.
- **Generated code** reads each output from what the function gives back: it destructures the object, tuple or array, reads a record's accessors, or passes new variables for the out parameters and copies each to its output.
- **Not exposed:** C# `ref`, `in` and `params` parameters, PHP variadics, and a tuple with no names in the code and no `@outputs` (which stays one value of its native type, or, for Lua and Go, is reported).

## Async functions

A function that returns its language's future is a **latent node**, as Unreal's latent functions are ([node-authoring.md](node-authoring.md), gap 4):

```ts
/** @blueprint */
export async function fetchScore(player: string): Promise<number> {
  const response = await fetch(`https://example.com/score/${player}`);
  return Number(await response.text());
}
```

| Language | Latent when it |
|---|---|
| TypeScript, JavaScript | is `async`, or returns a `Promise<T>` (or JSDoc's `@returns {Promise<T>}`) |
| Python | is an `async def`, or returns `Awaitable[T]` or `Coroutine[…, …, T]` |
| C# | returns `Task` or `Task<T>` (not `async void` or `ValueTask`) |
| Java | returns `CompletableFuture<T>` or `CompletionStage<T>` |
| C++ | returns `std::future<T>` or `std::shared_future<T>` (in a header) |
| Rust | is an `async fn`, or returns `impl Future<Output = T>` or `Pin<Box<dyn Future<Output = T>>>` |
| Go (through gopls) | returns a channel, `<-chan T`: its value is the first the channel gives (`chan struct{}` gives none) |
| Lua | is marked `---@async` (LuaLS): it runs as a coroutine, resumed on each latent turn until it returns |
| PHP | returns a `Fiber` (PHP 8.1): resumed on each latent turn until it ends; its value is what it returns, typed by `@return Fiber<int>` |
| GDScript | awaits (a Godot coroutine): generated code awaits it while Godot's main loop runs |
| Ruby | returns a `Thread`, typed by YARD's `@return [Thread<Integer>]`: its value is the thread's |

- **The node.** A clock in the title marks it. Its exec output is **Completed**, which runs when the function finishes, and its Return Value is what the future gives (`T`). It always has exec pins, even when marked pure.
- **Order.** Calling it starts the function, and the chain after the node waits for Completed, while the rest of the graph goes on, as with Delay (a Sequence's next output runs). Completed runs from the latent queue, after the code that's running, so Unreal's ordering holds.
- **Failure.** A function that fails (throws, rejects, raises) stops the run with its error, and its Completed doesn't run.
- **From the project's code.** Run drives the latent queue after Start. Code of your own that runs such a class (or one with a Delay) drives it after `start()`: Python's generated module has `run_latent_actions()`, C#'s and Java's classes a static `RunLatentActions()` / `runLatentActions()`, C++'s and Rust's support module `vgraph::run_latent_actions()` and `vgraph_runtime::run_latent_actions()`, Go's graphs package `VgRunLatentActions()`, Lua's support module `require("vgraph_runtime").run_latent_actions()`, Ruby's `Vg.run_latent_actions`, PHP's `\Vgraph\Vg::runLatentActions()`, and GDScript's support script `await vg.run_latent_actions(get_tree())` (it lets the tree run frames while coroutines wait). TypeScript and JavaScript wait on the event loop and need nothing. The corpus's entry points call them (docs/project-integration.md, part 3).
- **Where.** In event graphs and the macros they use, as Delay: a function graph runs to its end at once, so a latent node there is a compile error.
- **Rust's executor.** Generated Rust polls futures with a small executor of its own, with no crates. A future that needs a reactor (tokio's I/O and timers) won't make progress there.
- **Cooperative ones.** Lua's coroutines and PHP's Fibers run only when the latent queue resumes them: they wait by yielding (`coroutine.yield()`, `Fiber::suspend()`), not in the background.
- **Ruby's threads** run in the background, as futures do elsewhere. Ruby has no standard future, and a Thread is the closest: the latent queue looks at it each turn, and once it has finished, `Thread#value` gives its value or raises its exception.

## Going to the code

Double-click a project function's node (or press F12, or pick **Go to Definition** in its menu) to open its code at the declaration, as Unreal opens a C++ node's source. **Find References** (Shift+F12) lists every node calling it, in every graph ([node-authoring.md](node-authoring.md), gap 5).

## Node identity

An imported function's node type is `fn:<language>:<path>#<name>`, for example `fn:typescript:src/combat.ts#applyDamage`. A class member's adds the member: `#Player:new` (Construct), `#Player:heal`, `#Player:get:health` and `#Player:set:health`. The path is relative to the workspace folder, with `/` separators. The language is that of the module: `typescript` for `.ts`, `.mts` and `.cts`, `javascript` for `.js`, `.mjs` and `.cjs`, and `python` for `.py`. TSX/JSX modules are left out for now.

A graph calls functions in its own language. A TypeScript graph may also call JavaScript modules, since TypeScript imports them directly. The palette shows only the functions a graph can call. The compiler reports the others.

## Generated imports

The generated file imports each module it calls, using the import spelling the project already uses:

- **TypeScript:** a relative specifier from the generated file. The extension follows the nearest `tsconfig.json`. `.ts` is used when `allowImportingTsExtensions` or `rewriteRelativeImportExtensions` is set, or when there is no `tsconfig.json`; that is Node.js's own convention for running TypeScript. Projects using `moduleResolution` `bundler` get no extension. Other projects get `.js`, the `node16`/`nodenext` convention. **Run** resolves each of these to the `.ts` file, so every project runs from the editor.
- **JavaScript:** a relative specifier with the module's real extension: `import` for ES modules, `require` for CommonJS (the project's module system, as in Phase 1).
- **Python:** an absolute import, `from combat import apply_damage` or `from game.combat import apply_damage`. The module's name is its path from its import root: the folder above the outermost package (a folder with `__init__.py`) that contains it, or the module's own folder when it isn't in a package. That root is where Python puts a script's folder on `sys.path`, so the import works when the project runs normally. **Run** adds the roots to `sys.path`.

Names that clash with the generated class or with each other are aliased (`import { double as double_1 }`, `from a import f as f_1`).

## Simulate

Simulate runs graphs inside the editor and can't run the project's own code, so a graph that reaches an imported function stops with an error that points to **Run**. Every other node, including the standard library nodes, still runs in Simulate.

## When the code changes

A node keeps the signature it was created with. The graph file stores the last known signature of each function it calls (`importedFunctions`, keyed by node type), as Unreal stores a node's pins with the node. So a graph still opens and shows its wires when the code has changed. When the code and the stored signature disagree:

| Change in code | Editor | Compiler |
|---|---|---|
| Parameter or return type changed, parameter added or removed | Warning badge on the node; **Refresh Node** in its context menu updates the pins, keeping wires whose pin still exists with a compatible type | Error until refreshed |
| Function renamed, or moved to another module | Error badge. When the module has exactly one new function with the same parameters and return type, or another module has a function with the same name and signature, the node menu offers **Replace with …** | Error naming the candidate |
| Function deleted, or no longer marked `@blueprint` | Error badge | Error |

**Refresh All Nodes** (Unreal's File menu command) refreshes every node in the graph file at once, and is a VS Code command.

## Standard library nodes

Each language's basics are available as built-in nodes with Unreal's names and categories, implemented in every language pack, so graphs stay portable between languages:

- **Math:** Subtract, Multiply, Divide, Modulo (%), Min, Max, Clamp, Abs, Round, Floor, Ceil, Sqrt, Power, Random Float in Range, Random Integer in Range, comparisons (`<`, `<=`, `>`, `>=`, `==`, `!=`), and the boolean operators AND, OR, NOT. (Add predates the library and keeps its exec pins, so existing graphs don't change.)
- **String:** Append, Len, Contains, To Upper, To Lower, Trim, Replace, Substring, String To Float and String To Int (To String already converts the other way).
- **Utilities:** Is Valid, Select.
- **File:** Load File to String and Save String to File, as `UFileHelper` offers them.

Operators are compact nodes showing their symbol (`-`, `×`, `÷`, `%`, `<`, `==`, AND, …), and the rest are pure nodes with a title bar, as in Unreal; the file nodes run when execution reaches them. Where languages disagree, the nodes follow one rule everywhere, checked by the conformance suite:

- Dividing (or taking a remainder) by zero stops the run with an error.
- `%` takes the sign of A, as in C++ and JavaScript (Python's `%` follows B).
- Round rounds halves up (toward positive infinity), as Unreal's Round does; Round, Floor and Ceil return integers.
- Sqrt of a negative number, and a Power with no real result, give NaN.
- String lengths and positions count characters (code points), not UTF-16 units.
- String To Float and String To Int accept plain decimal numbers only; anything else gives 0, as in Unreal. Replace with an empty From leaves the text unchanged.
- Load File to String and Save String to File use UTF-8 and paths relative to the working directory; a file that can't be read or written stops the run with an error. (Unreal's versions return a success flag instead; nodes with several outputs arrive with Phase 4.)

Collection nodes (Make Array, Length, Get, Add, Contains, Remove) arrive with Phase 4, with the wildcard pins they need.

### More of Unreal's library

More of Unreal's own nodes, with its names and categories, implemented in every language pack (and the C example pack, where C has the types):

| Category | Nodes |
|---|---|
| Math | Lerp, Map Range Clamped, Map Range Unclamped, Sign, Wrap (Integer), Nearly Equal, Truncate, Fraction, Exp, Loge, Log |
| Math / Trig | Sin, Cos, Tan, Asin, Acos, Atan, Atan2 (all in radians), Degrees To Radians, Radians To Degrees, Get PI |
| Math / Boolean | XOR, NAND, NOR |
| Math / Random | Random Bool |
| String | Starts With, Ends With, Find Substring, Parse Into Array, Join String Array, Repeat, Reverse, Left, Right, Is Numeric, Equal, Case Insensitive |
| Utilities / Array | Reverse, Slice, Sort, Shuffle, Sum, Min Of Float Array, Max Of Float Array, Range, First, Last, Random Item, Append Array, Swap |
| Utilities / Set | Union, Intersection, Difference |

Their rules, where languages would disagree:

- **Ranges.** Lerp doesn't clamp Alpha. Map Range with an empty in range (In Range A equal to B) gives Out Range B at or past it and Out Range A before it, as Unreal does. Wrap (Integer) includes both Min and Max: one past Max is Min again; Min greater than Max stops the run.
- **Domains.** Asin and Acos take values outside -1 to 1 as the nearest end, as Unreal (and Godot) do. Loge and Log of a value that isn't positive, or Log in a base that isn't positive or is 1, stop the run with an error (languages would otherwise give -Infinity, NaN or an error of their own).
- **Precision.** Log is `ln(A) / ln(Base)` in every language (no `log10` shortcut), so Log of 1000 in base 10 is 2.9999999999999996 everywhere. Math libraries can differ in the last digit of trigonometry and logarithms; the conformance fixture rounds those results to 10 places.
- **Parts.** Truncate rounds toward zero and returns an integer; Fraction keeps A's sign (-1.25 gives -0.25), as Unreal's does.
- **Text.** Positions and counts are in characters (code points). Starts With, Ends With and Find Substring are case-sensitive (Unreal's ignore case by default; use To Lower first, or Equal, Case Insensitive). Equal, Case Insensitive folds ASCII letters only, so it gives the same answer in every language; other letters must match exactly. Left and Right take what there is: a Count beyond the text gives all of it, and a negative one none. Is Numeric accepts plain decimal numbers (a sign, digits, one point), not exponents or spaces. Parse Into Array with an empty Delimiter, and Repeat with a negative Count, stop the run.
- **New containers.** The set and array functions return a new container and leave their inputs as they are (Unreal's Reverse, Shuffle, Append and Swap change the array they are given). Sets print, as To Array lists them, in ascending order.
- **Arrays.** Sort orders numbers by value, text by character code (capitals before small letters, in every language) and false before true. Sum adds in order, so it rounds as a loop does (Python's `sum` and Ruby's `Array#sum` compensate, and would differ). First, Last, Random Item, Min Of Float Array and Max Of Float Array stop the run on an empty array, as Swap does on an index out of range; Slice and Range take what there is. Range leaves End out, as Python's `range` does, and a Step of 0 stops the run.

### More utilities

Beyond Unreal's set, the library has everyday utilities, many adapted from Common Utility Snippets v0.1.0 (MIT; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)):

| Category | Nodes |
|---|---|
| String | Is Empty, Is Blank, Normalize Whitespace, Truncate, Capitalize, To Camel Case, To Snake Case, To Kebab Case, To Title Case, Slugify, Pad Left, Pad Right, Trim Start, Trim End, Word Count, Mask, Format String, Format Bytes, Parse Boolean, Parse Integer Strict |
| Math | In Range, Round To |
| Utilities / Array | Unique, Difference, Intersection (any element type), Average, Median |
| Utilities / Map | Pick, Omit, Merge, Find or Default, Make Map From Arrays |
| Utilities | Get Environment Variable, New UUID |
| Utilities / Encoding | Base64 Encode, Base64 Decode, URL Encode, URL Decode |
| Utilities / Time | Now, Get Accurate Real Time, Format Timestamp |
| File | Normalize Path |

The original leaves some behavior to each language. Here it's one contract, checked by the `utilities-*` fixtures in the conformance suite:

- **Characters.** Text is measured in code points, as above. Truncate's maximum includes its suffix.
- **Words.** The case conversions and Slugify split text into ASCII words: runs of letters and digits, split where a lower-case letter or digit meets a capital (`userID` → user, id) and before the last capital of a run that starts a word (`HTTPServer` → http, server). Other characters, accented letters included, separate words.
- **Errors.** A broken rule stops the run with a message, as dividing by zero does: a negative length, Parse Boolean on an unknown word, Parse Integer Strict on `12.0`, or Average of nothing.
- **Rounding.** Round To rounds halves away from zero, with a small correction for values just below a half (2.675 rounds to 2.68). Format Bytes rounds halves up in every language, where `toFixed` and `printf` disagree on exact halves.
- **Paths.** Normalize Path works on the text alone, the same on every system: `/` and `\` both separate folders, `.` and empty parts go, `..` removes the folder before it, and the result uses `/`.
- **Maps.** Maps keep their keys in the order they were added. Merge gives B's value where both maps have a key, at A's place in that order. Make Map From Arrays keeps a repeated key's first place and last value, and stops the run if Keys and Values differ in length.
- **Time.** Now gives Unix milliseconds (whole milliseconds since 1970-01-01 00:00 UTC; Lua's clock counts whole seconds), as a float, so it fits every language's numbers. Format Timestamp writes one in ISO 8601 in UTC (`2026-10-28T09:30:00.000Z`) the same everywhere, years 1 to 9999; outside them, the run stops. Get Accurate Real Time is for timing: seconds on a clock that never goes back, from a moment that isn't a date. Lua has only processor time for it (`os.clock`, which its Delay waits on too), and C the time of day.
- **Encoding.** Base64 and URL encoding work on the text's UTF-8 bytes. Base64 uses the standard alphabet with `=` padding; URL Encode leaves letters, digits and `- _ . ~` as they are and writes every other byte as `%XX` (a space is `%20`), and URL Decode leaves `+` as it is. Decoding stops the run on input that isn't Base64 or URL encoding, and on bytes that aren't UTF-8 text, where languages would otherwise each put in replacement characters their own way. New UUID gives a random version 4 UUID in lower case.
- **Limits.** Parse Integer Strict accepts numbers up to 2^53 (in C#, its 32-bit ints). Format Bytes takes sizes up to 2^53 and up to 10 decimals. Round To takes 0 to 15 digits.
- **Title case and trimming.** To Title Case, Trim Start and Trim End treat only ASCII whitespace as space and change only ASCII letters, so every language gives the same text (unlike Trim and Capitalize, which use each language's own rules; see below).
- **Format String.** `{0}`, `{1}`, … are replaced by that item of Args; other braces stay as they are (`{x}`, an unclosed `{2`), so `{{0}}` gives `{` + the item + `}`. A placeholder with no item stops the run.
- **Upper case and spaces.** Capitalize uses each language's upper-casing for the first character, so non-ASCII letters can differ: C++ and Lua change ASCII letters only. In C++ and Lua, too, only ASCII spaces count as whitespace (Is Blank, Normalize Whitespace, Word Count, Trim).

Nine of the original's 36 functions aren't included. Group By, Count By and Sum By take a function, which graphs can't pass. Chunk, Flatten, Flatten One Level and Zip return nested arrays, which pin types can't express. Coalesce takes any number of arguments of any type, and Select covers two. Clamp is already in the library.
