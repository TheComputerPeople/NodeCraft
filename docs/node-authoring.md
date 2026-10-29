# Node authoring (Phase 9 design)

Phase 9 of the [roadmap](roadmap.md): making nodes, Unreal's way. In Unreal you make nodes in two ways. You write C++ (`UFUNCTION(BlueprintCallable)` in a function library or on a class, `UPROPERTY(BlueprintReadWrite)`), or you build Blueprint Function Libraries and Macro Libraries out of other nodes. This phase reviews how each of our paths compares and closes the gaps.

Reviewed 2026-10-28, after the built-in utility library grew to 94 nodes. Each gap below says what happens today, checked against the code, and what to build.

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
  - C++, Lua, Ruby and PHP have no standard future.
  - GDScript's `await` is Godot's own: it comes with a Godot framework pack.

## Gap 5: no way from a node to its definition

**Today.** Double-clicking a node opens a function or macro graph in the same file only (`render.ts`). Nothing opens a library function's graph, the code behind a project function, or a `*.node.json` file. Unreal opens a library function's graph, and a C++ node's source in the IDE.

**Design.**

- **Double-click** on a node, or **Go to Definition** in its menu (F12), opens:
  - a library function or macro's graph, in its own editor;
  - a project function, method or property in the code, at its line (definitions gain the declaration's `line`, which the scanners already find);
  - a snippet node's `*.node.json` file, at its entry.
- **Find References** in the same menu searches every graph for that node type, through Find in All Blueprints.

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

## Gap 9: library graphs can't be packaged

**Today.** A `*.vgraph-package.json` holds `*.node.json` files only, and extensions can register only those. Function and macro libraries, structs and enums can't be versioned or shipped. Unreal plugins carry Blueprint libraries.

**Design.**

- **Graphs in packages.** A manifest's `graphs` lists `.vgraph` files: function and macro libraries, structures and enumerations. Graphs remember the package's version and get Refresh Node on a new major version, as for node files.
- **Where they live.** Generated code must be in the workspace, so a graph package is added to it, as an Unreal plugin's content sits in the project's Plugins folder.
  - **Add Blueprint Package…** copies a package from a folder, or from an installed extension that contributes `blueprintPackages`, into `blueprint-packages/<name>/`.
  - It then compiles the package's libraries for the workspace's languages.
  - Adding a newer version replaces the folder.

## Gap 10: smaller gaps

- **Collapse to Function in Library…** moves the selection into a function library (an existing one with the graph's language, or a new one), as Collapse to Function does within a file. As in a library, the selection may not use Self, member variables or latent nodes.

  **Built (step 3).**
  - The node menu's **Collapse to Function in Library…** lists the workspace's function libraries the graph's language can call, and **New Function Library…**, which asks where to save it (in the graph's language, its only function the collapsed one).
  - The new function goes into the library, which is saved (and so compiled); its library node takes the selection's place, wired as Collapse to Function wires its call.
  - A selection that uses the blueprint's own variables, functions, macros, custom events, dispatchers or Self (or a member node without a Target wire) can't move, and the status bar says so. Delay is refused by the library's function graph, as in any function.
- **The `subgraph` implementation kind** is in the model and schema but nothing implements it, and architecture.md still proposes `*.vfunc` files. Function libraries are that design, so the kind is removed and the doc updated.
- **Generic and wildcard code functions** stay out. Unreal rarely uses them, and they need type inference across the scanners.

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
