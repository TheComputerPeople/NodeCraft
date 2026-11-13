# Language breadth (Phase 6 design)

Phase 6 of the [roadmap](roadmap.md): support for most languages without a hand-written adapter for each. This document records the design decisions: how language capabilities are enforced, the public API and the pack SDK, the published conformance suite, the declarative pack format, the new Tier 1 packs (C++ and Rust), and node library versioning. Language-specific background is in [language-notes.md](language-notes.md); where generated files go is in [output-placement.md](output-placement.md).

Decided before starting (2026-10-26): the Tier 1 packs in this phase are **C++ and Rust**. **Java is deferred**: this machine has no JDK, and a pack that can't run its conformance and debugging tests isn't finished. C is built as the **declarative** pack, and it doubles as the exit check's separate extension.

Changed after the exit check (2026-10-27): the JDK (Temurin 25, Maven, Gradle) and Go (with gopls and Delve) are now installed, so **Java and Go joined this phase as Tier 1 packs** before it merged (steps 14 to 18; both done, see their sections). Go was assessed below as a declarative pack, but the declarative format can't express objects, dispatchers or Delay, all of which Go can; as a Tier 1 pack it keeps them, and it imports project functions through gopls with the Tier 2 importer.

## Capabilities, enforced

`LanguageCapabilities` exists but nothing reads it yet. Rust (no inheritance) and C (no classes, containers, async or closures) make it necessary.

- **Finer flags.** Next to the existing ones (`staticTyping`, `classes`, `inheritance`, `interfaces`, `generics`, `async`, `exceptions`), packs declare `containers` (which of array, set and map they support) and `delegates` (event dispatchers and bound events, which need closures or function pointers with context). `classes` covers object references (Construct, Target pins, Self as a value); a graph file is still a class in every language, generated as a module with state where the language has no classes.
- **Nodes declare what they need.** A node definition gets an optional `requires` list of capabilities: Delay needs `async`; Construct, Cast To and object calls need `classes`; Parent calls and overrides need `inheritance`; dispatcher nodes need `delegates`; container nodes need their container. Document features are checked the same way (a Parent Class needs `inheritance`, implemented interfaces need `interfaces`, a container variable needs its container).
- **The compiler reports, the editor hides.** Compiling a graph that uses something its language can't express gives a diagnostic on the node (code `unsupported`: "Rust has no inheritance, so a class can't override its parent's function"). The editor leaves such nodes out of the palette and the action menu, and leaves unsupported choices out of type pickers and Class Settings. A graph whose language changes keeps its nodes; they get the diagnostic.

## The public API and the pack SDK

Language and framework packs can ship as separate VS Code extensions.

- **The API** is what the extension's `activate` returns, versioned (`apiVersion: 1`):
  - `registerLanguagePack(pack)`: a pack written in code (Tier 1), with the same `LanguagePack` interface the built-in packs use.
  - `registerDeclarativePack(definition)`: a declarative pack (Tier 2 and 3, below).
  - `registerNodeLibrary(library)`: node definitions with a name and version (framework packs' events and nodes).

  Each returns a disposable. A pack declares the API version it was built for; a mismatch is refused with a message naming both versions. Packs and libraries can come and go while editors are open: the language picker, the palette and compile results update.

  As built: the types are in `src/core/api.ts` (and in the SDK). Another extension gets the API with `vscode.extensions.getExtension('local.blueprint-visual-scripting').activate()`. `registerLanguagePack` throws (and logs to the Output panel) when the pack's `apiVersion` differs, its id is taken or a required member is missing; `registerNodeLibrary` throws for a library name already registered. When packs change, open editors get the new language list (with capabilities), and the scans of graph libraries and project functions run again (a pack can bring a symbol importer). `registerDeclarativePack` (step 10) throws, listing the definition's problems, when a definition can't be a pack.
- **The pack SDK** is an npm package built from this repository (`packages/pack-sdk`, `@blueprint-visual-scripting/pack-sdk`). It holds what a pack author needs and nothing that depends on VS Code:
  - the types: `LanguagePack` and its parts, the Visual IR, the canonical types;
  - helpers the built-in packs use: `CodeWriter` (with node lines for debugging), `NameScope` and `toIdentifier`, `exprType`, the value-formatting rules as reference code;
  - `declarativePack(definition)`, which turns a declarative definition into a `LanguagePack`;
  - the conformance suite (below).

  It's built from `src/core` with esbuild and `tsc --emitDeclarationOnly`. The SDK version follows the API version: an IR change that breaks packs is a new major version of both.
- **What the extension still does for every pack:** lowering graphs to IR, Simulate, placement and lifecycle, Run, Debug and Run Tests through the pack's runner and debugger descriptions. A pack only turns IR into text and says how to run it.

## The published conformance suite

The suite that keeps the built-in packs honest becomes a tool any pack can run.

- **One runner.** For each fixture graph: run it in Simulate for the expected output, compile it with the pack, run it with the pack's runner (probe, scaffold, build, run), and compare the printed lines; then do the same for its Test Case events. The repository's own conformance tests use this runner for every built-in pack.
- **Applicability.** A fixture that uses something the pack's capabilities rule out, or that compiles with only `unsupported` diagnostics (or `missing-snippet`: a library node without an implementation in the pack's language), is reported as not applicable rather than failed, so a C pack isn't failed for lacking classes. Any other compile error, a runtime difference or a crash is a failure.
- **As built** (`src/conformance/`): fixtures are graphs (`graphs/*.vgraph`), programs (`programs/<name>/`, run from the file whose metadata has the expected output) and test fixtures (`tests/*.vgraph`), with the node libraries they use (`nodes/`). Each program's files are written side by side and each file's types and classes are registered for the others, as the extension does for a workspace; `CodeGenerator.moduleName` names a file's module for languages that import by name. Fixtures run four at a time. The repository's tests run every built-in pack through it (all 19 fixtures pass in each), next to the older, more detailed conformance tests.
- **How it ships:** the fixtures (`test/fixtures/graphs`, the countdown program, the test-case fixtures) are copied into the SDK. `runConformance(pack, options)` returns a report; the `blueprint-conformance` command runs it for a pack module or a declarative definition file and prints it, with a non-zero exit code on failure. A missing toolchain skips with a message, as the built-in suite does. With `--nodes <file or folder>`, it tests a node library's examples in the pack's language instead ([node-authoring.md](node-authoring.md), gap 8).

## Declarative packs (Tier 2 and 3)

A declarative pack is a JSON file (with a schema, `schemas/language-pack.schema.json`): templates for the Visual IR plus a type map plus capabilities. Tier 2 packs pair it with symbol import through the language's language server; Tier 3 is the same format written by a user for an in-house or niche language. Loading:

- through `registerDeclarativePack` from an extension, or
- from the workspace: every `*.vgraph-language.json` file is loaded as a pack (Tier 3), reloaded on change. Workspace packs only produce text; running them executes commands, so Run, Debug and Run Tests stay off in untrusted workspaces as for every pack.

The format:

- **Identity:** `id`, `displayName`, `apiVersion`, `fileName` (a pattern such as `{snake}_vgraph.c`), `workspaceMarkers`.
- **Capabilities** as above.
- **Types:** the canonical type map (`int` → `long long`), container forms (`array<{T}>`) where supported, and how each type's default value and literals are written.
- **Naming:** the case style of classes, functions, variables and parameters, and the reserved words.
- **Templates** for the file, for each IR statement and each expression kind. A small, logic-less syntax: `{{field}}` inserts an already-written child (an expression, a name), `{{text field}}` the field converted to text, `{{#each field}}…{{/each}}` repeats, and a block placeholder on its own line (`{{> then}}`) inserts statements indented to the placeholder's column. Templates never compute; anything the IR doesn't already say (an operator's spelling, a type's name) comes from a table in the definition.
- **Helpers:** named pieces of support code (value formatting, a latent queue) that the file template includes only when a template uses them.
- **Runner and debugger:** the same fields as `CodeRunner` and `CodeDebugger`, as data: candidate commands, an optional build command and the run command with placeholders for the file, the class and the arguments.

An IR construct without a template is reported as `unsupported` on the node that produced it, so a partial pack works for what it covers. The generator writes node lines, so breakpoints and stepping work for declarative packs through their debugger description.

**As built** (`src/core/declarative/`, the reference is in the SDK's README):

- **Loading:**
  - `declarativePack(definition)` checks a definition and returns a `LanguagePack`. The checks cover required fields, the API version and parsing every template; problems are listed together.
  - `registerDeclarativePack` is in the API.
  - Workspace `*.vgraph-language.json` files are loaded and reloaded by `src/extension/workspace-packs.ts`, with their problems on the file in the Problems panel. A pack whose id is taken isn't loaded.
  - `schemas/language-pack.schema.json` validates the files in the editor.
  - The SDK exports the loader and template functions and ships the schema. `blueprint-conformance` accepts a definition file.
- **Capabilities:** declarative packs can't express object references, inheritance, interfaces, event dispatchers or latent actions in this phase. A definition that claims them is refused, so fixtures needing them are not applicable. The format covers the procedural core: variables, functions with several outputs, flow control, loops, containers, structs and enums, code nodes, tests and Main.
- **Templates:** besides `{{field}}`, `{{#each}}` and block placeholders, there are `{{#if}}`/`{{#unless}}` presence tests. The design's `{{text field}}` isn't needed: the emitter gives each value the forms templates need (a literal's `text`, `quoted`, `escaped` and `cQuoted`; `text` beside `value` for Print). Type-dependent spellings are templates keyed by type (`toText.float`, `binary.==.string`), tried from the most specific.
- **The emitter** decides what's the same for every pack: names (styles and reserved words from the definition), which conversions are needed, coercing a literal to its target type, container literals, a function's default return, and node comments.
  - Where each node's code starts, and each function's opening, are marked in the rendered text and collected into node lines and breaks. Breakpoints and stepping work as for Tier 1 packs.
  - A missing template is an `unsupported` diagnostic on the node being written. Generators can now return diagnostics (`GeneratedCode.diagnostics`); errors mean no output.
- **Support code** (`helpers`) is included when generated code uses its identifier, and then the support code it uses in turn, in the definition's order.
- **Snippets:** a pack can implement library nodes that have no snippet in its language (`snippets`, by node type). This became `CodeGenerator.snippets`, which lowering consults when a node's own `languages` map has no entry, so Tier 1 packs can use it too.
- **Runner and debugger as data:** arguments, the executable, scaffold files and the launch configuration are templates over the run's facts. `{{args}}` and `{{tests}}` expand to several arguments.
- **The test pack**, Mini JS (`test/fixtures/declarative/minijs.vgraph-language.json`), uses the library nodes' JavaScript snippets and Node.js. It passes the 16 fixtures it can express, and the other 4 (dispatchers, Delay, the two object programs) are not applicable. The integration tests load it from a workspace file, and Debug a graph through its debugger description with VS Code's JavaScript debugger.

**Tier 2 symbol import** asks the language server: functions marked with a `@blueprint` comment are found with VS Code's document symbols, and their parameter and return types are read from the language server's hover or signature help and mapped back through the pack's type map; types it doesn't know become native types.

As built (`src/core/importing/language-server.ts`, and `symbolScan` in `src/extension/project-functions.ts`):

- **The pack's part:** a `SymbolImporter` can have `languageServer` instead of `scan`. A declarative definition's `importer` gives it: the extensions, the doc comment prefixes, how a parameter is written (`type name`, `name: type`, `name type`), where the return type is (`before` the name or `after` the parameters), words that aren't part of a type, how "returns nothing" is written, and the namespace separator.
- **Finding functions:** the extension asks for the document's symbols. Functions at the top level or in namespaces and modules count; methods don't.
  - Only functions with `@blueprint` in the lines above them are looked at, unless `exposeAllFunctions` is on. Each gets a hover request.
  - A language server with no symbols yet for a marked file is asked again (waiting 1, 2, 4… seconds, about a minute in all), since it may still be starting.
- **Reading the hover:**
  - The signature is the line in the hover's code blocks (or its text) that calls the function by name, continued to its closing parenthesis. Hover formats differ by server; tests cover the TypeScript server's, clangd's and rust-analyzer's.
  - Parameters keep literal defaults. Variadic, generic, `self` and unnamed parameters are skipped with the reason.
  - The doc comment comes from the file: the comment lines above the declaration, past attributes and the declaration's own earlier lines.
- **Types** map back through the pack's own spellings of the canonical types, and arrays and sets of them. A spelling two types share goes to float before int, so JavaScript's `number` is a float. Other types become native types.
- **Several packs per extension:** project function scanning now lets every pack that reads an extension scan the file, so the C and C++ packs can both read headers. Each pack's functions are nodes of its own language.
- **Tested** with VS Code's built-in TypeScript server: the Mini JS pack imports a JSDoc-marked function from a `.js` file. The generated code `require`s it, and it runs.

## C++ (Tier 1)

- **Files:** `Name.vgraph.h` (the class) and `Name.vgraph.cpp` (its methods), next to the graph; the `.cpp` includes the header by relative path.
- **Representation:** `object:<Class>` is `std::shared_ptr<Class>` (Construct is `std::make_shared`); `string` is `std::string`; arrays, sets and maps are `std::vector`, `std::unordered_set` and `std::unordered_map`; event dispatchers hold `std::function`s; interfaces are abstract classes with pure virtual functions; Cast To is `std::dynamic_pointer_cast`; errors are exceptions; Delay uses a latent queue run after Start, as in C# and Python.
- **Run:** the extension writes a scaffold (a `main` that constructs the class, calls `start`, then `Main`, then the latent queue; or the test methods) and builds it with the first compiler found (`g++`, `clang++`, then MSVC's `cl`) at C++20, or with the runCommands setting.
- **As built** (`src/core/languages/cpp.ts`, `cpp-runtime.ts`):
  - **Support code:** each header carries the support code (`vgraph::` and the `vgraph_format`/`vgraph_json` overloads) behind one include guard.
  - **Types:** values print through overloads chosen by their static types, with `std::any` only for untyped values. Maps are `vgraph::Map` (insertion-ordered) and sets `std::set`. User types are written `::Name`, because a member may share its type's name.
  - **Snippets:** standard library and container snippets live in a table per file (`CPP` in `stdlib.ts` and `containers.ts`). Container parameters are forwarding references, so a node changes the container it was given. Text is UTF-8, so lengths count code points; To Upper and To Lower change ASCII letters only.
  - **Compilers:** Run builds with `g++` or `clang++` (MSVC's `cl` isn't supported yet).
  - **Tests:** a class gets `run_test(name)`, because C++ has no reflection for the scaffold to find test methods by name.
  - **Conformance:** all 19 fixtures pass.
  - **Placement:** `cppPlacement`. A root `CMakeLists.txt` gets an owned `vgraph.cmake` listing the generated sources, and a fenced block that includes it, adds the sources to the first `add_executable`/`add_library` target and sets `cxx_std_20`. A project whose `file(GLOB ...)` already picks up `.cpp` files needs nothing; one without a target, or a Meson or Make project, gets a warning naming what to add. A test builds a project registered this way with CMake and Ninja.
  - **Symbol import:** `src/core/importing/cpp-scanner.ts` reads headers only (`.h`, `.hpp`, `.hh`, `.hxx`), because generated code includes the header to call a function. A namespaced function is called as `ns::name`. Parameters are by value or const reference; pointers, other references, templates and `static` functions are reported with the reason.
  - **Run:** builds the sources the generated file needs: the generated files it includes, transitively, and the implementation file next to each project header (`cppRunSources`).
  - **Debugging:** `cppdbg` with `miDebuggerPath: gdb` (found on the PATH), or lldb on macOS, launching the scaffold built with `-g -O0`. The Debug integration test and the exit check pass for C++ with the C/C++ extension loaded.
- **Placement:** CMake projects get an extension-owned `vgraph.cmake` listing the generated sources and a one-time, consented `include()` plus `target_sources` in `CMakeLists.txt`, through the output plan machinery below; other build systems get a Compiler Results note listing the files to add.
- **Symbol import:** a scanner for free functions marked `// @blueprint` in headers and sources, with the same marker options as the other languages (category, display name, pure).
- **Debugging:** the C/C++ extension (`cppdbg` with gdb or lldb; `cppvsdbg` for MSVC builds), launching the scaffold built with debug information.

## Java (Tier 1)

- **Files:** `ClassName.java` (the class's name, as Java requires) next to the graph. Its `package` is the graph's folder relative to the source root that holds it: `pom.xml`'s `<sourceDirectory>`, else `src/main/java` (Maven's and Gradle's default). A graph outside every source root gets no package and a warning when the workspace has a Maven or Gradle build, since the build won't compile the file there. Build tools compile everything under their source roots, so nothing needs registering. (This simplifies output-placement.md's plan of moving such files into the source tree: the file stays next to its graph, as everywhere else.)
- **Representation:** `int` is `long`, `float` `double`, `bool` `boolean`, `string` `String`, untyped values `Object`; containers `ArrayList`, `LinkedHashSet` (printed in ascending order) and `LinkedHashMap` of boxed types. Classes, inheritance (`extends`), interfaces, Cast To (`instanceof`) and exceptions map directly. Structs are records (immutable, so Set Members makes a new one, which is Unreal's value semantics); enums are Java enums. A function with several outputs returns a record of them. Dispatchers hold handlers keyed by object and function, so Unbind finds the handler Bind added. Delay uses the latent queue the other packs use, shared between classes through the system properties (as C# shares it through the AppDomain).
- **Run:** `javac` compiles the generated file, the project files it uses and a small launcher into a scratch folder; `java` runs the launcher, which calls Start, then Main, then the latent actions; with `--test`, each test on a new object.
- **Symbol import:** `public static` methods marked `@blueprint` in a Javadoc comment, read by a scanner like C#'s; generated code calls them by their qualified class name, and Run compiles their files.
- **Debugging:** Microsoft's Debugger for Java (`java` launch configurations, extension `vscjava.vscode-java-debug`), launching the launcher after a debug build.
- **As built** (`src/core/languages/java.ts`):
  - **Generator:** adapted from the C# pack.
  - **Several outputs:** a function with several outputs returns an `Object[]` rather than a record. One record type can't serve an override, an interface implementation and a library caller alike, and callers read each element back with a cast.
  - **Literals and comparison:** whole-number literals are longs (`5L`), so they box to `Long` in containers. `==` is kept for primitives, enums and object references; text, containers and structs compare with `Objects.equals`.
  - **Reachability:** a default `return` is added only where the end of the body can be reached. A `while` on a constant gets a non-constant condition, because Java refuses code it can't reach.
  - **Class and file names:** a graph whose name differs from its file's generates a package-private class, since a public class must be in a file of its name.
  - **Snippets:** the standard library and container snippets are the `JAVA` tables in `stdlib.ts` and `containers.ts`.
  - **Run:** `javac` compiles the launcher (`BlueprintRun.java`) with the generated and project files into the scaffold's `classes`, and `java` runs it with UTF-8 output.
  - **Conformance:** all 20 fixtures pass, including both object programs.
  - **Placement:** `javaProject` finds the nearest `pom.xml`, `build.gradle.kts` or `build.gradle`, and its source roots (`<sourceDirectory>` and `<testSourceDirectory>`, else `src/main/java` and `src/test/java`).
    - The graph's folder under a root is its package. A folder that isn't a Java identifier leaves the class in the default package.
    - A generated file outside every root gets the `java-outside-source-root` warning. Graph libraries' functions are qualified by their package too.
  - **Symbol import:** `src/core/importing/java-scanner.ts` reads `public static` methods marked `@blueprint` in a Javadoc comment, in top-level and nested classes, interfaces, enums and records. Generated code calls them as `package.Class.method`.
    - Types map exactly, as Rust's do: `long`, `double`, `boolean`, `String` and `ArrayList` of their boxed types. `int` and the rest are native, because Java won't narrow the generated `long` arguments to an `int` implicitly.
    - Instance, generic and varargs methods, and methods that declare checked exceptions, are reported with the reason.
  - **Run with project methods:** javac gets the project's source roots as its `-sourcepath`, so the classes a project method uses compile too. A test runs this against a Maven-layout project.
  - **Debugging:** the Debug test and the Phase 5 exit check pass with the Debugger for Java.
    - Its `evaluate` only works inside a project the Java language server knows, which Run's launcher isn't. So reading a pin falls back, for any debugger, to finding the name among the frame's variables (or the fields of `this`) when `evaluate` fails.
    - A debugger can now say how its values show as the graph shows them (`CodeDebugger.displayValue`): Java's `30.0` shows as `30`.

## Go (Tier 1)

- **Files:** `name_vgraph.go` next to the graph. Its `package` clause is the package of the other `.go` files in the folder, else the folder's name. A Go package's files share one namespace, so the support code (formatting, the latent queue, dispatchers) is one extension-owned `vgraph_runtime.go` per package folder, kept by the output plan, and generated code calls other graphs in the same folder directly.
- **Representation:** `int` is `int`, `float` `float64`, `bool`, `string` and `any`; arrays are slices, and sets and maps are the runtime's insertion-ordered types (Go's maps have no order). A class is a struct with a constructor and pointer-receiver methods; an object reference is a pointer. Public members are exported (capitalized) so other packages can use them. Interfaces are Go interfaces and Cast To a type assertion. There is no inheritance (embedding has no virtual dispatch), as in Rust. Errors are panics, recovered by Run and the tests.
- **Run:** a scratch module whose `main.go` runs Start, Main and the latent actions (or the tests). When the graph's folder is in a module and isn't `package main`, the scratch module requires the project's module through a `replace` directive and imports the package; otherwise the folder's Go files are copied into the scratch module.
- **Symbol import:** exported functions marked `// @blueprint`, found through gopls (the Tier 2 importer); generated code calls them directly in the same package, else through an import of their package.
- **Debugging:** Delve through the Go extension (`go` launch configurations, extension `golang.go`).
- **As built** (`src/core/languages/go.ts`, `go-runtime.ts`):
  - **Containers and outputs:** arrays are pointers to slices (`*[]T`), so a node changes the caller's array, as references do in the other packs. Sets and maps are the runtime's `*VgSet[T]` and `*VgMap[K, V]`. Several outputs are Go's own multiple results; one output of a pure call is an immediately called function.
  - **Values:** untyped values (a dispatcher's arguments, `any` slots) are read back with the runtime's `VgAs[T]`, which gives the zero value for nothing. Go computes constant expressions exactly (`0.1 + 0.2` would be `0.3`), so Add's literal operands go through `VgFloat`, and the sum rounds as Blueprint's float arithmetic does.
  - **Compile rules:** Go refuses unused imports and unread variables. Imports are added only for the packages the code names, and a blank assignment covers a function's variables.
  - **Snippets:** the `GO` tables in `stdlib.ts` and `containers.ts`.
  - **Run:** the scratch module maps the generated file and the package's other files into `vg/` with `go build -overlay` (core code can't read files, but it can name them). It writes the support code there for the package, and builds `run`. `GOTOOLCHAIN=local` and a local `replace` mean nothing is downloaded.
  - **Conformance:** every fixture passes except the countdown (inheritance), which is not applicable, as for Rust.
  - **Placement:** `goPackage` takes the package from the folder's other files (else the folder's name) and its import path from the nearest `go.mod`. `goPlacement` owns `vgraph_runtime.go` in each folder with generated files, in their package; a test builds a module (`go build ./...`) with it. A graph in `package main` gets a warning: nothing can import it, so Run can't build it.
  - **Symbol import** goes through gopls with the Tier 2 importer: a Tier 1 pack can use the language server too.
    - Generated code calls a function in its own package directly, and imports any other package by path. `GenerateOptions.packagePath` says which package is its own.
    - The signature parser now gives grouped parameters (`a, b float64`) their shared type.
  - **Run with project packages:** the scratch module `require`s the project's module and `replace`s it with its folder. The package's other files are added to the overlay.
  - **Debugging:** Delve through the Go extension (`dlv-dap`, `exec` mode), with `-gcflags=all=-N -l`. The program's files are the overlay's (`vg/…`, written with "/"), so `substitutePath` maps the generated file's folder, as VS Code writes it, to them. The Debug test and the exit check pass, and so does a gopls import test.

## Rust (Tier 1)

- **Capabilities:** no inheritance (no Parent Class, overrides or Cast To a class); interfaces are traits.
- **Files:** `name_vgraph.rs`, next to the graph inside the crate's source tree, otherwise `src/vgraph/`.
- **Representation:** objects are `Rc<RefCell<T>>`; strings `String`; containers `Vec`, `HashSet` and `HashMap`; dispatchers hold boxed closures; errors are panics with the error text, which Run reports (Blueprint's runtime errors stop the run, so a panic matches). Delay uses the same kind of latent queue as the other packs, with `std::thread::sleep`; no async runtime or other crate is needed, so generated code builds offline.
- **Run:** a scaffold Cargo project whose `main.rs` includes the generated module with `#[path]`, built and run with Cargo. Run Tests generates the tests as a `#[cfg(test)]` module in the generated file and runs `cargo test`.
- **Placement:** the `mod` declaration lives in a fenced, extension-managed block in the parent module, added once with consent (`src/vgraph/mod.rs` is fully owned when output goes there).
- **Symbol import:** a scanner for `pub fn` items marked `/// @blueprint`.
- **Debugging:** `cppvsdbg` (C/C++ extension) for MSVC builds on Windows, CodeLLDB (`lldb`) elsewhere.
- **As built** (`src/core/languages/rust.ts`, `rust-runtime.ts`):
  - **Objects:** objects are `Rc<Self>`, with a weak reference to themselves for Self, bound events and latent actions. Every member and stored output is a `RefCell`, read and written through `vgraph::get`/`vgraph::set`, so no borrow outlives a call. That lets an object be called back while one of its methods runs, which a `RefCell` around the whole object would turn into a panic.
  - **Containers and values:** sets and maps are the runtime's own (`vgraph::Set`, an insertion-ordered `vgraph::Map`), needing only `PartialEq`/`PartialOrd` because `f64` has neither `Ord` nor `Hash`. Untyped values are `vgraph::Value`.
  - **Runtime:** a crate has the support module once (`vgraph_runtime`), and generated modules refer to each other as `crate::<module>`. Rust's standard library has no random numbers or regular expressions, so the runtime has an xorshift generator and the plain-number checks String To Float and String To Int need.
  - **Run and tests:** Run builds a scaffold Cargo project with `cargo run`. Run Tests uses its `--test` mode, as C++ does, rather than `cargo test`, so tests report the same way in every compiled language.
  - **Interfaces:** traits are deferred, so the pack says it has no interfaces. Casting an object to a trait at runtime needs more machinery than this phase gives it.
  - **Conformance:** every fixture passes except the countdown (inheritance), which is not applicable. The pair program (the countdown without inheritance, in `test/fixtures/programs`) covers objects of other classes, events bound across objects, structs, enums and several outputs in Rust and in every other language.
  - **Placement:** `rustPlacement`. Generated files stay next to their graphs. Every generated module is declared at the crate root, not in its parent module, so generated code's `crate::name_vgraph::` paths are the same in the project and in Run's scaffold:
    - The extension owns `src/vgraph_runtime.rs`.
    - A fenced block in `src/lib.rs` (else `src/main.rs`) declares the runtime and each generated file, with `#[path]` when it isn't directly in `src/`. A new block goes after the root's last `mod x;` or `use …;` line.
    - Each crate of a workspace gets its own block. A crate whose last graph is deleted keeps an emptied block, so no declaration names a deleted file.
    - A generated file outside a crate, or a crate with no root file, gets a warning.
    - A test builds and runs a crate registered this way with Cargo.
  - **Symbol import:** `src/core/importing/rust-scanner.ts` reads `pub` and `pub(crate)` free functions marked `/// @blueprint`, in the file's module or in its inline modules. A function's module comes from its file's place under the crate's `src/` (`src/game/combat.rs` is `game::combat`; `mod.rs`, `main.rs` and `lib.rs` follow Rust's rules), and generated code calls it as `crate::game::combat::name`. In a workspace (since Phase 11), modules are named with their crate (`corpus_core::text`), and a graph calls another crate's code by that name, which its crate has as a dependency; Run's scratch crate takes the code's crate's name (`extern crate self as corpus_core;`). Parameters are owned values (`f64`, `i64`, `bool`, `String`, `Vec<T>`), or shared borrows of a text or a list (`&str`, `&String`, `&[T]`, `&Vec<T>`, since Phase 11), which generated code passes as a borrow of its value; other references, generics, `async`, `unsafe`, `extern` and methods are reported with the reason, and `#[cfg(test)]` code is left out.
  - **Run with project functions:** the scaffold declares the crate's top-level modules (those its root declares, minus the generated ones) inside an inline module whose `#[path]` is the crate's `src/` folder, and re-exports them at the root. Each module then loads with its own submodules exactly as in the crate, and `crate::` paths between them resolve (`rustRunSources`, `rustCrateModules`). It does this only when the graph calls project functions. A project module that needs the crate's dependencies doesn't build under Run yet.
  - **Debugging:** on Windows, the C/C++ extension's `cppvsdbg` debugs the MSVC toolchain's output; elsewhere, CodeLLDB (`lldb`, with native expressions). A pack's debugger can now name a different type and extension per platform (`CodeDebugger.platforms`). Debug builds the scaffold with `cargo build` and launches `target/debug/blueprint_run`. Pins read fields through their `RefCell` (`self->score.value.value`).
    - A step into a method now goes on, line by line, past the method's opening to its first node's code, for every language. The Visual Studio debugger can't read parameters before then.
    - Decimals the Visual Studio debugger pads (`30.000000000000000`) are shown in their shortest form.
    - The Debug integration test and the exit check pass for Rust with the C/C++ extension on Windows. CodeLLDB isn't installed here, so the non-Windows configuration is covered only by a unit test.

## Output plans and consented hooks

[output-placement.md](output-placement.md) designs placement in four parts; C++ and Rust need the parts not built yet:

- A pack's placement strategy returns an **output plan**: the generated files, extension-owned files to rewrite (`vgraph.cmake`, `src/vgraph/mod.rs`), one-time hooks to propose (an `include()` line, a fenced block) and diagnostics.
- The extension writes generated and owned files directly; it proposes each hook once per workspace as a diff and applies it as an undoable edit only when accepted, then edits only inside the fenced block. A declined hook leaves a Compiler Results warning with a quick fix that offers it again.
- Probing (reading `CMakeLists.txt`, `Cargo.toml`) is static in this phase; running CMake's File API or `cargo metadata` is left for later, so nothing runs project tooling to place files.

## Node library versioning

A node library becomes a package with a manifest, building on `node-package.schema.json`:

- **The manifest** (`*.vgraph-package.json`): `name`, `version` (semver), `nodes` (the `*.node.json` files it holds) and/or `graphs` (the `.vgraph` libraries, structures and enumerations it holds; [node-authoring.md](node-authoring.md), gap 9), and optional `dependencies` (package names with version ranges) and `engines` (`blueprint`: the API versions it works with). Loose `*.node.json` files outside any package keep working as today.
- **Resolution:** packages from the workspace and from `registerNodeLibrary` are resolved together. A missing dependency or one outside its range is a warning on the package (Problems panel), and its nodes still load. Two packages defining the same node type: the newer version wins, with a warning.
- **Graphs remember versions:** a graph records the version of each package whose nodes it uses (`metadata.libraries`), as it already records imported functions' signatures. Opening a graph whose packages changed major version marks those nodes as changed, with Refresh Node, as code functions do.

As built (`src/core/node-packages.ts`, `src/extension/node-libraries.ts`):

- **Node files** are checked as they're written ([node-authoring.md](node-authoring.md), gap 8). `schemas/node.schema.json` validates them in the editor, with completion. Warnings mark a snippet's `${pin}` with no such input, and a type another file defines too. Information marks a language the workspace's graphs use that the node has no snippet for. **New Node** (Command Palette, or a folder's menu in the Explorer) writes one to start from.
- **Manifests** are checked: the name, a semantic version, the node files and valid ranges. `schemas/node-package.schema.json` validates them in the editor. A manifest's `nodes` are paths or globs relative to it. Node files no package holds load on their own, as before.
- **Ranges** follow npm's syntax as far as packages use it: exact versions, `^`, `~`, `1.x`, `*`, comparisons and `||`. Prereleases come before their release and don't match ranges of releases.
- **Resolution:** workspace packages and the libraries other extensions register (`registerNodeLibrary`, which now takes optional `dependencies` and `engines`) are resolved together. A package's nodes carry it (`NodeDefinition.library`).
  - These are warnings on the manifest in the Problems panel, and the nodes still load: a missing dependency or one out of range, `engines.blueprint` not matching the API version, two packages with one name (the newer is used), and two packages defining one node type (the newer is used).
  - A package's node wins over a loose file's.
- **Graphs remember versions:** saving a graph records each package's version the first time the graph uses it, and drops packages it no longer uses.
  - A recorded version of an older major version is a warning on the package's nodes, in the editor and when compiling (`library-changed`). The graph still compiles, since its nodes' pins come from the current definitions.
  - **Refresh Node** (or Refresh All Nodes) rebinds that package's nodes in the file, keeping the wires that still fit, and records the new version. It covers all of the package's nodes at once, because the graph records one version per package.
  - A new minor or patch version changes nothing.

## Go and others

Go was named for assessment. **Fit:** good for most Blueprint concepts: structs with methods stand in for classes, interfaces are structural, and goroutines with a sleep cover Delay; there is no inheritance (like Rust) and no exceptions (errors are values, like Rust's `Result`). **Placement:** a generated file must be in its package's folder with a matching `package` clause; next to the graph works when the graph sits in a package folder. **Verdict:** a good declarative (Tier 2) pack once the format exists, with `gopls` for symbol import; not built in this phase (no Go toolchain here). Other languages are assessed the same way when someone asks for them.

## Exit check

A C language pack, written as a separate extension in `examples/c-language-pack` that uses only the public API and the SDK (a declarative definition registered through `registerDeclarativePack`), passes the published conformance suite with `gcc`: every applicable fixture prints the same output as Simulate, and every other fixture is reported not applicable because of a capability it lacks. The C++ and Rust packs pass the full suite in the repository's own tests, with their debugging checked like the Phase 5 exit check.

**Passed** (October 2026):

- **The C pack** is `c.vgraph-language.json` plus a short `extension.js` that registers it.
  - A graph becomes a struct of its variables and functions taking a pointer to it. Strings are immutable UTF-8 `const char*`. Untyped values are a tagged union, which led to optional `box.<type>` and `unbox.<type>` templates in the format.
  - Several outputs come back through pointer parameters. That led to `results` in the `return` context, and the call's name, arguments and every output in `callResults` and `callOutput`; one output of a pure call is a GNU statement expression.
  - Errors and failed tests use `setjmp`/`longjmp`. Its 36 standard library nodes are the definition's `snippets`.
  - Run's scaffold `main.c` includes the generated file and runs Start or the tests. Debug uses `cppdbg` with gdb.
- **Conformance:** the C pack passes all 15 fixtures it can express, from the SDK's `blueprint-conformance` and in the repository's tests. The containers, dispatcher, Delay and two object-program fixtures are not applicable, each for a capability C lacks. The C++ and Rust packs pass every fixture except Rust's countdown (inheritance).
- **Debugging:** the integration suite loads the C extension next to this one. It compiles and runs a C graph on every run, and with the C/C++ extension loaded it passes the Debug test and the Phase 5 exit check in C.
  - The exit check showed that code a file template writes after the functions (C's entry points) was taken for the last function's last node. The emitter now marks where each function ends too.
- **The fixture node libraries** (`Double`, `Fail`) gained C snippets, as user node libraries carry one per language.
