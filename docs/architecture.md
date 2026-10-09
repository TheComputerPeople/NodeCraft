# Architecture Notes

## Design rule

The graph is the source of truth. It is not a JavaScript AST and it is not a C++ AST. Nodes expose typed pins and semantics; language adapters decide how those semantics execute or become source code.

## Core contracts

- `GraphDefinition`: serializable graph asset.
- `NodeDefinition`: reusable node signature and implementation metadata.
- `PinDefinition`: typed execution/data port.
- `TypeRef` (`src/core/types.ts`): canonical, language-neutral pin type with Unreal-style containers (array/set/map). Graphs and node definitions only use canonical type ids.
- `LanguagePack` (`src/core/language-pack.ts`): everything the extension knows about one target language (detection markers, capabilities, type mapping, and optionally an in-process simulator for code nodes). Built-in packs live in `src/core/languages/`. Code generation, symbol import and debugging join the interface in later phases (see `docs/roadmap.md`).
- `GraphRuntime`: reference interpreter. It is language-neutral; code nodes run only through the graph language's pack simulator.

## Function Library model

A user-authored library node can be backed by:

- `code`: target-language source templates or generated source.
- `subgraph`: a separate visual graph used as the implementation.
- `native`: extension/runtime code.

A production implementation should make subgraph-backed functions first-class assets, e.g. `*.vfunc`, and automatically expose their inputs/outputs as a node signature.

## Runtime vs code generation

The MVP runtime is intentionally small. It demonstrates execution pins, data dependencies, branching, and runtime events. A production system should compile a graph into a language-neutral IR first and then either interpret the IR or pass it to a language adapter.

## Security

Executing user-authored code nodes is equivalent to executing workspace code. A production release should make this permission explicit and integrate with VS Code Workspace Trust. Webview CSP and restrictive local-resource roots should remain enabled.
