# Execution semantics

How a graph behaves when it runs. Simulate (the reference interpreter in `src/core/runtime.ts`) and every language pack's generated code must follow these rules; the conformance suite (`test/conformance/`) checks that they produce the same output. Where Unreal Blueprints define a behavior, these rules follow it unless noted.

## Events and entry points

- **Start** nodes in event graphs are the entry points. Running a class runs every Start node: graphs in document order, then Start nodes in node order within each graph.
- In generated code, all Start nodes together become one `start()` method on the generated class (named per language convention).
- All event graphs share the class's member variables.
- Function and macro graphs only run when called. Calling them arrives with Phase 4.

## Execution flow

- Execution follows exec wires. A node runs **every time** execution reaches it, as in Unreal.
- An exec output wired to several inputs runs them one after another, in the order the connections appear in the file. (Unreal allows one wire per exec output; see the parity checklist in the roadmap.)
- **Sequence** runs `Then 0`, `Then 1` and `Then 2` in order; each finishes completely before the next starts.
- **Branch** follows `True` or `False` depending on its condition. The condition counts as false when it is `false`, `0`, `NaN`, an empty string or null; anything else counts as true.
- **Cycles in exec wires are errors.** The compiler rejects them. Simulate stops with an error when execution re-enters a node that is still running. Loops arrive as dedicated loop nodes in Phase 4.

## Data flow

- **Pure nodes** (no exec pins, for example Get Variable) are evaluated whenever an executing node needs one of their outputs, every time. Their results are never cached. A cycle of data wires between pure nodes is an error.
- **Impure nodes** (with exec pins) compute their outputs when they run. Their outputs keep the latest value until the node runs again. Before a node has run, its outputs hold their type's default value.
- An **unconnected input** uses the value stored on the node in the graph (`pin:<id>` in the node's properties), else the pin definition's default, else the type's default.

## Values

- Type defaults: `bool` is false; `int` and `float` are 0; `string` is empty; containers are empty; `any`, objects and other types are null.
- Numbers are double precision. `int` and `float` currently share that representation; integer-specific behavior arrives with Unreal-style conversion nodes in Phase 2.
- **Converting a value to text** (Print, and any later string conversion):
  - null prints as an empty string;
  - booleans print as `true` and `false`;
  - numbers print in their shortest exact form, using JavaScript's rules: `30`, `0.1`, `1e-7`, `1e+21`, `NaN`, `Infinity`. Integral values have no decimal point. (Unreal prints `30.0` for floats; matching that needs type information that `any` pins don't carry, so it is deferred.)
  - strings print unchanged; anything else prints as compact JSON.
- **Add** converts its inputs to numbers (a missing value counts as 0) and adds them.

## Variables

- Member variables start at their declared default, else their type's default.
- Set Variable and Get Variable name the variable with their `Name` input. For code generation the name must be typed on the node, not wired, because generated code reads and writes a fixed member. (Unreal binds variable nodes to a variable in the editor; dedicated variable nodes arrive with the My Blueprint panel in Phase 2.)
- Using a variable that isn't declared creates it with type `any` and a null starting value. The compiler warns when this happens.

## Code nodes

- A code node runs the snippet for the graph's language. Its data inputs are the snippet's parameters, and the snippet's return value becomes the node's first data output. Additional data outputs aren't supported yet.
- In a snippet, `${pinId}` refers to an input. Inputs whose ids are valid identifiers in the target language can also be used by name.

## Errors

- An error raised while a node runs (for example, a code node that throws) **stops the whole run** and is reported. Nodes after it don't run.
- Problems the compiler can detect, such as unknown node types, cycles or missing code snippets, are compile errors. Simulate reports them as errors when it reaches them and stops.
