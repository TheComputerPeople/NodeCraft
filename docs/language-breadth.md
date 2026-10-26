# Language breadth (Phase 6 design)

Phase 6 of the [roadmap](roadmap.md): support for most languages without a hand-written adapter for each. This document records the design decisions: how language capabilities are enforced, the public API and the pack SDK, the published conformance suite, the declarative pack format, the new Tier 1 packs (C++ and Rust), and node library versioning. Language-specific background is in [language-notes.md](language-notes.md); where generated files go is in [output-placement.md](output-placement.md).

Decided before starting (2026-10-26): the Tier 1 packs in this phase are **C++ and Rust**. **Java is deferred**: this machine has no JDK, and a pack that can't run its conformance and debugging tests isn't finished. C is built as the **declarative** pack, and it doubles as the exit check's separate extension.

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

  As built: the types are in `src/core/api.ts` (and in the SDK). Another extension gets the API with `vscode.extensions.getExtension('local.blueprint-visual-scripting').activate()`. `registerLanguagePack` throws (and logs to the Output panel) when the pack's `apiVersion` differs, its id is taken or a required member is missing; `registerNodeLibrary` throws for a library name already registered. When packs change, open editors get the new language list (with capabilities), and the scans of graph libraries and project functions run again (a pack can bring a symbol importer). `registerDeclarativePack` arrives with the declarative format (step 10).
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
- **How it ships:** the fixtures (`test/fixtures/graphs`, the arena program, the test-case fixtures) are copied into the SDK. `runConformance(pack, options)` returns a report; the `blueprint-conformance` command runs it for a pack module or a declarative definition file and prints it, with a non-zero exit code on failure. A missing toolchain skips with a message, as the built-in suite does.

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

**Tier 2 symbol import** asks the language server: functions marked with a `@blueprint` comment are found with VS Code's document symbols, and their parameter and return types are read from the language server's hover or signature help and mapped back through the pack's type map; types it doesn't know become native types.

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
  - **Conformance:** every fixture passes except the arena (inheritance), which is not applicable. The duel program (the arena without inheritance, in `test/fixtures/programs`) covers objects of other classes, events bound across objects, structs, enums and several outputs in Rust and in every other language.

## Output plans and consented hooks

[output-placement.md](output-placement.md) designs placement in four parts; C++ and Rust need the parts not built yet:

- A pack's placement strategy returns an **output plan**: the generated files, extension-owned files to rewrite (`vgraph.cmake`, `src/vgraph/mod.rs`), one-time hooks to propose (an `include()` line, a fenced block) and diagnostics.
- The extension writes generated and owned files directly; it proposes each hook once per workspace as a diff and applies it as an undoable edit only when accepted, then edits only inside the fenced block. A declined hook leaves a Compiler Results warning with a quick fix that offers it again.
- Probing (reading `CMakeLists.txt`, `Cargo.toml`) is static in this phase; running CMake's File API or `cargo metadata` is left for later, so nothing runs project tooling to place files.

## Node library versioning

A node library becomes a package with a manifest, building on `node-package.schema.json`:

- **The manifest** (`*.vgraph-package.json`): `name`, `version` (semver), `nodes` (the `*.node.json` files it holds), and optional `dependencies` (package names with version ranges) and `engines` (`blueprint`: the API versions it works with). Loose `*.node.json` files outside any package keep working as today.
- **Resolution:** packages from the workspace and from `registerNodeLibrary` are resolved together. A missing dependency or one outside its range is a warning on the package (Problems panel), and its nodes still load. Two packages defining the same node type: the newer version wins, with a warning.
- **Graphs remember versions:** a graph records the version of each package whose nodes it uses (`metadata.libraries`), as it already records imported functions' signatures. Opening a graph whose packages changed major version marks those nodes as changed, with Refresh Node, as code functions do.

## Go and others

Go was named for assessment. **Fit:** good for most Blueprint concepts: structs with methods stand in for classes, interfaces are structural, and goroutines with a sleep cover Delay; there is no inheritance (like Rust) and no exceptions (errors are values, like Rust's `Result`). **Placement:** a generated file must be in its package's folder with a matching `package` clause; next to the graph works when the graph sits in a package folder. **Verdict:** a good declarative (Tier 2) pack once the format exists, with `gopls` for symbol import; not built in this phase (no Go toolchain here). Other languages are assessed the same way when someone asks for them.

## Exit check

A C language pack, written as a separate extension in `examples/c-language-pack` that uses only the public API and the SDK (a declarative definition registered through `registerDeclarativePack`), passes the published conformance suite with `gcc`: every applicable fixture prints the same output as Simulate, and every other fixture is reported not applicable because of a capability it lacks. The C++ and Rust packs pass the full suite in the repository's own tests, with their debugging checked like the Phase 5 exit check.
