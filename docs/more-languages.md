# More languages (Phase 8 design)

Phase 8 of the [roadmap](roadmap.md): Lua, GDScript, Ruby and PHP as Tier 1 packs, in that order. Each is built like Java and Go in Phase 6 ([language-breadth.md](language-breadth.md)): a generator that passes the conformance suite, then placement, symbol import and debugging, each tested against its real toolchain.

Decided (2026-10-28): the user asked for these four, Lua and GDScript first. Lua is the most used embedded scripting language in games, and GDScript is Godot's, so both are close to Blueprint's audience; Ruby and PHP cover web back ends. All four are Tier 1 rather than declarative: the declarative format can't express objects, inheritance, dispatchers or Delay, and each of these languages can.

## Shared decisions

- **Numbers.** Graphs follow [semantics.md](semantics.md): numbers print in their shortest exact form, by JavaScript's rules (`30`, `0.1`, `1e+21`). None of the four prints that way natively (Lua prints `1.0`, Ruby `1.0e+20`), so each pack's support code formats numbers, as Go's runtime does.
- **Integers** are 64-bit in Lua 5.4, GDScript and PHP. Ruby's grow without bound; the pack keeps Ruby's `Integer` and relies on the semantics' safe-integer range, as Python does.
- **Text** is counted in code points. Ruby and GDScript strings already are. Lua's are bytes, so the pack uses Lua 5.4's `utf8` library. PHP's are bytes too, so the pack uses `mbstring`, which the PHP installation must enable.
- **Maps and sets** keep insertion order, as the semantics require. Ruby's `Hash`, PHP's arrays and GDScript's `Dictionary` already do. Lua's tables don't, so its runtime has ordered set and map types, as Go's does.
- **Delay** uses the latent queue the other packs use, run after Start and Main, rather than each language's own timers.
- **The utility nodes and the standard library** get snippets in each language, and the [utility library](../THIRD_PARTY_NOTICES.md)'s PHP and Ruby versions are the starting point for those two.

## Lua (Tier 1)

- **Toolchain:** Lua 5.4 (`lua` on the PATH). LuaJIT and Lua 5.1 lack integers and the `utf8` library.
- **Files:** `name_vgraph.lua` next to the graph. A module name with a dot means a folder in `require`, so the name avoids one, as Python's does. Generated code `require`s other graphs and project modules by their path from the workspace folder, and Run sets `package.path` to it. A support module, `vgraph_runtime.lua`, is extension-owned (formatting, ordered containers, the latent queue, dispatchers), as Go's runtime file is.
- **Representation:** `int` and `float` are Lua's integer and float subtypes; `bool`, `string` and `nil` for nothing. Arrays are the runtime's arrays (a table with its length, 0-based through the runtime's functions, since Lua's own are 1-based and stop at a `nil`). A class is a table with a metatable; inheritance chains `__index`, so functions are virtual, as in Unreal. Interfaces are recorded on the class, and Cast To checks the chain. Errors are `error()`, caught with `pcall` by Run and the tests.
- **Run:** `lua` runs a launcher that `require`s the generated module and calls Start, Main and the latent actions (or the tests).
- **Symbol import:** functions marked `---@blueprint` in LuaLS-style annotations (`---@param x number`), read by a scanner. Module functions (`function M.name(...)`) become nodes.
- **Debugging:** the Lua Debug extension (`actboy168.lua-debug`), which runs Lua 5.4 under the debugger.
- **Risks to settle first:** whether Lua Debug's breakpoints bind in generated files run through the launcher, and how the runtime's 0-based arrays show in the debugger's variables.

- **As built** (`src/core/languages/lua.ts`, `lua-runtime.ts`), step 2:
  - **Generator:** adapted from Python's. A module records its table in `package.loaded` before it `require`s anything, so two classes that use each other both load; a subclass sets its parent as its metatable's `__index` after the `require`s. Lua's `return` must end a block, so a Return Node with statements after it becomes `do return ... end`.
  - **Several outputs** are Lua's multiple return values; a pure call reading one output takes it with `select`.
  - **Values:** literals keep their kind (`5` is an integer, `2.5` a float), and Lua 5.4 keeps the two apart, so `math.floor` and the integer pins give integers as Unreal does. Enum values are their names, as strings.
  - **The support module** (`vgraph_runtime.lua`): arrays (`vg.array`, items at 1..n with `n` kept, indexed from 0 by the nodes), insertion-ordered sets and maps, JSON and number formatting, `to_number` and `to_boolean`, classes and interfaces (`vg.class`, `vg.is_a`), dispatchers and the latent queue. A test checks the number formatting against JavaScript's on hard cases (exponent boundaries, subnormals, the largest double).
  - **Snippets:** the `LUA` tables in `stdlib.ts`, `containers.ts` and `utilities.ts`. Lua's patterns are ASCII, so To Upper, To Lower, Trim and the utilities' whitespace work on ASCII, as in C++.
  - **Run:** a launcher in the scaffold folder sets `package.path` to the scaffold (where the support module is written) and the workspace folder, `require`s the generated module, and runs Start, Main and the latent actions; with `--test`, each test on a new object. Errors print as `Error: <message>` and exit with 1.
  - **Conformance:** all 25 fixtures pass, both object programs included.
- **As built**, step 3:
  - **Placement:** `luaPlacement` keeps one `vgraph_runtime.lua` at the workspace folder while it has Lua graphs, since generated modules `require` the support module and each other by their path from there; it removes the file when the last Lua graph goes, if the file is the extension's. A test runs a generated module with a plain `lua` from the folder, without the extension.
  - **Symbol import:** `src/core/importing/lua-scanner.ts` reads the functions of the table a module returns (`function M.name(...)` and `M.name = function(...)`) marked `---@blueprint`, with their types from `---@param` and `---@return` (`integer`, `number`, `string`, `boolean`, `T[]`, `table<K, V>`; other names are native). Methods (`M:name`), varargs, several `@return`s and functions of other tables are reported with the reason. A function without `@return` returns nothing. Generated code `require`s the module by its path (`lib.scores`).
  - **Debugging:** Lua Debug's `lua` launch configuration runs Run's launcher under its own Lua 5.4 (`luaVersion: "lua54"`), or the `runCommands` setting's executable. The Debug test and the Phase 5 exit check pass.

## GDScript (Tier 1)

- **Toolchain:** Godot 4 (4.3 or later), its console executable on the PATH as `godot` (`Godot_v4.x_stable_win64_console.exe` on Windows, renamed or aliased), or set in `blueprintVisualScripting.runCommands`.
- **Files:** `name_vgraph.gd` next to the graph, inside a Godot project (the nearest `project.godot`). Other scripts are loaded with `preload("res://…")`, so paths are relative to the project folder; a graph outside a Godot project gets a warning and Run uses a scratch project. Generated classes don't declare a global `class_name`, because Godot requires those to be unique across the project, and graph names needn't be.
- **Representation:** `int` (64-bit), `float`, `bool`, `String` (code points) and `Variant`; `Array`, `Dictionary` (insertion-ordered) for maps, and a `Dictionary` of keys for sets. Graph classes extend `RefCounted`, so objects are freed when unused. Inheritance is `extends` with virtual functions. GDScript has no interfaces, so they are recorded on the class and Cast To checks them, as in Lua. Dispatchers are lists of `Callable`s, and GDScript's signals are left for a Godot framework pack.
- **Errors:** GDScript has no exceptions. This is the main risk. A runtime error has to stop the run with its message and a failing exit code, and a Test Case has to catch an assert. The pack's errors print the message, record it, and make every following statement in the run do nothing. Two other designs are possible: return codes threaded through the generated code, as Rust's errors are, or one Godot process per test. The first step settles which works.
- **Run:** `godot --headless --path <project> --script <launcher>.gd`, where the launcher extends `SceneTree`, calls Start, Main and the latent actions, then quits with the exit code.
- **Symbol import:** `func`s marked `## @blueprint` (Godot 4's doc comments), with typed parameters (`func score(points: int) -> float`), read by a scanner. Godot's language server only runs inside an open Godot editor, so a scanner is more dependable.
- **Debugging:** godot-tools (`geequlim.godot-tools`), which launches Godot under its debugger with breakpoints in `.gd` files.
- **Risks to settle first:** errors (above), and whether godot-tools can launch a headless script rather than the project's main scene.

## Ruby (Tier 1)

- **Toolchain:** Ruby 3.3 or later (RubyInstaller with the DevKit on Windows), with the `debug` gem that ships with it.
- **Files:** `name_vgraph.rb` next to the graph. Generated code loads other graphs and project files with `require_relative`.
- **Representation:** `Integer`, `Float`, `true`/`false`, `String` (UTF-8, counted in characters) and `nil`. `Array`, `Hash` (insertion-ordered) and `Set`. Classes, inheritance and exceptions map directly; interfaces are modules the class includes, and Cast To is `is_a?`. Dispatchers are lists of lambdas.
- **Run:** `ruby` runs a launcher that calls Start, Main and the latent actions (or the tests).
- **Symbol import:** module functions and class methods marked `@blueprint` in YARD comments, with types from `@param [Integer] points` and `@return [Float]`, read by a scanner.
- **Debugging:** rdbg (the `debug` gem) through the VSCode rdbg Ruby Debugger extension (`KoichiSasada.vscode-rdbg`).

## PHP (Tier 1)

- **Toolchain:** PHP 8.3 or later (`php` on the PATH), with the `mbstring` extension enabled, and Xdebug 3 for debugging.
- **Files:** `Name.vgraph.php` next to the graph, with a namespace from `composer.json`'s PSR-4 roots when the graph is under one (as C# takes its namespace from the project). Generated code loads other graphs and project files with `require_once`, so it doesn't depend on Composer's autoloader.
- **Representation:** `int`, `float`, `bool`, `string` and `null`. Arrays are PHP arrays, wrapped where a graph needs a reference (an array a node changes must change for its caller too, and PHP arrays are copied on assignment). Maps are arrays, insertion-ordered; sets are arrays of keys. Classes, inheritance, interfaces and exceptions map directly; Cast To is `instanceof`. Dispatchers are lists of `Closure`s.
- **Run:** `php` runs a launcher that calls Start, Main and the latent actions (or the tests).
- **Symbol import:** functions and `public static` methods marked `@blueprint` in docblocks, with their parameter types, read by a scanner like Java's.
- **Debugging:** Xdebug through the PHP Debug extension (`xdebug.php-debug`).
- **Risk to settle first:** arrays. Graphs share containers by reference everywhere, and PHP copies arrays on assignment, so arrays (and maps, which are the same type) need a small wrapper class in the generated code.

## Steps

One commit each (large steps may take several):

1. Design and plan (this document).
2. Lua: the runtime and the generator, passing the conformance suite.
3. Lua: placement, symbol import, debugging and tests.
4. GDScript: the error design, the generator and the runner, passing the conformance suite.
5. GDScript: Godot project placement, symbol import, debugging and tests.
6. Ruby: the generator and runner, passing the conformance suite.
7. Ruby: placement, symbol import, debugging and tests.
8. PHP: the generator and runner, passing the conformance suite.
9. PHP: Composer placement, symbol import, debugging and tests.
10. Documentation, the parity checklist and status.

Each language's toolchain must be installed before its steps: a pack isn't finished until its conformance and debugging tests run.
