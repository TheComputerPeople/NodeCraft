# Language context (Phase 10)

Phase 10 of the [roadmap](roadmap.md): the palette, and everything else the editor shows, in the context of the graph's language, the one picked in the toolbar's **Language** menu. Asked for on 2026-10-29, before generics in C++, Go, Lua and PHP. The user chose all four parts below, an audit of every node rather than a reported mismatch, the language's terms everywhere they're shown, and a phase of its own after Phase 9 was merged.

A "Built" section after each design says what each step built.

## Today

Changing the Language menu sets the document's language and redraws the palette (`setLanguage` in src/webview/compile-results.ts). The palette (`paletteEntries` in src/webview/document.ts) then offers:

- project functions the language can call (`callable`: TypeScript also calls JavaScript);
- code nodes with a snippet in the language (`implementsCode`), and macros of libraries in it;
- nodes whose features the language has (`nodeRequirements` against the pack's capabilities: no Delay without async, no Make Set without sets);
- graph types (structs, enums, classes, interfaces) of the language (`listUserTypes`).

The webview tests cover each (test/webview/editor.test.ts, capabilities.test.ts). What's missing:

1. **Nothing checks that what's offered works.** A node with a snippet for the language, and the capabilities it needs, is offered. Nothing compiles each one in each language, so a snippet that doesn't build, or gives another answer than Simulate, is found only when a graph uses it.
2. **Everything is named in Unreal's terms.** A Python graph offers "Make Array" under "Utilities / Array", and its pins are `array<int>`. A Python user thinks in lists and dicts, a C# user in `List<long>` and `Dictionary`.
3. **Nothing shows what a node becomes.** To know that Length is `len(items)` in Python and `items.size()` in C++, you compile a graph and read the code.
4. **Only universal nodes are built in.** The utility library left out regular expressions, hashing and JSON because not every language has them. Most do, though, and a Python user expects `re`.

## Part 1: audit every node in every language

**Design.**

- **One graph per language, every node in it.** A test builds, for each of the 12 languages, a class graph with every built-in node the palette would offer in that language. Each node goes in its own function graph: its data inputs are the function's parameters (its exec pins wired through), and its data outputs go to the Return node, or to Print for impure nodes. Latent nodes go in the event graph, each from its own custom event.
- **Compile.** Each language compiles its graph: a compile error on a node is a mismatch.
- **Build.** The generated file is built, or checked, with the language's toolchain:
  - `tsc --noEmit`, `node --check`;
  - `python -m py_compile` plus a run;
  - `dotnet build`, `g++ -fsyntax-only`, `cargo check`, `javac`, `go vet`;
  - `luac -p`, Godot's `--check-only`, `ruby -c`, `php -l`.

  An error is mapped to its node through the generator's `nodeLines`.
- **Run against Simulate.** Each node also runs once, with sample inputs for its pin types, in each language and in Simulate (the semantics' oracle). The outputs printed must be the same. The run leaves out nodes that read the console, touch files, or give a different value each time (random, time, UUIDs): those are only built.
- **What a mismatch becomes.** Each is either fixed (the snippet or generator), or the node is left out of that language: the language loses the snippet, or the node declares what it needs. The doc records each one found.
- **Kept.** The audit becomes a conformance test, so a new node, or a new pack through the SDK's conformance suite, gets the same check.

**Built (steps 2 to 4, in one commit).** The harness builds and runs in one go, and the findings were few, so the three steps were one.

- **The harness** (src/conformance/audit.ts, `auditPack`):
  - **Cases.** A case is each node the palette offers in the language, through the same checks (`implementsCode`, the capabilities). Nodes with wildcard pins are one case per element type (int, float, string, bool), or per key and value pair for maps. That's 344 cases in TypeScript, from 212 nodes less the structural ones (entries, returns, members, macros, events, dispatchers, tests and Object Is Valid, which takes an object), which the fixtures cover.
  - **Graph.** One class graph: each case is a custom event with its node, sample inputs from variables of concrete types (the node's `wildcards` set as the editor sets them), and a Print of each output, and a label for each of several exec outputs. Start prints a marker and calls each case in turn. Nodes that read files or give another value each time (random, time, UUIDs, Shuffle, Random Item) are built and never called.
  - **Rounds.** A compile error on a case, a build error traced through `nodeLines`, or a crash (the last marker printed) takes that case out (out of the graph, or out of the run), and the rest run again.
  - **Comparison.** When everything runs, each case's lines are compared with Simulate's. Simulate runs the graph as a TypeScript graph, and first runs each case alone: a case Simulate stops on isn't run in the language.
  - **Numbers.** They may differ in their last bits (up to 4 units in the last place), since platforms' math libraries round sines and logarithms differently. They must still be written as Simulate writes them, the shortest form that reads back.
- **Kept.**
  - test/conformance/audit.test.ts runs it in all 12 languages (each built and run once; C++ takes the longest, about 10 s). It checks there are no findings and that more than 300 cases ran.
  - Its self-check gives Python a wrong String Reverse and expects that finding, and no other.
  - The SDK exports `auditPack`, and `blueprint-conformance <pack> --audit` runs it for any pack.
- **What it found** (the first full run, 2026-10-29), and the fixes:
  - **Maps printed with integer keys sorted, in Simulate, TypeScript and JavaScript.** Print wrote a map through a plain object, which lists integer-like keys first and in ascending order. The semantics say insertion order, which the other ten languages kept: Pick and Make Map From Arrays with int keys printed differently. Simulate's `formatValue` and the generated TypeScript/JavaScript print helper now write maps themselves, in order.
  - **Lua: big graphs didn't load.** Each code node's snippet is a module-level local function, and Lua allows 200 locals in a chunk. A graph using about 200 kinds of code node failed with "too many local variables". Past 150 helpers and imports, the helpers are fields of one local table (`vg_helpers`); smaller graphs are generated as before.
  - **Ruby: sets of booleans crashed** Set To Array and Print, which sorted them with Ruby's `sort` (`false` and `true` don't compare). A runtime `Vg.sorted` sorts them as Sort already did, false first.
  - **Last-bit differences** in Sin and Tan (C++, Rust, C#, GDScript, Ruby, PHP, Python) and Acos (Go): expected, see Numbers above.
- **Limits.**
  - Simulate runs TypeScript's and JavaScript's own snippets (the `javascript` key), so in those two languages the audit checks the generator, not the snippet. The snippets themselves are checked by the fixtures' expected outputs.
  - Sample inputs are typical ones. Edge cases (empty arrays, out-of-range indexes, errors) stay with the fixtures, since a crash in one case stops the program.

## Part 2: the language's terms

**Design.**

- **Terms in the pack.** A language pack may declare `terms`: its words for the containers and the four basic types, each as a title and a lowercase noun.

  | Language | array | set | map | string | int | float | bool |
  |---|---|---|---|---|---|---|---|
  | TypeScript, JavaScript | Array | Set | Map | string | integer | number | boolean |
  | Python | List | Set | Dict | str | int | float | bool |
  | C# | List | HashSet | Dictionary | string | int | double | bool |
  | C++ | Vector | Set | Map | std::string | long long | double | bool |
  | Rust | Vec | Set | Map | String | i64 | f64 | bool |
  | Java | List | Set | Map | String | long | double | boolean |
  | Go | Slice | Set | Map | string | int | float64 | bool |
  | Lua | List | Set | Table | string | integer | number | boolean |
  | GDScript | Array | Set | Dictionary | String | int | float | bool |
  | Ruby | Array | Set | Hash | String | Integer | Float | Boolean |
  | PHP | List | Set | Map | string | int | float | bool |

  (As built: the basic types are each generator's own, and the container names follow the types generated code uses, such as Rust's `vgraph::Map` and PHP's `VgList`.)

  These are the words, not the generated types. Each pack's generator already knows its types. Where it differs, the table follows what the generator emits (a C++ `std::vector`, a Go slice).
- **Type names.** A pin's type is shown in the language's own text, from the generator: Python `list[int]`, C# `List<long>`, Rust `Vec<i64>`, TypeScript `number[]`. Each generator gains `typeText(type)`, built from what it uses for declarations. Pins, tooltips, Details, My Blueprint and the type picker show it; the picker's entries are the language's words (List, Dict).
- **Node names.** Names and categories that name a type are templates in one table in core (src/core/terms.ts): `core:array.make` is "Make {Array}" under "Utilities / {Array}", and String To Int is "{String} To {Int}". Without terms, the templates give today's names. "Set Variable" and "Map Range" aren't in the table: there, Set and Map are verbs.
- **Everywhere shown.** The palette, the Add Node menu, node titles on the canvas, pin tooltips, the type picker, Details and My Blueprint all use the terms. A Python graph shows a "Make List" node with a `list[int]` output.
- **Search finds both.** A node's search text includes its Unreal name, so "make array" still finds Make List.
- **Saved graphs don't change.** Node types, pin ids and type ids are the same; only what's drawn follows the language. Changing the Language menu redraws the canvas in the new terms.

**Built (steps 5 and 6, in one commit).** The terms are data the webview applies itself, so the core and the editor were one change.

- **Terms** (src/core/terms.ts):
  - `LanguageTerms`: the container names, and a `TypeSpelling` with each basic type and templates for containers (`list[{T}]`, `dict[{K}, {V}]`, `{T} | None`). Java also boxes element types (`ArrayList<Long>`).
  - Each built-in pack declares `terms` (`LANGUAGE_TERMS`); a pack without them, such as a declarative one, keeps Unreal's.
  - `typeText(type, spelling)` writes a type. Without a spelling it gives exactly what `formatType` gives, which the tests check for every kind of type.
- **Node names.**
  - `localizeDefinition` puts a built-in node in the terms: names from `NAME_TEMPLATES` (Make {Array}, Set {Array} Elem, Make {Map} From {Array}s and eight more), and categories whose part is Array, Set or Map.
  - The Unreal name joins the node's keywords, so search finds both. Only `core:` nodes change: project functions and node libraries keep the names their authors gave.
  - Only container words change. Scalar words in names stay Unreal's ("Random Float in Range", not "Random F64 in Range"), and pins show the language's scalar types.
- **The editor.**
  - The webview keeps the definitions as the host sent them (`sourceDefinitions`), and `applyTerms` puts them in the graph language's terms. It runs when the definitions, the document's language, or the languages change. Since the palette, the Add Node menu, node titles and Details all read the definitions, they follow it.
  - Pin tooltips, Details, My Blueprint and the type picker write types through `shownType`. The type picker lists the language's basic types (Python's int, float, str, bool) and its container names (Single, List, Set, Dict).
  - The host sends each language's `terms` with its capabilities (`LanguageOption.terms`).
- **Tests.**
  - Unit (test/unit/terms.test.ts): Unreal's terms change nothing. Every template gives a node's own name. Each language's spelling, and its basic types match its generator's `mapType` (TypeScript's and JavaScript's int is "integer", so the picker tells it from float). Verbs aren't containers.
  - Browser (test/webview/language-context.test.ts): switching a graph from TypeScript to Python changes the palette (Make List, Make Dict From Lists, Utilities / List), a node's title, a pin's tooltip (`list[int]`), My Blueprint and the type picker. A search for "make array" finds Make List. The saved graph changes only its language, and switching back restores Unreal's names.

## Part 3: code preview

**Design.**

- **Where.** The palette and the Add Node menu show the highlighted entry's code in the graph's language, in a small pane below the list (the palette) or beside it (the menu). Hovering or moving the selection with the arrow keys changes it.
- **How.** The webview asks the host (`previewNode`, with the node type, preset properties and language). The host compiles the same one-node function graph as the audit, with pins named after the node's own, and returns the node's lines (through `nodeLines`). So Length shows `len(array)` in Python and `array.size()` in C++. Answers are cached for each type and language, and cleared when definitions change.
- **When it can't.** Project functions show their call. A node the language can't compile isn't offered at all (Part 1). A language without a generator (a declarative pack still loading) shows nothing.

**Built (step 7).**

- **Core** (src/core/preview.ts, `previewNode`):
  - **A code node** shows its snippet for the language: the first of the generator's `snippetLanguages` it has, or the pack's own `snippets`. `${pin}` placeholders read as the pin's name, as in the generated helper. Snippets become helper functions, so the call alone would say nothing; the snippet is what the node does: `return len(target)`.
  - **Any other node** is compiled. An impure node goes in a custom event whose inputs are the node's own, and its outputs are left unwired. A pure one goes in a function that returns its outputs, since it's written where it's used.
  - **Extraction.** The node's lines are its node line onward, while indented at least as deep, dedented: `if condition:` / `pass`, or Delay's latent block.
  - **Context.** It's compiled alone first, then in a copy of the open document when the entry refers to it (a variable's Get and Set, Call Event, members): Set Score is `Score = score;` in C#. Project functions compile with the host's registry, so they show their call: `return damage(strength)`.
  - Wildcard pins are shown as ints, and a map's values as strings.
- **The editor** (src/webview/preview.ts): hovering or focusing a palette entry, or hovering an Add Node menu entry, shows its code in a pane below the list ("In Python"). The webview sends `previewNode` with the document (its copy may be newer than the file), after 120 ms. The host answers `nodePreview`. Answers are kept for each entry and language until the definitions or the document change.
- **Without code.** Sequence and End write no code of their own, so their pane says "No Python preview". Every other node the palette offers has a preview in every language, which the unit test checks for all 12.
- **Tests.** Unit (test/unit/preview.test.ts): snippets, generated lines in several languages, document entries, a project function, the extraction. Browser (test/webview/language-context.test.ts): the palette's pane and the menu's, a request only once per entry and language, "No … preview", and another language asking again.

## Part 4: language-only nodes

**Design.** Nodes only some languages have, from their standard libraries, under a category named for the language (the Python palette's "Python" category). They're code nodes with snippets only for those languages, so the palette's existing filter offers them only there. They're built in and documented as language-specific.

| Nodes | Languages (the standard library used) | Not in |
|---|---|---|
| **Regex:** Matches, Replace, Find All (array of string), Split | TypeScript, JavaScript (RegExp), Python (`re`), C# (`Regex`), C++ (`<regex>`), Java (`java.util.regex`), Go (`regexp`), GDScript (`RegEx`), Ruby (`Regexp`), PHP (`preg_*`) | Rust, which has no regex in std; Lua |
| **Lua patterns:** Match, Replace (`gsub`), Find All (`gmatch`) | Lua | the rest |
| **Hash:** MD5, SHA-1, SHA-256 of a string, as hex | Python (`hashlib`), C# (`System.Security.Cryptography`), Java (`MessageDigest`), Go (`crypto/*`), GDScript (`HashingContext`), Ruby (`Digest`), PHP (`hash`), TypeScript and JavaScript under Node (`node:crypto`) | C++, Rust and Lua, which have no hashing in std |
| **JSON:** To JSON (any value) | TypeScript, JavaScript, Python (`json`), C# (`System.Text.Json`), Go (`encoding/json`), GDScript (`JSON`), Ruby (`json`), PHP (`json_encode`) | C++, Rust, Java and Lua, which have no JSON in std |

- **Each pattern dialect is the language's own.** The node's description says so, as the code preview shows, and the Unreal-named universal nodes stay as they are.
- **Parsing JSON** stays out: its value has no pin type, the reason the utility library left JSON out.
- **Tests.** The audit (Part 1) covers them: each runs in its languages, with outputs checked against an expected value instead of Simulate's.

## Exit check

- The audit passes: every node the palette offers in each of the 12 languages compiles, builds and, where it can run, prints what Simulate prints.
- A webview test changes the Language menu from TypeScript to Python on a graph with a Make Array node and an `array<int>` variable. The palette, the node's title, its pin tooltip and the variable show List terms, and the saved graph is unchanged.
- The palette's preview shows each language's code for Length.
- The Python palette offers the Regex, Hash and JSON nodes, and the Rust palette offers none of them.

## Steps

One commit each; large steps may take several.

1. This design, and the roadmap.
2. The audit: the one-node graphs, compiling and building in every language, mapped to nodes; the mismatches recorded.
3. Fixing what the audit finds by compiling and building.
4. The audit's runs against Simulate, and fixing what they find. (Steps 2 to 4 were one commit.)
5. Terms: `terms` in packs, `typeText` in generators, the name templates (src/core/terms.ts), the 12 languages' terms.
6. Terms in the webview: palette, Add Node menu, node titles, pins, the type picker, Details, My Blueprint; search by both names. (Steps 5 and 6 were one commit.)
7. Code preview: `previewNode`, the palette's pane and the menu's.
8. Language-only nodes: Regex and Lua patterns.
9. Language-only nodes: Hash and JSON.
10. The exit check, docs, the parity checklist and status.
