# Calling another language from a graph

A small project with two languages: a Python pricing service in `api/` and a TypeScript checkout in `web/`. The checkout is a graph, `web/Checkout.vgraph`, that prices an apple and a coffee with the Python service and prints the total, `4.5`.

A graph calls code in its own language only. To reach another language, write a function in the graph's language that crosses the boundary, and mark it `@blueprint`. It then appears as a node, and the graph calls it like any other project function:

- `api/pricing.py` is the Python side, an ordinary program: given an item, it prints the item's price as JSON.
- `web/pricing.ts` is the TypeScript side. Its `priceOf` function runs `pricing.py` and reads the answer. Because it's marked `@blueprint`, it is the **Price Of** node, under **Pricing**.
- `web/Checkout.vgraph` calls **Price Of** twice and prints the sum. `web/Checkout.vgraph.ts` is its generated code.

Here the boundary is a subprocess. An HTTP request, a message queue or a native binding works the same way: whatever the function does, the graph sees a node with typed pins. Generated bindings between languages may come later; see [docs/multi-language.md](../../docs/multi-language.md), gap 4.

## Try it

1. Open this folder (`examples/multi-language`) in VS Code with the extension. The project function's node is named after its path from the workspace folder, so the graph finds it only when this folder is the workspace.
2. Open `web/Checkout.vgraph` and click **▶ Run**. It needs Node.js 22.18 or later and Python 3 (`py -3` on Windows, `python3` elsewhere).

New graphs follow the folder they're saved in: **New Graph** in `api/` starts a Python graph (`pyproject.toml`), and in `web/` a TypeScript one (`tsconfig.json`).
