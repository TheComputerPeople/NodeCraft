# Node authoring (Phase 9)

Phase 9 of the [roadmap](roadmap.md): making nodes, Unreal's way. In Unreal you make nodes in two ways. You write C++ (`UFUNCTION(BlueprintCallable)` in a function library or on a class, `UPROPERTY(BlueprintReadWrite)`), or you build Blueprint Function Libraries and Macro Libraries out of other nodes. This phase reviews how each of our paths compares and closes the gaps.

Reviewed 2026-10-28, after the built-in utility library grew to 94 nodes. Each gap below says what happened then, checked against the code, and what to build. A "Built" section after each design says what each step built. The phase was completed on 2026-10-29: [roadmap.md](roadmap.md) has its status and deferrals.

## How nodes are made today

| Path | Unreal equivalent | Today |
|---|---|---|
| A function in the project's code marked `@blueprint` (all 12 languages; [code-as-nodes.md](code-as-nodes.md)) | `UFUNCTION(BlueprintCallable/BlueprintPure)` in a `UBlueprintFunctionLibrary` | Free and static functions, with `pure`, `@category`, `@displayName`, `@keywords` and `@param`. Refresh Node and Replace with … follow code changes. |
| A **Blueprint Function Library** graph ([program-structure.md](program-structure.md), "Functions") | Blueprint Function Library | Its functions are nodes in graphs of the library's language. Hand-written code can call its generated module too, which Unreal makes hard. |
| A **Blueprint Macro Library** graph | Blueprint Macro Library | Its macros are expanded where they are used, in any language when the library has none. |
| **Collapse to Function** / **Collapse to Macro** | The same | Into the same file. |
| A `*.node.json` file: a node with a code snippet per language, versioned by a `*.vgraph-package.json` or registered by an extension ([language-breadth.md](language-breadth.md), "Node library versioning") | Nodes from a C++ plugin | Works; written by hand as JSON. |

## Gap 1: function libraries are tied to one language

**Today.** A function library has one language, and only graphs in that language see its functions (`libraryDefinitions` in src/core/libraries.ts returns nothing for a library without one). A TypeScript library can't serve the Python graphs in the same workspace. Macro libraries can serve any language already, and Phase 7 let structs and enums list several languages. An Unreal function library works everywhere.

**Design.** A function library lists its languages, as struct and enum files do (`languages`, the **Also generate for** checkboxes; the toolbar picks the first):

- Compiling the library writes a generated file for each language, placed by its pack (`MathLib.vgraph.ts`, `math_lib_vgraph.py`).
- Its functions are nodes in graphs of any of those languages.
- A library function's node type no longer names a language or a generated file: `lib:<library path>#<graph id>`. The compiler turns it into a call of that language's generated file.
- **Migration.** Graphs that use `fn:<language>:<generated file>#<name>` nodes of a library are read as `lib:` nodes, and saved that way the next time they are edited, as schema migrations are.
- What a library function may use is checked for each of its languages, so a node with no snippet in one of them, or another language's project function, is a compile error for that language, on the node.
- Simulate runs library functions from the graph, as today, whatever the languages.

**Built (step 2).**

- **Languages.** A function library's Details show its **Also generate for** checkboxes under Library, as a struct's editor does. Compiling writes a file per language (`generatedLanguages` in src/core/user-types.ts now covers libraries).
- **Node types.** A library function's node is `lib:<library path>#<function graph id>`. Its definition keeps the first language's file and adds the others as `variants` (`FunctionImplementation` in src/core/model.ts), and the compiler imports the one in the graph's language.
- **Wrong language.** A graph in a language the library isn't generated for gets: `"Scale" is in a TypeScript and Python function library (lib/MathTools.vgraph); add Go to its languages to call it from this graph.`
- **Migration.** A definition can name the node types it replaced (`aliases`); the registry and the editor find it under them, and the editor saves a graph's old `fn:` library nodes as `lib:` nodes, with their stored signatures, the next time the graph is saved.

## Gap 2: code classes have no nodes

**Today.** Only free and static functions are nodes. Unreal's everyday pattern, a `BlueprintCallable` member function called through a **Target** pin and a `BlueprintReadWrite` property read and written by Get and Set nodes, has been deferred since Phase 3. A code type reaches a graph only as a `native:` pin that passes values through untouched. The Lua scanner even says so: "It takes self (a method): only module functions can be nodes."

**Design.** `@blueprint` works on a class's members as it does on functions:

- **Methods** become nodes with a **Target** pin of the class's type, as Unreal's member functions do. The pin's type is the class's `native:` type, which functions returning the class already produce.
- **Constructors** become **Construct <Class>** nodes, as Construct Object from Class is for graph classes.
- **Properties and fields** become **Get** and **Set** nodes with a Target pin: `@blueprint` (Unreal's BlueprintReadWrite) or `@blueprint readonly` (BlueprintReadOnly, Get only).
- A subclass's objects wire where its base class is expected, as the scanner reads the class's base.
- Generated code calls the member on the target in the language's syntax (`target.heal(5)`, `target:heal(5)`, `$target->heal(5)`). An empty Target stops the run with "Accessed None", as a graph object's does.

| Language | Methods | Construct | Properties |
|---|---|---|---|
| TypeScript, JavaScript | exported class, instance method with a JSDoc marker | `constructor` | class fields and get/set accessors |
| Python | method with `self` | `__init__` | `@property` (and its setter) |
| C# | public instance method | public constructor | public property or field |
| C++ | public member function in a header | public constructor | public data member |
| Rust | `pub fn` with `&self` / `&mut self` | `pub fn new(…) -> Self` | `pub` field |
| Java | public instance method | public constructor | public field |
| Go (through gopls) | method with a receiver | (constructor functions are already functions) | exported field |
| Lua | `function Class:method()` | `Class.new` | fields named in the class's annotation (`---@field`) |
| GDScript | method of a `class_name` script | `_init` | `@export` and other script variables |
| Ruby | public instance method | `initialize` | `attr_accessor` / `attr_reader` |
| PHP | public instance method | `__construct` | public property |

**Built (step 4): TypeScript, JavaScript, Python and C#.**

- **Scanning.** Each scanner reads classes as well as functions (`ScannedClass` in src/core/importing/symbols.ts): the constructor, instance methods and properties, each with its own documentation, and the class it extends. A Python attribute is documented by the string after it, as Sphinx reads it. C# structs are left out, since Set would change a copy.
- **Nodes.** `exposeFunctions` turns marked members into nodes typed `fn:<language>:<path>#<Class>:new`, `:<method>`, `:get:<property>` and `:set:<property>`. Their implementation is the class's, with a `member` saying which (`CodeMember` in src/core/model.ts).
- **Generated code.** Each generator imports the class once, however many of its members a graph uses (`importKey` in src/core/compiler/ir.ts).
- **Subclasses.** A subclass's objects connect to its base class's Target pins: `codeClassBases` in src/core/objects.ts collects each class's base from its member nodes.
- **Tests.** A conformance test builds a `Counter` and a `BigCounter` subclass in each language and checks the output. The TypeScript and JavaScript versions also type-check under `--strict`.

**Built (step 5, part 1): C++ and Java.**

- **Scanning.** The C++ scanner reads a class's or struct's public section in a header: constructors (past their initializer lists), member functions and data members. The Java scanner reads a public top-level or static nested class's public constructors, instance methods and fields.
- **C++ objects.** C++ objects travel in a `std::any`, as the graph's other `native:` values do. A Target must reach the object as the class whose member it uses, which `std::any_cast` can't do for a subclass. So Construct stores a `vgraph::CodeObject`: the object as its own class and as each class it extends that the workspace knows. The lowering passes those classes on the construct's import (`bases`), and `vgraph::code_object<T>` finds the object as `T`.
- **Java objects.** Java casts the Target to the class, as C# does.
- **Tests.** The Counter test is shared (test/conformance/code-classes.ts). The C++ and Java versions use a pure method for Doubled, since neither language has properties.

**Built (step 5, part 2): Rust and Go.**

- **Rust.** The scanner reads `pub struct`s' `pub` fields and the methods and constructor of their `impl` blocks. A method taking `self` by value would consume the object, so it's reported instead. Objects travel as a new `Object` variant of the runtime's `vgraph::Value`: an `Rc<RefCell<T>>`, equal only to itself. `vgraph::code_object::<T>` borrows it for each use.
- **Go (Tier 2).** The extension now collects methods and fields from the language server's document symbols as well as functions:
  - gopls names methods `(*Counter).Add`, beside their struct; other servers nest them in the class symbol.
  - A field's type is the symbol's detail.
  - The Go pack sets `objectsByPointer`, so the class's type is `*Counter`, as its `New` function returns it. Generated code asserts `any(target).(*counter.Counter)`.
- **Tests.** Rust and Go have no inheritance, so their BigCounter is a struct of its own, and the shared graph uses its own Add.

**Built (step 6): Lua, GDScript, Ruby and PHP.**

- **Scanning.**
  - Ruby: the scanner already followed class scopes. It now keeps a class's members, and tracks `private` and `protected` sections.
  - PHP: it already tracked classes by brace depth. It now reads properties as well as methods.
  - GDScript: a script with a `class_name` is a class.
  - Lua: a class is a `---@class` table that the module's table reaches. When the module returns the class itself, the class's import name is empty, so `ScannedClass.title` gives the palette its name.
- **Generated code.** Each generator writes its language's member syntax. None needs runtime support, since these languages pass objects as they are.
- **Learned on the way.**
  - Run doesn't import the Godot project, so `class_name` globals aren't registered and `extends Counter` doesn't resolve. In the test, GDScript's BigCounter is a script of its own. A project opened in the Godot editor has them.
  - A Lua statement can't start with `(`, or Lua reads it as a call of the line before, so member Sets use the plain Target expression.

Classes from code as **parents** of graph classes (Unreal's Blueprint subclassing a C++ class, with BlueprintImplementableEvent) stay deferred. They need generated subclasses of user code in every language, which is a phase of its own.

## Gap 3: code functions have one output

**Today.** A code function's node has at most one output, Return Value. Unreal's out parameters, and functions that return several values, aren't nodes: the Lua scanner skips them ("It returns several values"), as the PHP scanner does references. Graph functions have had several outputs since Phase 4, and every generator already calls them.

**Design.** Each language's own way of returning several values becomes several output pins, named by the language where it names them and by an `@outputs a b` tag where it doesn't:

| Language | Several outputs from |
|---|---|
| TypeScript, JavaScript | an object type (`{ total: number; count: number }`) or a labeled tuple (`[total: number, count: number]`) |
| Python | a `NamedTuple`, or `tuple[…]` with `@outputs` |
| C# | `out` parameters (Unreal's way), or a named tuple (`(int Total, int Count)`) |
| C++ | non-const reference parameters (`T&`, Unreal's rule for out parameters), or `std::tuple`/`std::pair` with `@outputs` |
| Rust | a tuple with `@outputs` |
| Java | a `record` return type: its components |
| Go | several results, named or with `@outputs`. A last `error` result isn't a pin: a non-nil error stops the run with its message |
| Lua | several `---@return type name` annotations |
| Ruby | `@return [Array(…)]` with `@outputs` |
| PHP | by-reference parameters (`&$count`), or an array shape (`@return array{total: int, count: int}`, or `array{int, int}` with `@outputs`) |
| GDScript | none (Godot functions return one value) |

**Built (step 7): every language but GDScript.**

- **Scanning.** Each scanner reads its language's form from the table into the function's `outputs` and `results` (`ScannedFunction` in src/core/importing/symbols.ts). `tupleOutputs` names positions from the code when it names them all, otherwise from `@outputs`. Without names, a tuple stays one value of its native type, as before. Out parameters follow the returned value, which becomes the first output, Return Value.
- **Nodes.** A node with several outputs always has exec pins, even when marked pure, since the function runs once for all of them. Its implementation carries `results` (`CodeResults` in src/core/model.ts): `fields`, `tuple` or `out`, the names in the code, and Go's `error`.
- **Generated code.** The lowering already gave a call with several outputs a slot per output, as for library functions. Each generator now reads them in its own way:
  - Fields: TypeScript and JavaScript destructure the object. Java reads each record accessor. PHP destructures the array by its keys.
  - Tuples: TypeScript, JavaScript, Python, Lua and Ruby destructure positionally (a NamedTuple too). C# deconstructs. C++ uses `std::tie`. Rust and Go read each element.
  - Out parameters: new variables are passed to the call, then each goes into its output's slot. C# passes `out var`, C++ declares variables of the parameters' own types, and PHP starts each at its type's default, since a typed parameter by reference checks what it's given.
- **Go's errors.** gopls's signature gives the result list. A last `error` result is no pin: when it isn't nil, generated code stops the run with `VgFail(err.Error())`. A function returning only an error gets exec pins and no outputs.
- **Tests.** A shared graph (test/conformance/several-outputs.ts) calls `divide(17, 5)` and prints its quotient and remainder. It runs in every language but GDScript, covering each form in the table. Scanner tests cover the forms not shown there, and the reasons for what's still skipped.

## Gap 4: async functions aren't latent nodes

**Today.** `async` functions and functions returning a `Promise` or `Awaitable` aren't nodes. The skip message still says they "become latent nodes with Phase 4's latent actions"; Phase 4 built Delay but not this.

**Design.** A function returning its language's future becomes a **latent node**, drawn with the clock icon, as Unreal draws latent functions: exec in, a **Completed** exec out that fires when the result arrives, and its outputs. A failure stops the run with its message. Generated code continues on the latent queue every pack already has for Delay, so Unreal's ordering holds.

- **TypeScript and JavaScript:** a `Promise` or an `async` function, continued with `.then`.
- **Python:** an `async def`. The runtime's latent queue runs on an `asyncio` event loop when a graph calls one.
- **C#:** a `Task` or `Task<T>`.
- **Java:** a `CompletableFuture`.
- **Not applicable:**
  - Rust's futures need an executor the project chooses.
  - Go uses goroutines rather than futures.
  - Lua, Ruby and PHP have no standard future. (C++ has one, std::future: see below.)
  - GDScript's `await` is Godot's own: it comes with a Godot framework pack.

**Built (step 8): TypeScript, JavaScript, Python, C# and Java.**

- **Scanning.**
  - TypeScript and JavaScript: an `async` function or method, or one returning `Promise<T>` (annotated, or JSDoc's `@returns {Promise<T>}`).
  - Python: an `async def`, or a def returning `Awaitable[T]` or `Coroutine[…, …, T]`.
  - C#: a method returning `Task` or `Task<T>`. `async void` and `ValueTask` are reported, with a hint to return a Task, as are async methods with `out` parameters.
  - Java: a method returning `CompletableFuture<T>` or `CompletionStage<T>`, its boxed `T` unboxed (`Long` is an int).
  - The awaited type is the Return Value. `ScannedFunction.latent` marks the function.
- **Nodes.** `NodeDefinition.latent` marks a latent node: Delay and Retriggerable Delay now have it too. The editor draws a clock in its title. A latent node always has exec pins, even when marked pure. Its exec output is **Completed**. As with Delay, a latent node in a function graph is a compile error, and its Completed doesn't count toward exec loops.
- **Generated code.** A new IR statement, `await`, calls the function, and the code after it goes on. When the future finishes, its value goes into the output's slot and Completed's chain runs, from the latent queue:
  - TypeScript and JavaScript: `.then(…)`. A rejection is unhandled, so Node.js stops the run with it.
  - Python: the latent queue now runs on an `asyncio` event loop, which drives the coroutines beside the Delays. Each finished coroutine's Completed joins the queue.
  - C# and Java: the queue keeps the tasks or futures it's waiting for. It waits on them and the next Delay together, then queues each finished one's Completed. `GetAwaiter().GetResult()` and `latentResult` read the value, or throw the function's own exception (not .NET's AggregateException or Java's CompletionException).
- **Fixed on the way (step 7).** A class method's node now keeps how its code gives several outputs. Member calls in C#, C++ and PHP now pass the out-parameter variables.
- **Tests.**
  - A shared graph (test/conformance/latent-code.ts) starts `fetchDouble(4)` from a Sequence's first output. It prints "started" from the second output, then 8 on Completed, in all five languages.
  - A failing function stops the run with its own error, and its Completed doesn't run.
  - Scanner tests cover each form and the reasons for what's still reported. A webview test checks the clock.

**Built after the phase (from its deferrals): C++.**

- **Scanning.** A function returning `std::future<T>` or `std::shared_future<T>` is latent, with `T` as its value.
- **Runtime.** The C++ runtime's latent queue now keeps the futures it's waiting on (`vgraph::await_latent`). Each turn it moves the ready ones' Completed into the queue, and while any is pending it sleeps in short steps instead of until the next Delay.
  - A deferred future (`std::launch::deferred`) never reports ready, so it counts as ready and runs when its Completed does.
  - `get()` throws the function's exception, which stops the run.
- **Tests.** The shared latent graph and a failing future, compiled and run.

**Built after the phase: Go and Rust** (decided 2026-10-29: Go's channels, and a Rust executor of the runtime's own).

- **Go.** A function returning a channel (`<-chan T` or `chan T`; `chan struct{}` gives no value) is latent: the language-server import reads it when the pack sets `asyncChannels`. The runtime's `VgAwait` keeps the channel beside the Delay queue and moves its Completed into the queue once a receive succeeds (a closed channel gives its zero value). Generated code converts the value to the output's type with `VgAs`.
- **Rust.** An `async fn`, or a function returning `impl Future<Output = T>` or `Pin<Box<dyn Future<Output = T>>>`, is latent.
  - The runtime's `await_latent` wraps the future so that finishing queues its Completed.
  - Each latent turn polls the waiting futures once, with a waker that does nothing, so it needs no crates.
  - A future waiting on a reactor (tokio) never progresses. A panic in the future stops the run.
- **Tests.** The shared latent graph in both. Rust's uses a hand-written future that's pending for 10 ms, and a future that panics.

**Built after the phase: Lua, PHP and GDScript** (decided 2026-10-29: Lua's coroutines, PHP's Fibers and GDScript's await; not Ruby).

- **Lua.** A function marked `---@async` is latent; one that also returns several values is reported.
  - Generated code wraps the call in a function, and the runtime's `vg.await_latent` runs it as a coroutine: at once until it first yields (as a JavaScript async function runs until its first await), then once per latent turn.
  - When it returns, its Completed joins the queue with the value. An error stops the run.
- **PHP.** A function returning a `Fiber` is latent, its value typed by a docblock `@return Fiber<int>`. `Vg::awaitLatent` starts the Fiber if it isn't started, resumes it once per latent turn until it terminates, then queues its Completed with `getReturn()`.
- **GDScript.** A function whose body awaits is a coroutine, and latent.
  - Generated code passes `func(): return await <call>` to `vg.await_latent`, which counts it as waiting until it finishes, then queues its Completed.
  - While anything waits, the latent loop awaits the tree's `process_frame`, so Godot's main loop runs the frames that resume it.
  - Run's launcher now starts from `_initialize()`, when the tree is the main loop, and runs as a coroutine.
  - There's no failure test: GDScript has no exceptions, and the tests don't crash Godot on purpose.
- **Tests.** The shared latent graph in each, and a failing coroutine or Fiber in Lua and PHP.

## Gap 5: no way from a node to its definition

**Today.** Double-clicking a node opens a function or macro graph in the same file only (`render.ts`). Nothing opens a library function's graph, the code behind a project function, or a `*.node.json` file. Unreal opens a library function's graph, and a C++ node's source in the IDE.

**Design.**

- **Double-click** on a node, or **Go to Definition** in its menu (F12), opens:
  - a library function or macro's graph, in its own editor;
  - a project function, method or property in the code, at its line (definitions gain the declaration's `line`, which the scanners already find);
  - a snippet node's `*.node.json` file, at its entry.
- **Find References** in the same menu searches every graph for that node type, through Find in All Blueprints.

**Built (step 9).**

- **Where.** `definitionSite` (src/core/navigation.ts) says where a node is defined:
  - a function or macro graph of this file;
  - a library's graph (its definition's `source`);
  - the project's code (its implementation's `path`);
  - or a node file, for snippet nodes and packages' nodes.
  - Built-in nodes have none: the menu leaves out Go to Definition, and F12 says so in the status bar.
- **Opening.** The webview opens this file's graphs itself and asks the host for the rest:
  - A library graph opens in its own editor, at the function, as Find in All Blueprints opens a hit.
  - Code opens in a text editor at the declaration's line.
  - A node file opens at the line naming its type: `NodeLibraries` remembers the file each type was read from.
- **Lines kept apart.** `exposeFunctions` returns each node type's line beside the definitions, not in them, and `ProjectFunctions.locate` finds it from the latest scan. Graph files store the definitions they call, so a line in them would change every graph whenever code above a function moved.
- **Find References** (Shift+F12, or the node's menu) opens the Find panel searching every file. The host lists each node of the type, or of one of its aliases, in every graph (`findReferences`), through the search Find in All Blueprints uses.
- **Tests.**
  - Unit: each kind of site, the lines of functions and class members (and that the definitions carry none), and references through aliases.
  - Webview: double-click, the menu and F12 ask the host, and Shift+F12 shows the results.
  - Integration: VS Code opens a TypeScript function at its line, and a node file at its type.

## Gap 6: little metadata

**Today.** A graph function has a Description and a Category. A code function adds a display name and keywords. Unreal's functions also have Keywords, a **Compact Node Title** (drawn like an operator), **Deprecated** (with a message), **Advanced** pins (hidden behind the node's arrow), display names for pins, and **ExpandBoolAsExecs** / **ExpandEnumAsExecs**, which turn a result into exec outputs.

**Design.** The same set for graph functions, macros and code:

| Unreal | Graph function or macro (Details) | Code tag |
|---|---|---|
| Keywords | Keywords | `@keywords` (exists) |
| CompactNodeTitle | Compact Node Title | `@compactTitle +` |
| DeprecatedFunction, DeprecationMessage | Deprecated, Deprecation Message | `@deprecated message`, and each language's own marker (`[Obsolete]`, `#[deprecated]`, `@Deprecated`, `@deprecated` in JSDoc, PHPDoc and YARD) |
| AdvancedDisplay | Advanced View on an input | `@advanced pin …` |
| UPARAM(DisplayName) | (the pin's name) | `@pinName pin Name` |
| ExpandBoolAsExecs, ExpandEnumAsExecs | (use a Branch or Switch) | `@execs`: a `bool` result becomes True and False exec outputs; a graph enum, one per value |

- **Deprecated nodes** leave the palette, get a warning badge with the message, and compile with a warning, as in Unreal.
- **Advanced pins** fold under an arrow at the bottom of the node. They show when they have a wire or a value.

**Built (step 10): graph functions and macros.**

- **Where it's kept.** A function's or macro's signature has `keywords`, `compactTitle` and `deprecated` (with an optional `message`), and an input pin has `advanced`. Details edits them: Keywords, Compact Node Title, Deprecated and its Deprecation Message, and an Advanced View box on each data input. Both schemas describe them (a node file can set them too).
- **Which nodes.** `signatureMetadata` (src/core/metadata.ts) copies them onto every node made from a signature: call nodes, macro instances, library functions and macros, and other classes' and interfaces' functions. The definitions carry `keywords`, `compactTitle` and `deprecated`, and their pins `advanced`.
- **Drawing.**
  - A Compact Node Title draws the node without a title bar, its text large in the middle, as operators are drawn (and the palette finds it by that text too).
  - A deprecated node shows a warning badge with its message at once, its title struck through. It leaves the palette (nodes already placed keep working), and compiles with a `deprecated` warning, a macro's from its instance before expansion.
  - Advanced inputs show when the node's arrow is open (the node's `showAdvanced` property, saved with the graph), or when they have a wire or a value set.
- **Left for later steps.** Pin display names and ExpandBoolAsExecs/ExpandEnumAsExecs come with the code tags (step 11): a graph function's pins already have names, and Branch and Switch already turn results into exec outputs.
- **Tests.** Unit tests cover the nodes made from each kind of signature, the compile warnings, and the file keeping the fields. Webview tests cover Details, the compact title, the badge, the palette and the arrow.

**Built (step 11): tags in code.**

- **Tags.** `definitionFor` (src/core/importing/symbols.ts) reads `@compactTitle`, `@deprecated`, `@advanced` and `@pinName` beside `@keywords` in every language, since every scanner produces the same `DocComment`. Methods take them as functions do, and properties take `@keywords` and `@deprecated`.
- **Markers.** Scanners read their language's own markers by line, and `markDeprecated` marks what's declared there:
  - C#: `[Obsolete]`.
  - C++: `[[deprecated]]`.
  - Rust: `#[deprecated]`.
  - Java: `@Deprecated`, taking Javadoc's `@deprecated` text as its message.
  - Python: PEP 702's `@deprecated("…")`.
  - Go: a `Deprecated:` paragraph, Go's convention.
  - Doc comments: the `@deprecated` tag (JSDoc, PHPDoc, YARD, LuaLS, Godot).
  - PHP 8.4: `#[\Deprecated]`, with its message (added after the phase, from its deferrals).
- **Fixed on the way.** In C#, documentation written before an attribute was lost (it was attached to the `[`). It now belongs to the member, as in C++ and Rust.
- **`@execs`.** A function returning a bool gets True and False exec outputs (`FunctionImplementation.execs`). The call lowers to the call into a hidden bool slot, then an `if` on it, so every generator handles it with what it already writes.
  - ExpandEnumAsExecs came after the phase, from its deferrals.
    - Code's pins typed by a type a graph file generates (`native:Mood`) take that struct or enum, when it's generated for the code's language (`adoptUserTypes` in src/core/user-types.ts).
    - The registry works this out from the definitions as registered, whenever any change, so the order sources load in doesn't matter.
    - `@execs` on such an enum result gives an exec output per value (`execs: { enum }`). The call stores its result in a hidden slot of the enum type, then an `if` chain compares it with each value, as Switch on an enum lowers.
    - A conformance test runs it in TypeScript and Python.
- **Tests.**
  - Unit: each tag, `@execs`, its lowering, and every language's marker.
  - Conformance: `@execs` runs in TypeScript, Python and C#.

## Gap 7: little feedback while writing code

**Today.** A marked function that can't be a node is reported in the output channel only. Nothing helps add a marker. `exposeAllFunctions` covers TypeScript, JavaScript and Python only.

**Design.**

- **Diagnostics.** A warning in the source file, on the function, with the reason: "Not a Blueprint node: rest parameters can't be pins".
- **Quick fixes.** On an exposable function, method or property: **Expose as Blueprint node** and **Expose as pure Blueprint node**. Each adds the marker in the language's documentation comment, creating the comment when there is none.
- **`exposeAllFunctions`** in every language, by its rule for public:
  - exported (TypeScript, JavaScript);
  - not `_`-prefixed (Python, GDScript, Ruby);
  - `public static` (C#, Java, PHP);
  - `pub` (Rust);
  - capitalized (Go);
  - in a header (C++);
  - in the returned module (Lua).

**Built (step 12).**

- **Diagnostics.** `ProjectFunctions` (src/extension/project-functions.ts) shows each marked function that can't be a node as a warning on its line, from the scan it already makes. The output channel still lists them too.
- **Quick fixes.** The same class is a code action provider for every file a scanner reads:
  - `exposeCandidates` (src/core/importing/expose.ts) lists the unmarked declarations a scan found, cached by document version.
  - `markerEdit` writes the marker in the language's style: into a `/** … */` block above (a one-line block becomes several lines), as a new `///`, `---`, `##` or `#` line after the existing ones and before any attributes or decorators, or into a Python docstring (a new one when there's none). A one-line Python def has no room, so it isn't offered.
  - After the phase (from its deferrals): a Lua field gets the marker on its own `---@field` line (`DocStyle.inlineFields`), and Go's declarations come from the language server's symbols (`symbolCandidates`, the exported ones), fetched when the lightbulb asks.
- **`exposeAllFunctions`** was already applied to every scanner; what was missing:
  - Go now keeps lowercase names out (`exportedNames: 'capitalized'` on its language-server import), and reports a marked one.
  - Unmarked functions a language keeps private aren't reported. The setting's description gives each language's rule.
- **Tests.**
  - Unit: in every scanned language, each candidate gets its marker and the scanner reads it back. Also covered: comments keeping their text, the pure marker, and exposeAll in eight languages, and Go's names.
  - Integration: the warning in VS Code, and the quick fix applied.

## Gap 8: snippet nodes are written blind

**Today.**
- `schemas/node.schema.json` exists but isn't associated with `*.node.json` in `package.json`, so the editor offers no completion or checks there.
- There's no command to start a node.
- A snippet that uses a pin that doesn't exist, or doesn't compile, shows up only when a graph using the node is compiled or run.
- Nothing tests a node library on its own: the conformance suite checks language packs, not node libraries.

**Design.**

- **Schema.** `*.node.json` files are checked against the node schema.
- **New Node.** The command asks for a name and a category, and writes a `*.node.json` with an input, an output and a snippet for each language the workspace's graphs use.
- **File diagnostics.**
  - A `${pin}` with no such pin.
  - A language the workspace uses with no snippet (information).
  - A node type defined twice.
- **Examples.** A node may list `examples`: inputs and the outputs they give. **Test Node Library** builds a graph from them, runs it in Simulate and in each language the library and workspace share (the conformance runner), and reports each example's result. Nodes without examples are compiled in each language, not run. The SDK's `blueprint-conformance` gains `--nodes <file>`, so extensions can test their node libraries too.

**Built (step 13): the schema, New Node and file diagnostics.**

- **Schema.** `package.json` associates `*.node.json` with `schemas/node.schema.json`, so VS Code's JSON support validates node files and completes their fields.
- **New Node** (`blueprintVisualScripting.newNode`; Command Palette, or a folder's menu in the Explorer) asks for a name and a category. It writes `<Name>.node.json` in that folder (else the workspace's `nodes` folder) and opens it. The node (`newNodeDefinition` in src/core/node-files.ts) has exec pins, a float input and output, and a snippet returning the input for each language the workspace's graphs use (TypeScript when there are none yet). Its type is `user.<category>.<name>`.
- **File diagnostics.** `NodeLibraries` keeps each node file's text and checks it (`nodeFileProblems`):
  - A `${pin}` with no such data input: a warning on the placeholder.
  - A language the workspace's graphs use with no snippet for it: information on `"languages"`, unless the language's own pack implements the node.
  - A type another file defines too: a warning on the type, naming the other file.
  - They're checked again when the graphs' languages change.
- **Tests.**
  - Unit: each problem, New Node's definition (valid against the schema, read by the registry, compiled in a graph), and its fallback.
  - Integration: the command writes the file, and VS Code shows the problems of a broken node file.

**Built (step 14): examples, Test Node Library and `--nodes`.**

- **Examples.** A node definition may list `examples`: an optional description, input values and the output values they give, by pin id, as JSON (the schema describes them). The sample Double node has two.
- **The graph.** `exampleGraph` (src/core/node-examples.ts) calls the node once per example, with the inputs on its pins. Its exec pins, when it has them, are chained after Start. It prints each output the example lists. The expected lines are those outputs formatted as Print shows them (`formatValue`), and `exampleMismatches` says which example printed something else.
- **Running.** `runNodeExamples(pack, nodes)` (src/conformance/conformance.ts) compiles and runs the graph with a pack's runner, as the conformance suite runs fixtures.
  - A node without examples only has to compile.
  - One with no snippet for the pack (and no implementation of its own in the pack) isn't applicable.
  - `simulateNodeExamples` runs the same graphs in Simulate.
- **Test Node Library** (Command Palette, or a node file's or folder's Explorer menu; workspace trust required) tests the active node file, or the folder's node files. It runs them in Simulate and in each language the workspace's graphs use, with the `runCommands` setting, and writes the reports to the output channel.
- **The SDK.** `blueprint-conformance <pack> --nodes <file or folder>` does the same for one pack, built-in or not, and exits with 1 when an example fails. The SDK exports `runNodeExamples`, `simulateNodeExamples` and `loadNodeFiles`.
- **Tests.**
  - Conformance: the example graph, Simulate, TypeScript and Python (a wrong example, no examples, no snippet), and the CLI's exit codes.
  - Integration: the command's reports.

## Gap 9: library graphs can't be packaged

**Today.** A `*.vgraph-package.json` holds `*.node.json` files only, and extensions can register only those. Function and macro libraries, structs and enums can't be versioned or shipped. Unreal plugins carry Blueprint libraries.

**Design.**

- **Graphs in packages.** A manifest's `graphs` lists `.vgraph` files: function and macro libraries, structures and enumerations. Graphs remember the package's version and get Refresh Node on a new major version, as for node files.
- **Where they live.** Generated code must be in the workspace, so a graph package is added to it, as an Unreal plugin's content sits in the project's Plugins folder.
  - **Add Blueprint Package…** copies a package from a folder, or from an installed extension that contributes `blueprintPackages`, into `blueprint-packages/<name>/`.
  - It then compiles the package's libraries for the workspace's languages.
  - Adding a newer version replaces the folder.

**Built (step 15).**

- **Manifests** may list `graphs` (relative paths or globs) beside `nodes`, or in place of them: a package holds node files, graph files, or both. The schema and `manifestProblems` require one of the two.
- **Versions.** `NodeLibraries` (src/extension/node-libraries.ts) finds the graph files each manifest lists, and `GraphLibraries` tags their nodes with the package's name and version (`tagPackageDefinitions`). So graphs using a package's library functions, macros, structures or enumerations record its version (`metadata.libraries`) and get Refresh Node on a new major version, as for node files. Changing a manifest rescans the graph libraries.
- **Add Blueprint Package…** (src/extension/blueprint-packages.ts) offers the packages installed extensions contribute, and a folder. Copying from a folder is how a package is shared until there's a registry.
  - **Contributing.** An extension contributes packages in its `package.json`: `"contributes": { "blueprintPackages": [{ "path": "packages/combat" }] }`, each path a folder with a `*.vgraph-package.json`.
  - **Copying.** It copies the package to `blueprint-packages/<name>/` (a scope's `@` dropped and `/` made `-`). A newer version replaces the folder at once. The same or an older version asks first.
  - **Generating.** It adds the workspace's graph languages to each function library, structure and enumeration the package lists (`languages`), and compiles each, so graphs in every language can use them at once.
- **Tests.**
  - Unit: manifests with graphs, and the tagging recorded in a graph.
  - Integration: a package added from a folder, generated in TypeScript and Python, its nodes carrying its version, then replaced by a newer one.

## Gap 10: smaller gaps

- **Collapse to Function in Library…** moves the selection into a function library (an existing one with the graph's language, or a new one), as Collapse to Function does within a file. As in a library, the selection may not use Self, member variables or latent nodes.

  **Built (step 3).**
  - The node menu's **Collapse to Function in Library…** lists the workspace's function libraries the graph's language can call, and **New Function Library…**, which asks where to save it (in the graph's language, its only function the collapsed one).
  - The new function goes into the library, which is saved (and so compiled); its library node takes the selection's place, wired as Collapse to Function wires its call.
  - A selection that uses the blueprint's own variables, functions, macros, custom events, dispatchers or Self (or a member node without a Target wire) can't move, and the status bar says so. Delay is refused by the library's function graph, as in any function.
- **The `subgraph` implementation kind** is in the model and schema but nothing implements it, and architecture.md still proposes `*.vfunc` files. Function libraries are that design, so the kind is removed and the doc updated.

  **Built (step 16).** The kind is gone from the model and the node schema, and architecture.md describes the graph-backed nodes that replaced it: function and macro libraries.
- **Generic and wildcard code functions** stay out. Unreal rarely uses them, and they need type inference across the scanners.

  **Built after the phase (from its deferrals).** The inference already existed: wildcard pins take the type of the first wire.
  - **Scanning.** A scanner renames a function's type parameters to two placeholder names in its type texts (`substituteTypeParameters` in src/core/importing/symbols.ts). Every type mapper reads them as `wildcard` and `wildcard:value`, containers of them too. This covers TypeScript's `<T>`, JSDoc's `@template`, Python's PEP 695 `[T]` and the module's TypeVars, C#'s and Java's generic methods, and Rust's `<T>` (lifetimes aren't type parameters). More than two is reported.
  - **Resolving.** Function nodes now take their adopted wildcard types in the resolver, as Make Array does.
  - **Calling.** Each set of types a generic function's node takes is a separate import in the IR, with that node's concrete signature, so every generator converts as for any call. TypeScript and Python dedupe the import lines, and the other generators call by qualified name.
  - **Left.** C++ templates, Go, Lua and PHP generics.
  - **Tests.** A shared graph (test/conformance/generics.ts) calls `first` on an int array in TypeScript, JavaScript, Python (both forms), C#, Java and Rust.

## Summary

| Gap | Recommendation | Size |
|---|---|---|
| 1. Libraries tied to one language | A library generated for each of its languages; `lib:` node types | Medium |
| 2. Code classes | Methods with Target pins, Construct, Get/Set, in all 12 languages | Large |
| 3. One output | Each language's out parameters, tuples and records as outputs | Medium |
| 4. Async | Latent nodes from futures (TypeScript, JavaScript, Python, C#, Java) | Medium |
| 5. Navigation | Go to Definition and Find References | Small |
| 6. Metadata | Unreal's function metadata for graphs and code | Medium |
| 7. Feedback in code | Diagnostics, quick fixes, `exposeAllFunctions` everywhere | Small |
| 8. Snippet nodes | Schema, New Node, diagnostics, examples and Test Node Library | Medium |
| 9. Packages | Library graphs in packages, Add Blueprint Package | Medium |
| 10. Smaller | Collapse to Function in Library; remove `subgraph` | Small |

## Exit check

A sample workspace with TypeScript and Python graphs uses every path:

- **A function library** generated for both languages, used from graphs in each.
- **Code classes:** a TypeScript class and a Python class, each with a constructor, methods, a property, a function with several outputs and an async function, used from graphs through Construct, Target pins, Get and Set, and a latent node.
- **A node library** whose examples pass Test Node Library in both languages.
- **A graph package** added with Add Blueprint Package.

It runs from Run in both languages, and Go to Definition reaches each source. Each language's interop test (`test/conformance/<language>.test.ts`) also covers code classes and several outputs, and async in the languages that have it.

**Built (step 16).** The workspace is sample/node-authoring; its package's source, as shared, is sample/packages/drills.

- **What's in it.**
  - `lib/dojo.ts` and `game/dojo.py`: a Trainee class with a constructor, a `health` property, `train`, `split` (two outputs) and an async `rest`.
  - `libs/Scoring.vgraph`: a function library generated for both languages.
  - `nodes/Clamp01.node.json`: a snippet node with three examples.
  - `blueprint-packages/drills`: the package as Add Blueprint Package leaves it, generated for Python too.
  - `graphs/DojoTs.vgraph` and `graphs/DojoPy.vgraph`: the same graph in each language, using all of them.
- **The test** (test/conformance/node-authoring.test.ts) builds the nodes as the extension does: it scans the code, reads the libraries for both languages, tags the package's, and reads the node file.
  - It compiles the libraries in both languages, then runs each graph, which prints 8, 0, 8, 420, 1, 800 and 42.
  - It checks that every node has a definition to go to (the code's line, the library's graph, the node file).
  - It checks that the package's version is recorded, and that the node library's examples pass in both languages.
- **In VS Code.** Running, Go to Definition, the quick fixes, New Node, Test Node Library and Add Blueprint Package are each covered by the integration suite (steps 9 and 12 to 15).

## Steps

One commit each; large steps may take several.

1. This design.
2. Function libraries for several languages: `languages`, `lib:` node types and their migration, a generated file per language.
3. Collapse to Function in Library.
4. Code classes in TypeScript, JavaScript, Python and C#: Construct, methods with Target pins, Get and Set.
5. Code classes in C++, Rust, Java and Go.
6. Code classes in Lua, GDScript, Ruby and PHP.
7. Several outputs from code in every language.
8. Async functions as latent nodes: TypeScript, JavaScript, Python, C# and Java.
9. Go to Definition and Find References.
10. Metadata for graph functions and macros: Keywords, Compact Node Title, Deprecated, Advanced pins; drawing them.
11. Metadata tags in code, in every scanner, with each language's own deprecation markers and `@execs`.
12. Feedback in code: diagnostics, quick fixes, `exposeAllFunctions` in every language.
13. Snippet nodes: the schema, New Node, file diagnostics.
14. Node examples, Test Node Library, and the SDK's `--nodes`.
15. Graph packages: `graphs` in manifests, versions, Add Blueprint Package, `blueprintPackages`.
16. Remove `subgraph`; the exit check, docs, the parity checklist and status.
