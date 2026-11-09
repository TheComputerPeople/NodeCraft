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
- **Files:** `name_vgraph.lua` next to the graph. A module name with a dot means a folder in `require`, so the name avoids one, as Python's does. Generated code `require`s other graphs and project modules by their path from the require root, and Run sets `package.path` to it. The root (since Phase 11, `luaRequireRoot`) is the nearest `.luarc.json`'s `runtime.path` (`"src/?.lua"` makes it `src/`, as in a rock), else that file's folder, else the workspace folder; the support module goes at each root that has Lua graphs. A support module, `vgraph_runtime.lua`, is extension-owned (formatting, ordered containers, the latent queue, dispatchers), as Go's runtime file is.
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

- **As built** (`src/core/languages/gdscript.ts`, `gdscript-runtime.ts`), step 4:
  - **Errors:** settled by probing Godot 4.7. A GDScript runtime error ends only the current function (its caller goes on), `assert` waits for a debugger, `OS.crash` hangs in the crash handler, `OS.kill` exits with code 0, and `quit(1)` lets the function run on. So a failure is recorded: `vg.fail(message)` sets it and returns null for a snippet to return, and generated code returns after every statement that may fail (`if vg.failed(): return`). Printing and Delay do nothing once a run has failed, so nothing more is seen; loops stop too. A Test Case reads the recorded failure, so the tests run in one Godot process, each on a fresh run.
  - **Files:** scripts `preload` each other by relative path, so no `res://` path is involved, and a graph needn't be in a Godot project. The support script is a companion file: a copy goes next to every generated file. The run's state (the failure, the latent queue) lives on `Engine`'s metadata, so copies in different folders share it, and values are recognized by their methods (`vg_kind`, `vg_fields`, `vg_interfaces`) rather than by the copy that made them.
  - **Representation:** parameters are typed, so an int given for a float input becomes a float (Divide divides as floats, as in Unreal); members, slots and results are Variants, since a failed snippet returns null. Arrays and maps are Godot's `Array` and `Dictionary`; sets are the support script's `VgSet`. Structs are scripts with their fields and a `vg_fields()` for printing; enum values are their names. Classes extend `RefCounted`, or their parent's script by path, and call it with `super`; Cast To is `is_instance_of`, or `vg.implements` for an interface. Several outputs come back as an `Array`. Delay's action is a lambda.
  - **Names:** members are snake_case, since a member can't take a Godot class's name (`Label`) and those are PascalCase. Preloaded scripts are constants with a leading underscore, a subclass's also with its own name, because a subclass can't declare its parent's constants again (it inherits `vg`). Methods can't take the name of a built-in function (`log`), which would be called instead.
  - **Snippets:** the `GDSCRIPT` tables in `stdlib.ts`, `containers.ts` and `utilities.ts`. A pin whose id is a method's name (`start`) is named through `${start}`. Godot's default settings make inferring a type from a Variant (`:=`) an error, so snippets use `=` there.
  - **Run:** a scratch Godot project in the scaffold folder holds the launcher (`run.gd`, a `SceneTree` script), which loads the generated script by its path; Godot runs it with `--headless --no-header`. Godot's downloads are named by version, so Run looks for `godot` and `godot4` on the PATH, then the `GODOT` environment variable, or the `runCommands` setting.
  - **Conformance:** all 25 fixtures pass, both object programs included.
- **As built**, step 5:
  - **Projects:** Run uses the graph's Godot project (the nearest `project.godot` up to the workspace folder, `RunContext.projectDir`) with the launcher still in the scaffold folder, so the project's `res://` paths and autoloads work; a graph outside a project runs in the scaffold's scratch one. Placement adds nothing (the support script is a companion file), but warns about a graph outside a Godot project (`godot-outside-project`), since debugging needs one.
  - **Symbol import:** `src/core/importing/gdscript-scanner.ts` reads top-level `static func`s marked `## @blueprint`, typed by their annotations (`int`, `float`, `bool`, `String`, `Array[T]`, `Dictionary[K, V]`; untyped `Array` and `Dictionary` hold any value; other classes are native), with literal defaults. Instance functions and names starting with `_` are reported with the reason. Generated code preloads the script by relative path and calls the function on it. A test runs a graph calling one whose script preloads another by `res://` path.
  - **Debugging:** godot-tools' `godot` launch configuration runs Godot with `--remote-debug` in the graph's project, with Run's launcher in `additional_options`; its executable is the `runCommands` setting's, else the `GODOT` environment variable's, else `godot`. The Debug test and the Phase 5 exit check pass, in a Godot project folder of the test workspace.

## Ruby (Tier 1)

- **Toolchain:** Ruby 3.3 or later (RubyInstaller with the DevKit on Windows), with the `debug` gem that ships with it.
- **Files:** `name_vgraph.rb` next to the graph. Generated code loads other graphs and project files with `require_relative`.
- **Representation:** `Integer`, `Float`, `true`/`false`, `String` (UTF-8, counted in characters) and `nil`. `Array`, `Hash` (insertion-ordered) and `Set`. Classes, inheritance and exceptions map directly; interfaces are modules the class includes, and Cast To is `is_a?`. Dispatchers are lists of lambdas.
- **Run:** `ruby` runs a launcher that calls Start, Main and the latent actions (or the tests).
- **Symbol import:** module functions and class methods marked `@blueprint` in YARD comments, with types from `@param [Integer] points` and `@return [Float]`, read by a scanner.
- **Debugging:** rdbg (the `debug` gem) through the VSCode rdbg Ruby Debugger extension (`KoichiSasada.vscode-rdbg`).

- **As built** (`src/core/languages/ruby.ts`, `ruby-runtime.ts`), step 6:
  - **Generator:** adapted from Python's. Variables are instance variables with accessors (other objects, and subclasses for protected ones, reach them through those); names are snake_case, since a capitalized name is a constant in Ruby. A parent's version of a function is called with `Parent.instance_method(:name).bind_call(self, ...)`, because `super` only reaches the method of the same name. Several outputs come back as an array. Delay's action is a block, which leaves with `next` (a `return` would leave the method), and each Delay keeps its own `started_*` variable, since blocks share the method's variables.
  - **Literals:** strings are double-quoted with `#` escaped, so nothing is interpolated.
  - **The support file** (`vgraph_runtime.rb`) is a companion file next to every generated file, as GDScript's is; each copy reopens the one module `Vg`, so they share its state. It has number formatting (Ruby's shortest digits laid out as JavaScript does), JSON, conversions, dispatchers and the latent queue.
  - **Snippets:** the `RUBY` tables. An Integer divided by an Integer is a whole number in Ruby, and `%` follows the divisor's sign, so Divide and % go through Float (% with `remainder`). Replace uses `gsub`'s block form (its replacement text would read `\1`), Average adds in order (`Array#sum` compensates for rounding, JavaScript doesn't), and the file nodes read and write in binary (text mode turns `\n` into `\r\n` on Windows).
  - **Run:** `ruby` runs a launcher in the scaffold folder that requires the generated file by its path.
  - **Conformance:** all 25 fixtures pass, both object programs included.
- **As built**, step 7:
  - **Placement:** nothing to register: generated files require each other and their support file relatively, wherever they are.
  - **Symbol import:** `src/core/importing/ruby-scanner.ts` reads functions callable without an object, marked `@blueprint` in YARD comments: a module's or class's `def self.name`, a module's methods after `module_function` (or `extend self`), and top-level methods. Types come from `@param [Integer] points` (or `@param points [Integer]`) and `@return [Float]`: `Integer`, `Float`, `String`, `Boolean`, `Array<T>`, `Set<T>`, `Hash{K => V}`; plain `Array` and `Hash` hold any value, and other classes are native. Modules are found by Ruby's usual indentation (each `end` lines up with what it closes). Instance methods, splat, keyword and block arguments, and names ending in `?` or `!` are reported with the reason. Generated code requires the file relatively and calls `Scores.triple(...)`, or a top-level method alone; a test runs both.
  - **Debugging:** rdbg (the debug gem) through the VSCode rdbg Ruby Debugger, running Run's launcher. With Ruby 4.0 and debug 1.11, a step from a method's last line in rdbg's VS Code (DAP) mode runs the program to the end: no stop, just `terminated`. In a terminal, the same steps stop at the return and then in the caller. So the pack says its steps can't leave a function (`CodeDebugger.stepsLeaveFunctions: false`), and Step Out, or a step from a function's last node, resumes to a breakpoint on the caller's next node, which is removed when execution stops. The Debug test and the Phase 5 exit check pass.

## PHP (Tier 1)

- **Toolchain:** PHP 8.3 or later (`php` on the PATH), with the `mbstring` extension enabled, and Xdebug 3 for debugging.
- **Files:** `Name.vgraph.php` next to the graph, with a namespace from `composer.json`'s PSR-4 roots when the graph is under one (as C# takes its namespace from the project). Generated code loads other graphs and project files with `require_once`, so it doesn't depend on Composer's autoloader.
- **Representation:** `int`, `float`, `bool`, `string` and `null`. Arrays are PHP arrays, wrapped where a graph needs a reference (an array a node changes must change for its caller too, and PHP arrays are copied on assignment). Maps are arrays, insertion-ordered; sets are arrays of keys. Classes, inheritance, interfaces and exceptions map directly; Cast To is `instanceof`. Dispatchers are lists of `Closure`s.
- **Run:** `php` runs a launcher that calls Start, Main and the latent actions (or the tests).
- **Symbol import:** functions and `public static` methods marked `@blueprint` in docblocks, with their parameter types, read by a scanner like Java's.
- **Debugging:** Xdebug through the PHP Debug extension (`xdebug.php-debug`).
- **Risk to settle first:** arrays. Graphs share containers by reference everywhere, and PHP copies arrays on assignment, so arrays (and maps, which are the same type) need a small wrapper class in the generated code.

- **As built** (`src/core/languages/php.ts`, `php-runtime.ts`), step 8:
  - **Containers:** the support file's `VgList` (a list in a public `$items` array), `VgMap` and `VgSet`, which are objects, so they're shared by reference. A map keeps its keys in order and each key exactly as given: PHP's arrays would turn `"1"` into `1` and `1.5` into `1`.
  - **Generator:** adapted from Python's. Methods and properties are camelCase; property defaults must be constants in PHP, so the constructor sets them. Parent calls are `parent::name(...)`, Cast To is `instanceof`, interfaces are PHP interfaces, structs final classes with a `vgFields()` for printing, and enum values their names. Several outputs come back as an array. Delay's action is a closure (`$this` is bound; a retriggerable Delay passes its start count with `use`). `==` and `!=` compare as the semantics do (`Vg::equal`: 1 equals 1.0, nothing else converts). A graph's namespace comes from the generate options (Composer's PSR-4 roots in the extension, step 9); Run constructs the class by its fully qualified name.
  - **The support file** (`vgraph_runtime.php`) is a companion next to every generated file. Its classes (namespace `Vgraph`) are declared only if they aren't yet, so copies in different folders share them. Number formatting builds on `json_encode`'s shortest form (`serialize_precision` -1).
  - **Snippets:** the `PHP` tables. Text goes through mbstring; `mb_strtoupper` maps case fully, as JavaScript does (`ß` becomes `SS`).
  - **Run:** `php` runs a launcher in the scaffold folder. PHP prints warnings to the output by default, so the launcher sends them to stderr and turns them into exceptions, which stop the run as errors do.
  - **Conformance:** all 25 fixtures pass, both object programs included.
  - **Types** (since Phase 11): generated code and the support file declare their types and pass PHPStan at level 9 (docs/project-integration.md, part 3).
- **As built**, step 9:
  - **Placement:** `phpNamespace` reads the nearest `composer.json`'s PSR-4 roots (`autoload` and `autoload-dev`): a graph under one takes its namespace and the folders below it (`"App\\": "src/"` with a graph in `src/Game` gives `App\Game`); elsewhere, the global namespace. Generated classes name each other by that fully qualified name. Generated files load each other with `require_once`, so they don't need Composer's autoloader (whose PSR-4 rule, a file named after its class, they don't follow).
  - **Symbol import:** `src/core/importing/php-scanner.ts` reads functions and `public static` methods marked `@blueprint` in a docblock, typed by their declared types (`int`, `float`, `string`, `bool`, `?T` and `T|null`, `mixed`; a PHP `array` isn't a graph array, since graphs pass `VgList` objects, so it's native, as classes are), with literal defaults. Instance methods, magic methods, variadic and by-reference parameters are reported with the reason. Generated code calls `\App\Util\Scores::triple(...)`, or a namespaced function as `\App\Util\shout(...)`; a test runs both from a Composer project.
  - **Debugging:** Xdebug through the PHP Debug extension (`php` launch configuration on Run's launcher). PHP Debug switches Xdebug to debug mode only for its own launch of the current file, so the configuration does what that one does: `XDEBUG_MODE=debug,develop`, the client port in `XDEBUG_CONFIG` (on a free port, `port: 0`), and `-dxdebug.start_with_request=yes`. A `php.ini` needs only `zend_extension=xdebug`. The Debug test and the Phase 5 exit check pass (they skip, with the reason, where `php -m` doesn't list Xdebug).

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

Status: steps 1 to 10 done (2026-10-28). All four packs pass the conformance suite, have placement and symbol import, and pass the Debug test and the Phase 5 exit check.
