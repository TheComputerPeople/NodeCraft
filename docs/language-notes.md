# Language notes

Planning notes for language packs beyond the first three (TypeScript, Python, C#). They record what each language means for the [roadmap](roadmap.md)'s design (code generation, the canonical type system, pack capabilities, generated code committed next to each graph), so the core doesn't harden around assumptions these languages can't meet. They are notes, not commitments: the order and scope of these packs is decided in Phase 6.

## Summary

| Language | Fit with Blueprint concepts | Hardest problem | Generated code next to the graph | Suggested priority |
|---|---|---|---|---|
| JavaScript | Good, minus static types | Matching the project's module format | Works | Right after TypeScript (already a pack) |
| C++ | Very good; closest to Unreal | Object ownership, build-system registration | Needs build-file registration | First after C# |
| Rust | Partial: no classes or inheritance | Borrow checker vs. shared mutable graph state | Needs a `mod` declaration | After C++ |
| Java | Very good | File and package placement rules | Conflicts unless the graph sits in the source tree | After Rust |
| C | Weak: no classes, containers, exceptions or async | Memory management for strings and containers | Needs build-file registration and a header | Last; Tier 2 or 3 |

Cross-cutting conclusions:

- **The capability flags are essential, not optional.** Rust and C lack whole categories (inheritance, classes, exceptions). The editor must hide those features per language instead of letting graphs fail at compile time.
- **Placement must follow each language's rules.** "Generated code next to the graph" works directly for TypeScript, JavaScript, Python and C# (SDK-style projects compile every `.cs` file by default). C, C++, Rust and Java need either registration in the build (CMake, `mod` declarations) or a different output location (Java's package directories). [output-placement.md](output-placement.md) designs a detection-based strategy for each.
- **Object references need an ownership policy per pack.** Garbage-collected languages (JavaScript, Java, C#, Python) pass references freely. C++ and Rust must choose a representation (`std::shared_ptr`, `Rc<RefCell<T>>`, …), and C must manage memory explicitly. The canonical `object:<Class>` type stays the same; the pack decides the representation.
- **Error handling differs in kind.** Exceptions (C++, Java, JavaScript), result values (Rust) and error codes (C) all need to map from Blueprint's model, where most nodes simply succeed. Packs should get a way to surface failures, for example as an optional failure exec pin on nodes that can fail.

## JavaScript

Already shipped as a pack (`src/core/languages/javascript.ts`). It shares type mapping and the in-process simulator with TypeScript.

- **Fit:** classes, inheritance, async and exceptions all map directly. No static types, interfaces or generics; the pack's capabilities already say so.
- **Types in generated code:** emit JSDoc annotations from the same type mapping as TypeScript, so projects using `// @ts-check` or `checkJs` still get type checking of generated files.
- **Module format:** generated code must match the project: ESM or CommonJS, decided by `"type"` in the nearest `package.json`. Emitting `.mjs` or `.cjs` sidesteps the question but looks foreign in most projects; detecting the format is better.
- **Runtime differences:** Node, browsers, Deno and Bun share the language but not the APIs (file system, process, DOM). Core nodes should stay runtime-neutral; runtime-specific nodes belong in framework packs.
- **Tooling:** symbol import via the TypeScript language service (it understands JavaScript); debugging via VS Code's built-in JavaScript debugger; no build step required.
- **Priority:** most of the code generator is shared with TypeScript (emit TypeScript, drop the types), so a JavaScript pack can follow the TypeScript pack closely, possibly within Phase 1.

## C++

The language Unreal developers already know, so demand is likely highest here.

- **Fit:** classes, inheritance, interfaces (abstract classes), generics (templates), exceptions and async (`std::future`, C++20 coroutines) all exist. Every Blueprint concept has a direct counterpart.
- **Object ownership:** the pack must pick one representation for `object:<Class>` pins. `std::shared_ptr` is safest for generated code; raw pointers or `std::unique_ptr` are faster but force lifetime rules onto graphs. This should be a pack setting with a safe default.
- **Containers:** `std::vector`, `std::unordered_set` and `std::unordered_map` for array, set and map.
- **Build integration:** C++ has no single build system (CMake, MSBuild, Meson, Bazel, Unreal Build Tool). Generated `.h`/`.cpp` pairs must be added to the build unless the project globs sources. Start with CMake and document manual registration for the rest.
- **Symbol import:** clangd (LSP) or libclang. Overloads, templates, macros and default arguments make reliable import harder than in any other language listed here; expect "expose explicitly" markers to matter most.
- **Debugging:** the Microsoft C/C++ extension (cpptools) or CodeLLDB, both through DAP.
- **Unreal itself:** a framework pack could target Unreal C++ (`UCLASS`, `UFUNCTION`, `TArray`, `TMap`). That is an option for later, not part of the core; the roadmap's non-goal of reproducing the engine still holds.

## Rust

- **Fit:** structs with `impl` blocks stand in for classes; traits map to interfaces; generics and async exist. There is **no inheritance**, so parent classes and inheritance-based **Cast To** are unavailable. Casts could map to enum matching or `Any` downcasting later.
- **Ownership and borrowing:** the biggest challenge. Blueprint graphs freely share and mutate state (member variables read and written from several graphs). Generated code will likely need `Rc<RefCell<T>>` (or `Arc<Mutex<T>>` for threads) for object references and shared variables, and clones for values. Correct but non-idiomatic code is acceptable for a first pack.
- **Errors:** no exceptions. Fallible operations return `Result<T, E>`, which suggests failure exec pins rather than hidden panics.
- **Async:** the language has `async`/`await` but no built-in executor. Latent nodes such as Delay need a chosen runtime (Tokio is the de facto default); make it a pack setting.
- **Build integration:** Cargo is the single standard, which makes builds easy. Every generated file must still be declared with `mod` in its parent module; the pack has to add or check that declaration.
- **Tooling:** rust-analyzer (LSP) for symbol import; CodeLLDB for debugging.

## Java

- **Fit:** classes, single inheritance, interfaces, generics and exceptions all map directly; async via `CompletableFuture` or virtual threads.
- **File placement:** a public class must live in a file with the same name, and build tools (Maven, Gradle) expect files under `src/main/java/<package path>/`. Generated code can only sit next to its graph when the graph itself lives in the source tree. Otherwise the pack needs an output-path rule mapping graphs into the package tree. This is the clearest exception to decision 3.
- **Checked exceptions:** calling user methods that declare checked exceptions forces generated methods to declare or catch them. This needs a policy (wrap in unchecked exceptions, or expose failure exec pins).
- **Generics and primitives:** generic containers can't hold primitives, so `array<int>` becomes `List<Integer>` (boxing). That's acceptable, but the type mapping must handle it.
- **Tooling:** Maven or Gradle builds; the Eclipse JDT Language Server (Red Hat's Java extension) for symbol import; Microsoft's Debugger for Java through DAP.

## C

- **Fit:** weakest of the group. No classes, inheritance, interfaces, generics, exceptions, async or standard containers. Classes become structs plus functions taking a pointer to the struct; event dispatchers become function pointers with a context pointer; errors become return codes.
- **Memory management:** strings and containers in graphs need explicit allocation and freeing. A small runtime support library shipped with the pack (string, dynamic array and map helpers) is probably unavoidable, which conflicts somewhat with generated code being self-contained.
- **Latent actions:** with no async model, Delay and similar nodes need callbacks or generated state machines. Reasonable to leave them unsupported (capability off) at first.
- **Build integration:** like C++: no single build system; generated `.c`/`.h` pairs must be registered.
- **Tooling:** clangd for symbol import (headers make signatures easy to read); cpptools or CodeLLDB for debugging.
- **Priority:** last, and a good candidate for the declarative Tier 2 or 3 pack format rather than a hand-written Tier 1 pack.
