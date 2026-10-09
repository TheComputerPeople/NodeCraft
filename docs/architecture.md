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

## File format (`.vgraph`, schema 2)

A `.vgraph` file is a `GraphDocument`, mirroring Unreal's Blueprint assets:

- `kind`: `class` (member variables, event graphs, functions, macros), `functionLibrary` (functions only, no variables) or `macroLibrary` (macros only, no variables).
- `variables`: member variables, with canonical types.
- `graphs`: each graph has an `id` unique in the file, a `kind` (`event`, `function` or `macro`), nodes, connections and comments. Function and macro graphs also have a `signature`; functions may have `localVariables`. Node ids are unique within their graph.

`schemas/graph.schema.json` is the published schema; a unit test validates the samples against it. Reroute nodes are ordinary nodes, so they need no schema support.

Migration: `parseDocument` upgrades older schemas in memory (`src/core/migrations.ts`), losslessly and keeping unknown fields. The file is rewritten in the new schema only when the document is next edited, so opening a file never marks it modified. Files from a newer schema are refused with a message asking for an extension update.

## Function Library model

A user-authored library node can be backed by:

- `code`: target-language source templates or generated source.
- `subgraph`: a separate visual graph used as the implementation.
- `native`: extension/runtime code.

A production implementation should make subgraph-backed functions first-class assets, e.g. `*.vfunc`, and automatically expose their inputs/outputs as a node signature.

## Runtime vs code generation

The MVP runtime is intentionally small. It demonstrates execution pins, data dependencies, branching, and runtime events. A production system should compile a graph into a language-neutral IR first and then either interpret the IR or pass it to a language adapter.

## Security

Executing user-authored code nodes is equivalent to executing workspace code, so the extension integrates with VS Code Workspace Trust (`capabilities.untrustedWorkspaces: "limited"`). In Restricted Mode graphs can be opened, edited and compiled, but Run and Simulate are disabled and the host refuses run requests; granting trust enables them in open editors. Compiling only writes text next to the graph, and node libraries are plain data, so neither executes anything; code runs only when a graph is run or simulated. Placement probes that execute project tooling (later phases) are gated the same way. Webview CSP and restrictive local-resource roots should remain enabled.
