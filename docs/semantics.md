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
- **Cycles in exec wires are errors.** The compiler rejects them. Simulate stops with an error when execution re-enters a node that is still running. Repeating is done with loop nodes, as in Unreal.
- Some exec inputs only change a node's state and don't continue: a loop's **Break**, **Reset** (Do Once, Do N, MultiGate) and Gate's **Open**, **Close** and **Toggle**. Wires into them may come from downstream of the same node; that is not a cycle.

## Flow control

- **For Loop** runs Loop Body once for each Index from First Index to Last Index, both included, then Completed. First Index is read once; Last Index is read before each pass, as in Unreal's macro. **For Loop with Break** also stops when Break has run: the current pass finishes first. After the loop, Index holds the value after the last pass.
- **While Loop** reads Condition before each pass and runs Loop Body while it is true, then Completed.
- Simulate stops a loop after 1,000,000 passes with an error, as Unreal's editor does; generated code has no limit.
- **Do Once** runs Completed the first time it runs, and again only after Reset. **Do N** runs Exit the first N times (Counter counts them) until Reset. **Gate** runs Exit only while open; **Flip Flop** alternates A and B, starting with A (Is A tells which ran). **MultiGate** runs its outputs in turn, starting at Start Index (when it is 0 or more); with Loop it starts over after the last output, otherwise it stops. Start Closed and Start Index are read the first time any of the node's inputs runs. (MultiGate's Is Random arrives later.)
- What these nodes remember belongs to the object, so it lasts across events.
- **Switch on Int** and **Switch on String** run the output whose case equals Selection (Selection is read once), else Default. String cases compare exactly (case-sensitive).

## Data flow

- **Pure nodes** (no exec pins, for example Get Variable) are evaluated whenever an executing node needs one of their outputs, every time. Their results are never cached. A cycle of data wires between pure nodes is an error.
- **Impure nodes** (with exec pins) compute their outputs when they run. Their outputs keep the latest value until the node runs again. Before a node has run, its outputs hold their type's default value.
- An **unconnected input** uses the value stored on the node in the graph (`pin:<id>` in the node's properties), else the pin definition's default, else the type's default.

## Values

- Type defaults: `bool` is false; `int` and `float` are 0; `string` is empty; containers are empty; `any`, objects and other types are null.
- Numbers are double precision. In TypeScript, JavaScript and Python `int` and `float` share that representation. In C#, as in Unreal, `int` is a 32-bit integer and `float` a double; a `float` wired into an `int` pin is truncated toward zero, and integers beyond 32 bits don't fit.
- **Converting a value to text** (Print, and any later string conversion):
  - null prints as an empty string;
  - booleans print as `true` and `false`;
  - numbers print in their shortest exact form, using JavaScript's rules: `30`, `0.1`, `1e-7`, `1e+21`, `NaN`, `Infinity`. Integral values have no decimal point. (Unreal prints `30.0` for floats; matching that needs type information that `any` pins don't carry, so it is deferred.)
  - strings print unchanged; anything else prints as compact JSON.
- **Add** converts its inputs to numbers (a missing value counts as 0) and adds them.

## Variables

- Member variables start at their declared default, else their type's default.
- Get and Set nodes are bound to one declared variable, as in Unreal, and take its name and type. Get is pure: it reads the variable wherever its value is used. Set assigns its input and outputs the variable's new value.
- Nodes refer to the variable by id, so renaming a variable keeps its nodes bound. A node whose variable is missing (deleted, or never bound) is a compile error, and Simulate stops with an error when it reaches one.

## Code nodes

- A code node runs the snippet for the graph's language. Its data inputs are the snippet's parameters, and the snippet's return value becomes the node's first data output. Additional data outputs aren't supported yet.
- In a snippet, `${pinId}` refers to an input. Inputs whose ids are valid identifiers in the target language can also be used by name.
- A code node without exec pins is pure: it runs each time one of its outputs is read, like any pure node.

## Project functions

- A node for a function in the project's own code ([code-as-nodes.md](code-as-nodes.md)) calls that function with its data inputs, in pin order. The return value becomes the "Return Value" output.
- A function marked `@blueprint pure` is a pure node, so it is called each time its value is read. Mark a function pure only if calling it more often, or less often, changes nothing.
- Simulate can't run project code: reaching a project function is an error that stops the run. Run executes the generated code, which imports the function.

## Errors

- An error raised while a node runs (for example, a code node that throws) **stops the whole run** and is reported. Nodes after it don't run.
- Problems the compiler can detect, such as unknown node types, cycles or missing code snippets, are compile errors. Simulate reports them as errors when it reaches them and stops.
