# Architecture Notes

## Design rule

The graph is the source of truth. It is not a JavaScript AST and it is not a C++ AST. Nodes expose typed pins and semantics; language adapters decide how those semantics execute or become source code.

## Core contracts

- `GraphDefinition`: serializable graph asset.
- `NodeDefinition`: reusable node signature and implementation metadata.
- `PinDefinition`: typed execution/data port.
- `GraphRuntime`: reference interpreter for the MVP.
- Future `LanguageAdapter`: maps the language-neutral graph/IR to a target language.

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
