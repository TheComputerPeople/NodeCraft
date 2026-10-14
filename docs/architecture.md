# Architecture Notes

## Design rule

The graph is the source of truth. It is not a JavaScript AST and it is not a C++ AST. Nodes expose typed pins and semantics; language adapters decide how those semantics execute or become source code.

## Core contracts

- `GraphDefinition`: serializable graph asset.
- `NodeDefinition`: reusable node signature and implementation metadata.
- `PinDefinition`: typed execution/data port.
- `TypeRef` (`src/core/types.ts`): canonical, language-neutral pin type with Unreal-style containers (array/set/map). Graphs and node definitions only use canonical type ids.
- `LanguagePack` (`src/core/language-pack.ts`): everything the extension knows about one target language: detection markers, capabilities, type mapping, an optional in-process simulator for code nodes, a code generator and runner, and an importer that reads the language's source files for project functions. Built-in packs live in `src/core/languages/`. Debugging joins the interface in Phase 5 (see `docs/roadmap.md`).
- `GraphRuntime`: reference interpreter. It is language-neutral; code nodes run only through the graph language's pack simulator.

## File format (`.vgraph`, schema 3)

A `.vgraph` file is a `GraphDocument`, mirroring Unreal's Blueprint assets:

- `kind`: `class` (member variables, event graphs, functions, macros), `functionLibrary` (functions only, no variables) or `macroLibrary` (macros only, no variables).
- `variables`: member variables, with canonical types.
- `graphs`: each graph has an `id` unique in the file, a `kind` (`event`, `function` or `macro`), nodes, connections and comments. Function and macro graphs also have a `signature`; functions may have `localVariables`. Node ids are unique within their graph.

`schemas/graph.schema.json` is the published schema; a unit test validates the samples against it. Reroute nodes are ordinary nodes, so they need no schema support.

`importedFunctions` maps each project function a document calls (node type `fn:<language>:<path>#<name>`) to its signature when its nodes were made or last refreshed. The resolver uses it so nodes keep their pins when the code changes, until they are refreshed ([code-as-nodes.md](code-as-nodes.md)).

Nodes store unconnected input values as `pin:<pinId>` properties. Variable Get/Set nodes store their variable's id as `variable`; their pins come from that variable through the node resolver (`src/core/resolve.ts`), which every consumer uses to get a node's definition.

Migration: `parseDocument` upgrades older schemas in memory (`src/core/migrations.ts`), one version at a time (1 → 2 makes the single graph an event graph; 2 → 3 binds variable nodes to declared variables, declaring missing ones as `any`), keeping unknown fields. The file is rewritten in the new schema only when the document is next edited, so opening a file never marks it modified. Files from a newer schema are refused with a message asking for an extension update.

## Function Library model

A user-authored library node can be backed by:

- `code`: target-language source templates or generated source.
- `subgraph`: a separate visual graph used as the implementation.
- `native`: extension/runtime code.
- `function`: a function in the project's own code, read by the language pack's importer (`src/core/importing/`) and imported by generated code. The extension scans and watches the workspace for them (`src/extension/project-functions.ts`).

A production implementation should make subgraph-backed functions first-class assets, e.g. `*.vfunc`, and automatically expose their inputs/outputs as a node signature.

## Compiler pipeline

Graphs compile to source code in their target language (roadmap decision 1):

1. **Lowering** (`src/core/compiler/lower.ts`) validates a document and turns it into **Visual IR** (`src/core/compiler/ir.ts`): statements and expressions with no language in them. Problems become Compiler Results diagnostics tied to a graph and node. Exec wires become structured control flow; a node reached by several exec wires becomes a shared block instead of duplicated code; impure outputs become stored slots on the generated class; pure nodes are inlined at each use.
2. **Generation** is each language pack's `generator` (`CodeGenerator` in `src/core/language-pack.ts`). It names things legally for its language (`src/core/compiler/names.ts`), writes one class per graph with a `start()` method, and marks each node's code with a comment that doubles as the node-to-line map.
3. **Placement and running** happen in the extension host (`src/extension/compile-service.ts`, `placement.ts`, `runner.ts`): the file is written next to the graph, checked against the project's configuration, and run with the project's toolchain.

Project functions become IR imports; each generator imports them relative to the generated file (TypeScript, JavaScript) or by module name (Python), as `src/core/compiler/module-paths.ts` spells them.

`compileDocument` (`src/core/compiler/index.ts`) ties steps 1 and 2 together. Adding a language means adding a pack with a generator; the compiler, IR and runtime don't change.

## Simulate vs generated code

`GraphRuntime` (Simulate) is the reference semantics, written down in [semantics.md](semantics.md). Generated code in every language must behave the same way. The conformance suite (`test/conformance/`) runs every fixture graph in Simulate and as generated TypeScript, JavaScript and Python with the real toolchains, and requires identical output.

## Security

Executing user-authored code nodes is equivalent to executing workspace code, so the extension integrates with VS Code Workspace Trust (`capabilities.untrustedWorkspaces: "limited"`). In Restricted Mode graphs can be opened, edited and compiled, but Run and Simulate are disabled and the host refuses run requests; granting trust enables them in open editors. Compiling only writes text next to the graph, node libraries are plain data, and project functions are found by reading source text (no interpreter or compiler runs), so none of them executes anything; code runs only when a graph is run or simulated. Placement probes that execute project tooling (later phases) are gated the same way. Webview CSP and restrictive local-resource roots should remain enabled.
