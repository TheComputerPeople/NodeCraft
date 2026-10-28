# Multi-language projects (Phase 7 analysis)

Phase 7 of the [roadmap](roadmap.md) is analysis first: find where a workspace with graphs in several languages breaks, recommend what to do about each gap, then decide which to build. This document is that analysis. Each gap gives what happens today (checked against the code, with probes where the behavior wasn't obvious), the options, and a recommendation.

Written 2026-10-27, after Phase 6 (nine languages: TypeScript, JavaScript, Python, C#, C++, Rust, Java, Go, and C as a separate extension).

## What already works

- **Each graph has its own language.** The `language` field of a `.vgraph` file decides its generator, runner, debugger and palette, so TypeScript graphs in `web/` and Python graphs in `api/` live side by side.
- **Placement is per folder.** Each pack reads the project files nearest to the graph: the nearest `package.json` for JavaScript's module format, `pom.xml` or `build.gradle` for the Java package, `go.mod` for the Go import path, `.csproj` for the C# namespace, `Cargo.toml` for Rust modules ([output-placement.md](output-placement.md)).
- **Node libraries can be polyglot.** A code node carries a snippet per language (the built-in utilities carry nine). TypeScript graphs fall back to JavaScript snippets.
- **Code in another language is kept out.** A project function or function-library function in another language isn't offered in the palette, and a graph that still uses one (pasted, or after its language changed) gets a compile error: `"Slugify" is Python code (api/text.py); a TypeScript graph can't call it.`

## Gap 1: which language a new graph gets

**Today.** New Graph detects the language once, from marker files anywhere in the workspace, and takes the first pack in a fixed order that finds one: TypeScript (`tsconfig.json`), C#, C++, Rust, Java, Go, Python, then JavaScript (`package.json`). In a repository with `web/tsconfig.json` and `api/pyproject.toml`, a graph created in `api/` is TypeScript. The graph keeps whatever it got, and the language picker fixes it, but every new graph in `api/` starts wrong. There is no setting to say which language a folder uses.

**Options.**
- Detect from the graph's own folder: the nearest folder, walking up from where the graph is saved to the workspace folder, that has a marker. When one folder has markers of several packs, the existing order breaks the tie.
- A setting, `blueprintVisualScripting.defaultLanguage`, that can be set per folder (in a multi-root workspace, or a folder's `.vscode/settings.json`) and overrides detection.

**Recommendation: build both.** Small: detection already exists; it needs the save location and a resource-scoped setting.

## Gap 2: types used across languages

**Today.** A struct, enum, class or interface `.vgraph` file has one language, and the type pickers of graphs in other languages don't list it. Probing what happens when a graph uses one anyway found two bugs:

- **A type from another language disappears without an error.** A TypeScript graph with a Make Point node, where `Point` is a Python struct, compiles with no diagnostic to `console.log(formatValue(null))`: the compiler looks types up for the graph's language only, doesn't find `Point`, and uses a default value. This happens after a graph's language changes, or when nodes are pasted between folders.
- **Two types with the same name replace each other.** Struct nodes are keyed by the type's name (`struct:Point.make`), so a `Point` in `web/` and another in `api/` share node types, and whichever file loads last wins the registry. Graphs in the other language then hit the first bug. [program-structure.md](program-structure.md) says a name means one type in a workspace, as an asset name does in Unreal, but nothing reports a second declaration.

So a type that both sides of a project need, such as a request that a TypeScript front end sends and a Python back end reads, can't be shared today. It must be declared twice, under two names.

**Options.**
- **Report it.** A compile error on nodes and pins that use another language's type (`wrong-language`, as for functions), and a problem on a type file whose name is already declared elsewhere.
- **Shared types.** A struct or enum file lists several target languages and compiles to one generated file per language (`Point.vgraph.ts` and `point_vgraph.py`, each placed by its pack). Graphs in any of those languages use the one type. Every pack already generates structs and enums; the new parts are compiling one graph file to several outputs, and placement for each. Classes and interfaces stay single-language: their behavior is code, and sharing an object between languages needs a call boundary (gap 4).
- Qualifying type names by language (`struct:python/Point`). Rejected: it breaks the one-name-one-type rule and the node types in saved graphs.

**Recommendation: report it now, as a bug fix, whatever else is decided (small). Build shared structs and enums (medium).** A struct's value is already defined as a JSON object keyed by field name (that's how Print shows it), so shared types are also the format values would cross a process boundary in, if gap 4 is built later.

## Gap 3: nodes a language doesn't implement

**Today.** The palette hides project and library functions of other languages, but it offers every code node, including ones with no snippet for the graph's language. A node library written with JavaScript snippets only shows its nodes in a Python graph, and each one fails when the graph compiles: `"Double" has no Python implementation; add a "python" entry to its languages.` Declarative packs bring their own snippets for the standard library, so the same applies to an extension's node library in C.

**Options.**
- Hide nodes with no implementation for the graph's language, the same rule the palette uses for functions. The compile error stays for nodes that arrive another way (pasted, or after a language change).
- Show them greyed out with the reason. Unreal hides what doesn't apply to the current Blueprint rather than greying it, and the editor already hides what a language's capabilities can't express, so hiding is consistent.

**Recommendation: hide them (small).**

## Gap 4: calling code in another language

**Today.** A graph calls only code in its own language. What works now is a project function that crosses the boundary itself: a TypeScript function that calls the Python service over HTTP, or runs it as a subprocess, marked `@blueprint` and used as a node.

**Options.**
- **A process boundary from a shared interface.** An interface declares the functions; the callee's language gets a server stub (JSON over stdio or HTTP), the caller's a client; values cross as JSON (gap 2). This works in every language and matches how polyglot systems are built. It is large: a server and client runtime per pack, starting and stopping the other process, calls that become latent actions (they wait on another process, so they need a Completed pin like Delay), errors that cross the boundary, and debugging both sides at once.
- **C ABI and FFI.** Every language can reach C, but each differently (P/Invoke, ctypes, cgo, JNI or Panama, N-API), with native builds per platform and only C's types. Not recommended.
- **WebAssembly components.** Typed interfaces across languages, but toolchain support differs by language and is still changing, and it would add a build step to every pack. Not recommended now.

**Recommendation: don't build bindings in this phase.** Document the project-function pattern, with an example. Revisit the process boundary after the release (Phase 8) if users ask for it; shared types (gap 2) are the first part of it either way.

## Summary

| Gap | Recommendation | Size |
|---|---|---|
| 1. A new graph's language | Detect from the graph's folder, plus a per-folder setting | Small |
| 2. Types across languages | Report other-language and duplicate types (bug fix) | Small |
| | Shared structs and enums, generated for several languages | Medium |
| 3. Nodes a language doesn't implement | Hide them in the palette | Small |
| 4. Calls into another language | Document the project-function pattern; defer bindings | Small |

If all are accepted, the steps (one commit each) would be:

1. This analysis.
2. Report a type used from another language, and a type name declared twice.
3. A new graph's language from its folder, and the per-folder setting.
4. The palette hides nodes with no implementation in the graph's language.
5. Shared structs and enums: several target languages per type file, a generated file for each.
6. The cross-language pattern documented with an example; the parity checklist and status.
