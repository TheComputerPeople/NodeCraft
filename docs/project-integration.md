# Project integration (Phase 11)

Phase 11 of the [roadmap](roadmap.md): the extension fits into any codebase, a new project or existing code, in each of its 12 languages. Asked for on 2026-11-07, as the first priority before generics in C++, Go, Lua and PHP and before code classes as parents.

The user chose to:

- make it a phase of its own;
- build all three ways in: a **New Project** command, **Set Up in This Project** for existing code, and generated code that **passes the project's own checkers**, tested on a corpus of real-world layouts.

They first chose to have generated code adapt to each project's declared language version, down to a floor per language, and to support Lua 5.1 and LuaJIT. Later the same day they set that aside ("skip retro-fitting to older languages right now"): this phase integrates with projects on the versions generated code supports today. It records each project's declared version only to say clearly when it's older than that (Part 2). Adapting to older versions is deferred, with its design kept at the end of this doc.

A "Built" section after each design says what each step built.

## Today

What already fits ([output-placement.md](output-placement.md), [language-breadth.md](language-breadth.md), [more-languages.md](more-languages.md)):

- **Placement detects the project.** Generated code goes next to its graph, in the form the project needs: JavaScript's module format from `package.json`, TypeScript's import extensions from `tsconfig.json`, Python's module from its packages and src layout, C#'s namespace from the `.csproj`, Java's package and source roots from Maven or Gradle, Go's package and module, Rust's module in its crate, PHP's namespace from Composer's PSR-4, and the Godot project for GDScript.
- **Existing code becomes nodes** in all 12 languages ([code-as-nodes.md](code-as-nodes.md)), and generated code imports it the way the project does.
- **Run** builds and runs a graph in its project; **Register Generated Files with the Build** offers the one-time hooks C++ and Rust need.

What doesn't:

1. **Recent versions only.** Generated code needs:

   | Language | Needs today | Why (as far as known; steps 4 to 8 measure each) |
   |---|---|---|
   | TypeScript, JavaScript | ES2022 (JavaScript as generated); Node.js 22.18 for Run | class fields; Run uses Node's type stripping |
   | Python | not measured | the generated module imports `from __future__ import annotations`, so annotations need only 3.7; the rest is unchecked |
   | C# | .NET 8 for Run; the language version not measured | |
   | C++ | C++20 | `std::erase`, `contains`, `<=>`; built with `-std=c++20` |
   | Java | 17 | records (16), `HexFormat` (17) |
   | Go | 1.21 (go.mod says 1.22) | the `slices` package |
   | Rust | edition 2021 | the scaffold's `Cargo.toml` |
   | Lua | 5.3 | `math.type`, `utf8`, `table.move`, integer and float subtypes |
   | GDScript | Godot 4.3 | as documented |
   | Ruby | 3.3 | as documented |
   | PHP | 8.3 as documented; 8.1 at least | Fibers and enums (8.1) |

   Many existing codebases are older: Java 8 or 11, C++17, PHP 7.4 or 8.0, Ruby 2.7 to 3.2, .NET Framework or Unity (C# 9). Most Lua runs on 5.1 or LuaJIT (LÖVE, Neovim, Defold, Redis).
2. **Nothing sets up a project.** New Graph writes a `.vgraph` file and nothing else. A new folder has no `package.json`, `pyproject.toml`, `.csproj` or `Cargo.toml` for the generated code to live in. An existing project gets its hooks one at a time, when a compile finds them missing.
3. **The project's own tooling isn't tested.** Generated code is compiled and run, but never put through a project's strict settings: `tsc --strict` with `noUnusedLocals`, mypy, ESLint, `-Wall -Werror`, clippy, `javac -Xlint -Werror`, `go vet`, PHPStan, luacheck, RuboCop.
4. **Layouts are untested.** The fixtures are single folders. Monorepos (npm, pnpm or Yarn workspaces), Cargo workspaces, `go.work`, multi-module Maven and Gradle builds, CMake subprojects, a solution of several `.csproj` files, Unity's `Assets` folder, Rails' and Laravel's folders: none is tried.
5. **Smaller gaps.**
   - New Graph, New Node and Add Blueprint Package use the first folder of a multi-root workspace, not the one the user is in.
   - Scanning the project's code and graphs stops at 5000 files, silently.

## Part 1: the project model

**Design.** One place knows each project in the workspace: src/core/projects.ts (pure, over a file-reading interface) and src/extension/projects.ts (watching).

- **A project** is a folder with a language's project file: `package.json` or `tsconfig.json`, `pyproject.toml` or `setup.py` or `setup.cfg`, `*.csproj`, `CMakeLists.txt` or `Makefile` or `*.vcxproj`, `Cargo.toml`, `pom.xml` or `build.gradle(.kts)`, `go.mod`, `.luarc.json` or `*.rockspec`, `project.godot`, `Gemfile` or `*.gemspec`, `composer.json`.
- **What it records:**
  - its root;
  - its language or languages;
  - its build system;
  - its workspace (an npm, pnpm or Yarn workspace, a Cargo workspace, `go.work`, a Maven parent, a Gradle settings file, a CMake parent, a `.sln`);
  - its **declared language version**, to compare with what generated code needs (Part 2);
  - the checkers it configures (`tsconfig` strictness, `.eslintrc*` or `eslint.config.*`, `mypy.ini` or `[tool.mypy]`, `ruff.toml` or `[tool.ruff]`, `.editorconfig`, `Directory.Build.props` with `TreatWarningsAsErrors`, `clippy.toml`, `.luacheckrc`, `.rubocop.yml`, `phpstan.neon`).
- **Placement** reads the model instead of looking up files itself, so every language's placement sees workspaces and nested projects the same way.
- **Multi-root.** Every command works in the workspace folder of the file or folder it's run on, falling back to asking which folder when there is none.
- **Large codebases.** Scanning has no silent limit. Past 5000 files, scanning warns once, names the setting `blueprintVisualScripting.scanLimit`, and keeps the files nearest to the graphs.

## Part 2: versions, reported

**Design.** Generated code keeps needing what it needs today. The phase makes that known and checked:

- **What generated code needs** is measured for each language (step 2) and written in the language's doc and in each pack: `LanguagePack.requires`, e.g. Java 17, C++20, Go 1.21, PHP 8.1, Lua 5.3.
- **What the project declares** is read where projects declare it:

  | Language | Read from |
  |---|---|
  | TypeScript, JavaScript | `tsconfig.json` or `jsconfig.json` `target`; `package.json` `engines.node` |
  | Python | `pyproject.toml` `requires-python`, `.python-version`, `setup.cfg` `python_requires` |
  | C# | `.csproj` `LangVersion`, else its `TargetFramework`'s default |
  | C++ | `CMAKE_CXX_STANDARD` or `cxx_std_NN`, `-std=` in `compile_commands.json`, a `.vcxproj`'s `LanguageStandard` |
  | Java | `maven.compiler.release` or `source`, Gradle's `sourceCompatibility` or toolchain `languageVersion` |
  | Go | `go.mod`'s `go` line |
  | Rust | `Cargo.toml` `edition` and `rust-version` |
  | Lua | `.luarc.json` `runtime.version`, a rockspec's `lua` dependency |
  | GDScript | `project.godot` `config/features` |
  | Ruby | `.ruby-version`, the `Gemfile`'s `ruby`, a gemspec's `required_ruby_version` |
  | PHP | `composer.json` `require.php` |

- **When it's older**, compiling a graph in that project gives a warning, once per project in Problems (on the file that declares the version) and in the graph's Compiler Results: "This project declares Java 11 (pom.xml); generated code needs Java 17." Set Up in This Project lists it under **Can't** (Part 5). Generation goes on: the project may build with a newer toolchain than it declares.
- **Without a declaration**, nothing is said.

**Built (step 2: Parts 1 and 2).**

- **The model** (src/extension/projects.ts, free of the vscode API like placement.ts):
  - `projectAt(dir)` reads a folder's project files: each language's, as above, with a Makefile counting only beside C++ sources.
  - It records the build systems, languages, project files, declared versions and configured checkers. Comments and trailing commas in `tsconfig.json` and `.luarc.json` are allowed, and a `tsconfig.json`'s relative `extends` is followed.
  - `findProjects(root)` walks a workspace folder (to a depth of 8), leaving out dependencies, build output and tool folders (`node_modules`, `target`, `vendor`, `.venv`, `blueprint-packages`, ...). It gives each project the workspace it belongs to: npm or pnpm workspaces, a Cargo `[workspace]`, `go.work`, Maven `<modules>`, a Gradle settings file, a parent `CMakeLists.txt` with `add_subdirectory`, a `.sln`.
  - `nearestProject(dir, stopDir, language)` finds a graph's project: the nearest folder above it with a project of the graph's language.
  - **Placement keeps its own lookups.** They already take the nearest project file of their kind, which is what the model would give them, so rewiring them would change nothing a user sees. The model serves the version warning now, and Set Up in This Project (Part 5) later.
- **What generated code needs** was measured on the node audit's program (Phase 10), which uses every built-in node. `LanguagePack.requires` declares it (src/core/versions.ts):

  | Language | Needs | How it was measured |
  |---|---|---|
  | TypeScript | the ES2020 library | `tsc --strict` without `@types/node` at each `--lib` level: ES2019 lacks `String.matchAll` (Regex Find All). `tsc` compiles the syntax down. |
  | JavaScript | ES2022 | class fields; `?.` and `??` |
  | Python | 3.8 | syntax parses as 3.7 (`ast.parse` with `feature_version`); no newer library calls; annotations aren't evaluated (`from __future__ import annotations`) |
  | C# | 10 | built at each `LangVersion`: 9 lacks file-scoped namespaces |
  | C++ | C++20 | `-std=c++17` lacks `std::erase`, `starts_with` and defaulted `==` |
  | Java | 17 | `--release 16` lacks `HexFormat`; 11 lacks switch rules and pattern matching in `instanceof` |
  | Go | 1.21 | the `slices` package and the `min` and `max` built-ins (read, since only one Go is installed) |
  | Rust | edition 2018 | built as edition 2018. Its minimum compiler (`rust-version`) can't be measured with one toolchain, so it isn't checked. |
  | Lua | 5.3 | `math.type`, `utf8`, `table.move` |
  | GDScript | Godot 4.3 | tested only (marked `tested`) |
  | Ruby | 3.3 | tested only: nothing installed can check an older Ruby |
  | PHP | 8.1 | Fibers and enums; nothing newer found in the generated code or runtime |

- **Declared versions** become the lowest version they allow (`lowestVersion`): `>=3.8`, `^3.8`, `~> 3.8` and `3.8.*` give 3.8, `^7.4 || ^8.0` gives 7.4, and `<4` gives none.
  - Some read in a language's own scale: an ES target is a year, `LuaJIT` is 5.1, Java's `1.8` is 8, and Cargo without an edition is 2015.
  - A `.csproj` without `LangVersion` uses its target framework's default (`net6.0` is C# 10, `netstandard2.0` and `net48` are 7.3).
- **The warning** (`projectVersionDiagnostics`, code `project-version`) goes with the graph's other placement warnings in Compiler Results. (Since the step 3 follow-up, Problems shows it once, on the project's file, rather than on each graph.) For example: "This project declares 11 in pom.xml, but generated Java needs Java 17 (switch rules, pattern matching in instanceof and HexFormat). Older versions may not build or run it." Generation goes on.
- **Multi-root.** New Graph, New Node, Test Node Library and Add Blueprint Package work in the workspace folder of what they're run on, then of the active editor's file (a graph editor counts), then the only folder, then one the user picks (src/extension/workspace-folders.ts). Compiling already used the graph's own folder.
- **Scanning.** Every workspace scan (source files, graphs, node files, package manifests and their entries) stops at the `blueprintVisualScripting.scanLimit` setting (5000). A scan that reaches it says so once, with Open Settings, instead of leaving files out silently. It doesn't choose which files to keep; VS Code's search order decides.
- **Tests.**
  - Unit (test/unit/projects.test.ts): every language's project and declared version, `tsconfig` extends and comments, workspaces in a tree with dependencies and build output left out, checkers, a graph's nearest project, `lowestVersion`, the warning's wording, and every pack declaring what it needs.
  - Integration: a Java graph in a Maven project declaring Java 11 compiles with the warning, and its file is generated all the same.

## Part 3: the project's checkers

**Design.**

- **Two kinds of checker:**
  - **Compilers and type checkers** must pass on generated code with the project's strictest settings: `tsc --strict` with `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; mypy `--strict`; C# nullable with warnings as errors; `-Wall -Wextra -Werror`; clippy `-D warnings`; `javac -Xlint:all -Werror`; `go vet`; PHPStan level 9; Godot's warnings as errors.
  - **Style linters** may differ from generated code's style: ESLint, Ruff, RuboCop, luacheck, PHP_CodeSniffer. Generated files carry each one's standard "generated" marker so it skips them: `/* eslint-disable */`, `# ruff: noqa`, `# rubocop:disable all`, `-- luacheck: ignore`, `// @phpcs:disable`. They also carry the header's `@generated`, which many tools and code review honor.
- **`.gitattributes`.** New Project, and Set Up when the user agrees, add `*.vgraph.* linguist-generated` (and each language's file pattern), so diffs and statistics treat generated files as generated.
- **Tests: a corpus of layouts** (test/fixtures/projects/), each a small but real-shaped project:

  | Language | Layouts |
  |---|---|
  | TypeScript | a Vite app (ESM, bundler resolution), a Node library built with `tsc` (`rootDir`, `outDir`, CommonJS), a pnpm monorepo with a shared package and path aliases |
  | JavaScript | CommonJS and ESM packages |
  | Python | a src layout with `pyproject.toml`, a flat scripts folder, a Django-shaped package |
  | C# | an SDK console with nullable and warnings as errors, a solution of two projects |
  | C++ | CMake with a library subproject, a plain Makefile project |
  | Rust | a binary crate, a workspace of two crates |
  | Java | Maven, a multi-module Gradle build |
  | Go | a module with internal packages, a `go.work` of two modules |
  | Lua | a LuaRocks library, a plain script folder with `.luarc.json` |
  | GDScript | a Godot project with an addon |
  | Ruby | a gem, a Rails-shaped app (without Rails) |
  | PHP | a Composer PSR-4 library, a Laravel-shaped app (without Laravel) |

  For each, the test puts graphs where a user would: one using the project's code, and one the project's code calls. It compiles them, then runs the project's own build and checkers, and its own entry point or tests, which must use the generated code. A checker or toolchain that isn't installed is reported in the test's output as skipped, by name.

**Built (step 3: TypeScript, JavaScript, Python, C#, Java).**

- **Measured first.** Before the corpus, every node's generated code (the node audit's program), the conformance fixtures and the two programs (classes, a subclass, structures, enumerations) were put through each checker at its strictest. They failed in these ways:

  | Language | Checker, at its strictest | Found |
  |---|---|---|
  | TypeScript | `tsc` with the options of `@tsconfig/strictest` plus `verbatimModuleSyntax` | about 140 errors: indexing without `noUncheckedIndexedAccess`'s check, imports and fields nothing reads, a Branch's unreachable side, a fallback `return` after an if whose sides both return, a missing `override`, two constants compared |
  | JavaScript | `tsc` with `checkJs` and `strict` | two constants compared |
  | Python | mypy `--strict`; Pyright `strict` | 93 and 377: untyped helpers in snippets, a missing `Any` import, a float stored in an int, unused imports and functions, types Pyright can't know after `isinstance` |
  | C# | nullable, warnings as errors, `WarningLevel` 9999, `AnalysisLevel` `latest-all`, `EnforceCodeStyleInBuild`, `GenerateDocumentationFile` | the analyzers' style rules (CA1051, CA1822, ...), the security rules on `Random`, MD5 and SHA-1, and missing XML comments |
  | Java | `javac -Xlint:all -Werror` | one redundant cast |

- **Fixed for every language, in compiling** (src/core/compiler):
  - **An unconnected condition is decided when compiling.** A Branch whose condition is a constant runs its side only, and a Switch on a constant selection its case. An Assert Equal of two constants holds (and is left out) or fails (`assert false`). The other side can't run, and checkers reject it as unreachable or as comparing constants.
  - **What nothing reads isn't kept** (src/core/compiler/prune.ts). A node output nothing wires anywhere is still computed, but not stored: the call stays, its result goes. Its slot and its debugger pin go too. The code preview keeps them, since it shows one node whose outputs nothing in the preview reads.
  - **A function's fallback return goes only where it can be reached** (`canComplete`, which Java had): TypeScript, Python and C# now leave it out after an if whose sides both return.
- **TypeScript and JavaScript:**
  - **Imports are of what the code uses.** A file imported every type the program knows, a parent class's field types too; now it keeps the names its code uses, outside comments and strings (JSDoc stays: JavaScript's types are there). A property named like a type (`this.Villain!.Stats`) isn't a use.
  - `override` on a function that replaces the parent's, and on a subclass's `start`.
  - **Indexing:** a For Each's element, and 15 nodes' snippets (First, Last, Get, Min, Max, Median, Random Item, Shuffle, Swap, Capitalize, Format, the case conversions and Slugify), get TypeScript versions that tell `noUncheckedIndexedAccess` the index is in range (`items[0]!`). JavaScript keeps its snippets.
  - The hash nodes reach Node.js through `any`, as the other Node.js snippets do, so a project without Node.js's types (a browser app) type-checks them.
- **Python:**
  - **A float wired into an int is truncated toward zero**, as C# and Java do (docs/semantics.md): stores, calls' arguments, struct fields and return values. Python's ints and floats are different types: a float can't index a list. (The follow-up below makes this hold in Simulate and every language.)
  - Snippets' nested functions are annotated, `Any` is imported wherever a helper uses it, an enum prints as `str`, and the format helper casts what `isinstance` found to known types (for Pyright), but not to `isinstance`'s own type (which mypy would call a redundant cast). The async helper is left out when nothing awaits.
  - **Imports are of what the code uses**, as in TypeScript.
  - **The test file imports its class by its full module name** (`tests.calc_vgraph`) when it's in a package, from the folder above the top package: type checkers resolve that, not a module found through a folder put on `sys.path`. `GenerateOptions.module` carries the name.
- **C#:** `// <auto-generated/>` (Roslyn's analyzers and code style skip the file; the compiler doesn't), and `#pragma warning disable` for the security rules on what nodes are for (CA5350, CA5351 and CA5394: MD5, SHA-1 and `Random`) and for CS1591 (missing XML comments).
- **Java:** a whole-number constant Add reads is written as a double (`0.0`), not cast.
- **Markers for style linters**, after the header's first line (which recognizes generated files):

  | Language | Marker | What it covers, and the catch |
  |---|---|---|
  | TypeScript, JavaScript | `/* eslint-disable */` | ESLint. ESLint (9 and later) warns about a directive that suppressed nothing, so a project linting with `--max-warnings 0` fails on a generated file with no problems. Set Up in This Project offers adding the generated files to ESLint's ignores instead (step 6). |
  | Python | `# flake8: noqa`, `# pylint: skip-file` | Ruff and flake8, and Pylint. Ruff's PGH004 (on with `select = ["ALL"]`) rejects a blanket `noqa`; Set Up offers Ruff's `extend-exclude` instead. Ruff has no file-level marker that names rules. |
  | C# | `// <auto-generated/>` | Roslyn's analyzers and code style |
  | Java | none | Checkstyle, PMD and SpotBugs are set up with suppression files; `@Generated` would need `requires java.compiler` in a modular project. |

  Formatters (Prettier, Black, `dotnet format`) are left out: their checks need the generated files in their ignore lists, which Set Up offers.
- **Placement in one place.** What a generator needs to know about a graph's folder (`generateOptionsFor`), where a graph generates and the module others import it as (`graphOutputFor`), and the module of a file of the project's code (`codeModuleFor`) moved into src/extension/placement.ts. Compiling, the graph libraries, the project functions and the corpus all use them.
- **The corpus** (test/conformance/corpus.ts, test/conformance/corpus.test.ts; layouts in test/fixtures/projects):

  | Layout | Its checkers and run |
  |---|---|
  | ts-vite-app | Vite's tsconfig with every strictness option, ESLint with typescript-eslint's strict and stylistic type-checked rules, `node src/main.ts` |
  | ts-node-library | `tsc` to `dist` as CommonJS (`rootDir`, `outDir`, declarations), `node dist/index.js` |
  | ts-pnpm-monorepo | `pnpm install` (workspace links), `tsc` in both packages (a path alias in the app), the app calling the shared package and the generated code |
  | js-commonjs, js-esm | `tsc` with `checkJs` and `strict`, ESLint's recommended rules, `node` |
  | py-src-layout | mypy `--strict`, Pyright `strict`, Ruff (`E`, `F`, `W`, `I`, `UP`, `B`, `SIM`, `N`), `python -m corpus_game` |
  | py-scripts | mypy `--strict` on the folder's scripts, Ruff, `python scripts/main.py` |
  | py-django-shaped | mypy `--strict` (`setup.cfg`), `python manage.py greet ada` |
  | cs-console | nullable, warnings as errors, `AnalysisLevel` `latest-all`, code style in the build, the documentation file, every analyzer rule a warning (`.editorconfig`), `dotnet run` |
  | cs-solution | a `.sln` of a library and an app referencing it (`Directory.Build.props`), `dotnet run` |
  | java-maven | `-Xlint:all -Werror` in the compiler plugin, offline; `java -cp target/classes` |
  | java-gradle-multi | `settings.gradle` with two modules, `-Xlint:all -Werror`, `gradle build :app:run`, offline and without the daemon |

  - **In each,** a function library graph, Greet, calls the project's `@blueprint` function and is called by the project's entry point, which must print "Hello, Ada!".
  - **In one layout of each language** (ts-vite-app, js-esm, py-src-layout, cs-console, java-maven), the node audit's program, the conformance fixtures and both programs are generated into the project too, each in a folder of its own, so its checkers see every node's code.
  - **The harness** copies a layout, scans its code, compiles its graphs with the placement functions, and runs its steps.
    - A Windows `.cmd` tool runs through the shell.
    - A timeout ends the whole process tree.
    - Builds don't leave servers running: Gradle without its daemon, dotnet without node reuse or the shared compiler.
  - **Missing tools.** A step whose tool is missing is skipped and named in the test's output, and so is each step after it.
  - **Node.js tools.** `npm run corpus:tools` installs them (TypeScript 5, ESLint, typescript-eslint, Node.js's types) into a folder outside the repository (`%LOCALAPPDATA%\blueprint-corpus\node`, `~/.cache/blueprint-corpus/node`, or `BLUEPRINT_CORPUS_TOOLS`). It's linked in above the layouts as their `node_modules`. TypeScript 5 is what most projects pin, and typescript-eslint doesn't support the TypeScript 7 the repository builds with.
- **Known limit:** generated TypeScript imports another workspace package's code by a relative path. That works where the app type-checks without emitting (a bundler, as in the corpus), but not under a `rootDir` or project references, which want the package's name. Set Up reports it (step 6).
- **Tests:** unit tests for the folding (test/unit/compiler.test.ts) and for each rule above (test/unit/checkers.test.ts); the corpus, 12 layouts.

**Built (step 3, follow-up: what a review of steps 1 to 3 found).**

- **A float wired into an int is truncated toward zero everywhere** (docs/semantics.md, "Values"). Before, Simulate, TypeScript, JavaScript, Lua, Ruby and PHP kept the fraction, and Python missed some places.
  - **Simulate** truncates a number that an int pin reads (`inputValue`).
  - **The generated code:**
    - TypeScript and JavaScript use `Math.trunc`, Lua `vg.trunc` (from its support module), Ruby `.truncate`, PHP `(int)` and GDScript `int()`.
    - Python now converts at the calls it missed: dispatchers, interface, parent and object calls, For Loop's bounds and containers' elements.
    - The packs find a call's parameters through shared helpers: `broadcastParams`, `targetCallParams` and `dataPins` in ir.ts.
  - **Declarative packs** get a `toInt` template. Without one, the value goes in as it is, so existing packs keep building.
  - **Compiling:**
    - Do N's N and MultiGate's Start Index pass through an int slot, so their comparisons see the truncated value.
    - Switch on Int's constant fold truncates.
  - **Tests:** a conformance fixture, float-to-int.vgraph. It wires a float into a variable, a function's input and output, a custom event's input, For Loop's Last Index, Do N's N and Switch on Int's Selection. events.vgraph now calls its dispatcher with 3.5 and 4.5. Every pack passes both, the declarative and C example packs included.
- **Breakpoints that can't stop.** Debug says which breakpoints are on nodes that left no code (a Branch's dead side, a value nothing reads). Before, they stayed silent.
- **The version warning, once per project.** Problems shows it on the line of the project file that declares the version (`projectVersionCheck`), and clears it when a compile finds it fixed. Each graph's Compiler Results still has it.
- **One compile for Compile and the corpus.**
  - src/extension/graph-compile.ts (`compileGraphFile`) is the sequence Compile ran inline: the graph's language, a shared type's other languages, writing, removing stale outputs, build registration, and the placement and version checks. CompileService gives it VS Code's file system and OutputPlans.
  - The corpus gives it `fs`, and registers generated files as if the user accepted every hook (`applyAcceptedPlan`), which step 4's C++ and Rust layouts need.
  - What a graph file gives other graphs, with where each of its languages generates it, is `graphFileNodes` in placement.ts. The graph libraries and the corpus both use it.
  - This found drift: the corpus registered a shared struct without its other languages' outputs, so a Python graph imported it from the TypeScript file. The extension had it right.
- **The corpus covers what users write**, 13 layouts:
  - **Project code beyond plain functions.** In each language's body layout, the project's code has a class and a subclass, a function with several results, a generic function and an async one, each in that project's style. Four graphs use them (the conformance suite's builders), and the entry point runs them.
  - **Tests.** A graph of Test Case events runs with the project's test runner: `node --test` (ts-vite-app, js-esm) and `unittest` (py-src-layout). C# and Java write no test files.
  - **A browser app.** ts-vite-app has no Node.js types now, as Vite's template doesn't. The generated test file's `node:test` import carries `// @ts-ignore`, so `test` is untyped there and the file still type-checks.
  - **Two languages.** ts-py-shared is a TypeScript `web/` and a Python `api/` sharing a struct in `shared/`. Each side has a graph that makes one and prints it, and each passes its checker and runs.
  - **Stricter results.** Compile's warnings fail a layout. A layout with skipped steps is reported as todo, not passed, and `BLUEPRINT_CORPUS_REQUIRE_TOOLS` makes a missing tool fail it. Elsewhere than Windows, each command leads its own process group, so a timeout ends everything it started.
- **Found by the new layouts, and fixed:**
  - **Python wrote `_delay`** when a graph only awaited project code, and Pyright strict reports an unused function. It's written only with a Delay now.
  - **Python's latent runner was private**, so a project's code couldn't run a graph's Delays and async calls without reaching into it. It's `run_latent_actions()` now, beside C#'s and Java's public `RunLatentActions()` / `runLatentActions()` (docs/code-as-nodes.md).
  - **The C# scanner** reads primary constructors as the class's constructor, exposed by the class's marker, and a base without the arguments passed to it.
  - **Collection interfaces** as parameters are containers in C#: `IReadOnlyList<T>`, `IEnumerable<T>`, `ISet<T>`, `IReadOnlyDictionary<K, V>` and the rest. A project whose analyzers enforce CA1002 takes those, and a graph's `List` passes as it is. Returns of them stay native.
- **The project model reads project files on each compile**, rather than caching and watching them as the design said. They're the few small files on the way up from the graph, and reading never goes stale. Placement still keeps its own lookups (above).

**Built (step 4: C++, Rust, Go, Lua, GDScript, Ruby, PHP).**

- **The corpus has 26 layouts.** Each language's entry point calls its graphs, then its latent runner, which every language now has from the project's code (docs/code-as-nodes.md).

  | Layout | Its checkers and run |
  |---|---|
  | go-module | internal packages; `go build`, `go vet`, staticcheck, `go run ./cmd/corpus` |
  | go-workspace | a `go.work` of two modules; the app's graph calls the other module |
  | rust-bin | clippy `-D warnings` with the pedantic group, `unsafe_code` forbidden, `cargo fmt --check`, `cargo run` |
  | rust-workspace | two crates; the app's graph calls the library crate |
  | cpp-cmake | a library subproject; `-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Werror`; CMake with MinGW's make on Windows |
  | cpp-make | a Makefile whose `$(wildcard)` sources take in the generated files |
  | ruby-gem | RuboCop, `gem build`, `ruby -w` with no warnings |
  | ruby-rails-shaped | Rails' folders loaded as its autoloader would; RuboCop, `ruby -w` |
  | php-composer-lib | Composer's PSR-4 autoloader, PHPStan level 9, PSR-12 through PHP_CodeSniffer, PHP with every error reported |
  | php-laravel-shaped | Laravel's folders and an `artisan` command |
  | lua-rock | a rockspec, `.luarc.json`'s `runtime.path` in `src/`; luacheck, `lua` |
  | lua-scripts | a script folder with a `.luarc.json`; luacheck, `lua` |
  | gd-addon | an addon with the code the graphs call; `godot --import`, every script compiled with Godot's default warnings as errors, the main scene |

  - The body (the node audit and the conformance fixtures) is in go-module, rust-bin, cpp-cmake, ruby-gem, php-composer-lib, lua-rock and gd-addon. A body program using what a language lacks (inheritance in Go, Rust and Lua) is reported as not applicable, as the conformance suite reports it. C++ takes only the arena program, whose classes share names with the duel's in the global namespace.
  - A step that only checks (a linter, a type checker) doesn't hold up the steps after it when its tool is missing; a step whose stderr must be empty fails on an interpreter's warnings.
  - **PHP's tools** (Composer, PHPStan, PHP_CodeSniffer) are `.phar` files `npm run corpus:tools` downloads. Composer won't start without PHP's openssl extension, even to write the autoloader (which needs no network), so the corpus loads it for them (`-d extension=openssl`) when the installed PHP has it but doesn't load it; the php.ini stays as it is. luacheck wasn't installed when this was built, so the Lua layouts are partly checked.
- **Found by the layouts, and fixed:**
  - **Go:** the standard `// Code generated … DO NOT EDIT.` header, which staticcheck's style checks, gopls and code review honor; a literal list in For Each was `*&[]T{…}` (staticcheck SA4001).
  - **Rust:**
    - A graph using another graph's types wrote them unqualified: placement gave Rust no module. And a graph calling another crate of a workspace called it through `crate::`. Modules are now named with their crate (`GenerateOptions.crate`), and Run's scratch crate takes the code's crate's name.
    - `&str`, `&String`, `&[T]` and `&Vec<T>` parameters are pins, passed as a borrow (`FunctionImplementation.borrowed`), as clippy's pedantic lints ask project code to take them.
    - The latent queue's waker has no unsafe code, for crates that forbid it. Generated files allow clippy's pedantic, nursery and restriction groups and `missing_docs`, are marked `@generated`, and are declared `#[rustfmt::skip]` in a sorted block.
    - Two graphs of one name in a crate are one module; placement declares the first and says so. C++ placement does the same for classes of one name in a target.
  - **C++:** a Makefile with `$(wildcard)` sources needs no registration; Base64 decoding passed `-Wconversion`.
  - **Lua:** modules were required from the workspace folder; a rock requires them from `src/`. The require root comes from `.luarc.json` (`luaRequireRoot`), the support module goes there, and Run's `package.path` starts there.
  - **GDScript:** under warnings as errors, the support script shadowed `Object.call` and the built-in `sign`, a fallback return and a failure check followed a Branch whose sides both return (unreachable code), and a timestamp was divided as integers.
  - **Ruby:** generated files start with `# frozen_string_literal: true` (RuboCop asks for it on the first line, and generated code changes no literal), then the header.
  - **Every language:** generated files are recognized by their header among their first lines and in Lua's comments too. Before, Lua's (`--`) and PHP's (after `<?php`) weren't, so renaming a graph or removing a stale output didn't find them.
- **Markers for style linters:** `# rubocop:disable all` (Ruby), `-- luacheck: ignore` (Lua), `// phpcs:ignoreFile` (PHP), each after the header's first lines, which now say `@generated` too.
- **Generated PHP passes PHPStan at level 9.** Measured first: 2,766 errors in php-composer-lib, 2,648 of them missing types.
  - **Typed:** every property, parameter and return is declared from its pin's type: `int`, `float`, `string`, `bool`, a struct's class, an enum's values as `string`, an object as its class or `null`, anything else `mixed`. PHPDoc adds what PHP can't say: a container's element types (`VgList<int>`, `VgMap<string, float>`) and several results (`array{int, bool}`).
  - **The support file is typed:** `VgList<T>`, `VgSet<T>` and `VgMap<K, V>` are generic in their PHPDoc, and every function has its types. Structures implement `VgStruct` (their fields for Print), Map Find reads through `VgMap::at`, Sort through `Vg::sorted`, and a Fiber's value keeps its type through `Vg::awaitLatent`.
  - **An empty reference** is checked where an object is used: `Vg::object($x)` gives it or stops the run with "Accessed None" (docs/semantics.md), as C++'s runtime does.
  - **Literals:** a whole number for a float is written with its point (`14.0`), and a map literal is a list of key-value pairs.
  - **Found and fixed for every language, in compiling:** a loop's Break flag is kept only when something is wired to Break, and MultiGate's Start Index and Loop are decided when they're constants. Checkers called the conditions they left always true.
  - **Snippets:** Round, Floor, Ceil and Truncate stop the run on a value that isn't finite ("Value must be a finite number", as Round To does): an int can't hold one. Load File, Get Environment Variable, Base64 Decode, Format String, Regex Replace and the whitespace nodes handle PHP's `false` and `null` results. An Assert Equal of two constants that differ fails through `Vg::fail`.
  - **The scanner** reads PHPStan's `Fiber<TStart, TResume, TReturn, TSuspend>` as well as `Fiber<T>`.
- **Known limits:**
  - PSR-4 doesn't autoload generated PHP classes, whose files are named after their graphs (`Greeting.vgraph.php`): the project requires them, and each requires what it uses. Set Up can offer a Composer `classmap` entry (step 6).

## Part 4: New Project

**Design.** **Blueprint: New Project…** asks for a language and a folder (an empty one, or a new one in it). It writes a minimal project in that language's usual layout, with a first class graph that prints "Hello from Blueprint" and runs:

| Language | Files |
|---|---|
| TypeScript | `package.json` (ESM), `tsconfig.json` (strict), `src/Main.vgraph` |
| JavaScript | `package.json` (ESM), `src/Main.vgraph` |
| Python | `pyproject.toml`, `src/<name>/__init__.py`, `src/<name>/Main.vgraph` |
| C# | `<Name>.csproj` (SDK, nullable), `Main.vgraph` |
| C++ | `CMakeLists.txt` including the extension's generated-files include, `src/main.cpp`, `src/Main.vgraph` |
| Rust | `Cargo.toml`, `src/main.rs` declaring the generated module, `src/Main.vgraph` |
| Java | `pom.xml` (or `build.gradle` if Gradle is on the PATH and Maven isn't), `src/main/java/<package>/Main.vgraph` |
| Go | `go.mod`, `main.go` calling the generated package, `game/Main.vgraph` |
| Lua | `.luarc.json` (the Lua found on the PATH), `main.lua`, `Main.vgraph` |
| GDScript | `project.godot`, a main scene running the graph's class, `Main.vgraph` |
| Ruby | `Gemfile`, `.ruby-version`, `lib/main.rb`, `lib/Main.vgraph` |
| PHP | `composer.json` (PSR-4), `src/Main.vgraph`, `bin/main.php` |

- **Every project gets:** a `.gitignore` for the language's build output, the `.gitattributes` above, and a README saying how to run it with and without VS Code.
- **Versions** are what generated code needs, or newer when the installed toolchain is, written in the project's files (so Part 2 reads them back).
- **It opens the graph, compiles it, and offers Run.**

**Built (step 5).**

- **Blueprint Visual Scripting: New Project...** (src/extension/new-project-command.ts) asks for the language, the folder (the project goes in it when it's empty, else in a new folder named after the project) and the name. It writes the project, opens its graph in the graph editor, compiles it and offers Run. A folder outside the workspace is offered to open or to add to it.
- **The project** (src/extension/new-project.ts, free of the vscode API): the files of the table above, with an entry point in every language, so the project runs without VS Code too (`node src/main.ts`, `python -m name`, `dotnet run`, `cargo run`, `go run .`, `lua main.lua`, `php bin/main.php`, ...). Each one runs the graph's Start, then the language's latent runner where it has one.
  - The graph compiles when the project is written, and its generated files are registered with the build as if every hook were accepted: a CMake project gets the `vgraph.cmake` include, a Rust crate its module block.
  - `.gitattributes` marks `*.vgraph.*`, the language's own pattern (`*_vgraph.py`, from its pack's output file name) and the support files as `linguist-generated`.
  - The README says how to run it in VS Code and without it.
- **Versions.** Settings that pin a toolchain take the installed one's version when it's newer than what generated code needs: .NET's target framework (`net10.0` with the .NET 10 SDK), Java's release, Go's `go` line, Godot's feature, `.ruby-version` and Lua's runtime. Floors keep what generated code needs (`requires-python = ">=3.8"`, PHP's `>=8.1`), so older interpreters still work. The tool's version is read with its `--version`.
- **Java** uses Maven, with its plugins pinned (as Maven asks), or Gradle when Gradle is on the PATH and Maven isn't.
- **Tests:** test/conformance/new-project.test.ts makes the project in each of the 12 languages (and Java with Gradle) and runs its checkers and entry point with the corpus's step runner: `tsc`, mypy `--strict`, `dotnet build -warnaserror`, CMake with `-Wall -Wextra -Werror`, clippy and `cargo fmt --check`, Maven and Gradle, `go vet`, Godot's import, `ruby -w`, PHPStan at level 9, and each prints "Hello from Blueprint". Each project's declared version reads back without a warning. The integration suite runs the command.

## Part 5: Set Up in This Project

**Design.** **Blueprint: Set Up in This Project** runs on an existing codebase (the workspace folder, or a folder picked in the Explorer) and shows a report in a webview, one section per project found (Part 1):

- **Found:**
  - the language, the build system, and the declared version against what generated code needs;
  - where graphs placed in each source folder would generate;
  - the checkers found.
- **Needs:** each one-time hook the project needs before generated code builds, as today's Register Generated Files offers them (a CMake include, a Rust `mod`, a `tsconfig.json` include, a legacy `.csproj`'s import), each with **Show Change** and **Apply** buttons. Applying is an undoable workspace edit; nothing is changed without a click.
- **Can't:** a declared version older than generated code needs, a build system the extension can't hook (Bazel, Meson, Unreal's), and a checker with settings generated code can't meet. Each says what to do instead.
- **Optional:** add `.gitattributes`, add `@blueprint` to a function (Phase 9's quick fixes), and create a first graph in a chosen folder.

Register Generated Files with the Build stays, and its hooks move into the report.

## Exit check

- The corpus passes: in every layout, generated code builds and passes the project's own checkers, runs from the project's own entry point, and calls and is called by the project's code.
- New Project makes a project that compiles and runs in each of the 12 languages, and passes its own checkers.
- Set Up in This Project reports correctly on the corpus (including a project declaring an older version than generated code needs), and applying its hooks makes the C++ and Rust layouts build.
- A multi-root workspace of two projects in different languages works from both folders.

## Steps

One commit each; large steps may take several.

1. This design, and the roadmap. (Amended the same day: older versions deferred.)
2. The project model: detection, workspaces, declared versions and checkers; what each language's generated code needs, measured and declared by its pack; the version warning; placement on top of the model; multi-root and the scan limit.
3. The corpus: layouts, the harness, compilers and type checkers; markers for style linters; fixes. TypeScript, JavaScript, Python, C#, Java.
4. The corpus: C++, Rust, Go, Lua, GDScript, Ruby, PHP.
5. New Project.
6. Set Up in This Project.
7. The exit check, docs, the parity checklist and status.

## Deferred: older language versions

Set aside on 2026-11-07, before building. The design as it was, for when it's taken up:

### Generated code for the project's version

**Design.**

- **Declared version.** Each language reads where projects declare it:

  | Language | Read from | Floor |
  |---|---|---|
  | TypeScript | `tsconfig.json` `target` and `lib`; `package.json` `engines.node` | ES2020, Node.js 18 |
  | JavaScript | `jsconfig.json` `target`; `package.json` `engines.node` | ES2020, Node.js 18 |
  | Python | `pyproject.toml` `requires-python`, `.python-version`, `setup.cfg` `python_requires` | 3.8 |
  | C# | `.csproj` `LangVersion`, else its `TargetFramework`'s default (`netstandard2.1` is C# 8, `net48` 7.3); Unity's `ProjectSettings` | C# 8 (Unity 2020, .NET Standard 2.1) |
  | C++ | `CMAKE_CXX_STANDARD` or `cxx_std_NN`, `-std=` in `compile_commands.json`, a `.vcxproj`'s `LanguageStandard` | C++17 |
  | Java | `maven.compiler.release` or `source`, Gradle's `sourceCompatibility` or toolchain `languageVersion` | 11 |
  | Go | `go.mod`'s `go` line | 1.18 |
  | Rust | `Cargo.toml` `edition` and `rust-version` | edition 2018 |
  | Lua | `.luarc.json` `runtime.version`, a rockspec's `lua` dependency, LÖVE (LuaJIT) | 5.1 and LuaJIT |
  | GDScript | `project.godot` `config/features` | Godot 4.2 |
  | Ruby | `.ruby-version`, the `Gemfile`'s `ruby`, a gemspec's `required_ruby_version` | 3.0 |
  | PHP | `composer.json` `require.php` | 8.0 |

  Without a declaration, generated code is for the newest version, as today. The detected version shows in Compiler Results, and a setting per language overrides it.
- **Generators take a target.** `GenerateOptions.target` is the version. Each generator writes the newest form the target allows and an older one below that, for example:
  - Java 11: classes instead of records, and its own hex digits instead of `HexFormat`.
  - C++17: no `std::erase` or designated initializers.
  - Go 1.18 to 1.20: the runtime's own helpers instead of `slices`.
  - PHP 8.0: class constants instead of enums.
  - C# 8: no target-typed `new()`, records or init accessors.
  - Python 3.8: `typing.List` and `Optional` in runtime positions.
  - ES2020: no class fields or `Object.hasOwn`.
  - Ruby 3.0: no endless methods or `it`.
- **Capabilities by version.** What a version can't do at all leaves the language's capabilities for that project: PHP 8.0 has no Fibers, so its graphs have no async functions (Phase 9). Capabilities are already enforced, so the palette hides those nodes (Phase 10), and the compiler explains why ("PHP 8.0 has no Fibers; the project's composer.json requires ^8.0").
- **Below the floor:** generated code is for the floor, and Compiler Results says the project's version is older than the extension supports, naming the file that declares it.
- **Tests.**
  - The node audit (Phase 10) and the conformance fixtures run at each language's floor as well as its newest version.
  - Where the toolchain can target an older version, the tests use that: `javac --release 11`, `-std=c++17`, `LangVersion 8`, Cargo's edition, `tsc --target ES2020 --lib ES2020`, `mypy --python-version 3.8`, PHPStan's `phpVersion`.
  - Where it can't, they need that version's interpreter installed (Python 3.8, Node.js 18, Lua 5.1 or LuaJIT, PHP 8.0, Ruby 3.0, Go 1.18), and say plainly when it's missing.

### Lua 5.1 and LuaJIT

**Design.**

- **Targets:** Lua 5.1, LuaJIT 2.1 (5.1 with its extensions), 5.2, 5.3 and 5.4, from the detection above. LÖVE projects are LuaJIT.
- **Numbers.** Before 5.3, Lua has one number type, so the runtime can't tell an int from a float. The semantics need it: an int prints as `3`, a float as `3.0`, and integer division truncates.
  - The generator knows every value's type at compile time, so it formats and divides by the pin's type instead of asking the value (`vg.format_int`, `vg.format_float`, `vg.idiv`).
  - Wildcards and `any` values carry their type: the runtime boxes a float stored in an `any` (`vg.float(x)`) only where the graph loses the type.
- **The rest:**
  - `utf8` becomes the runtime's own UTF-8 functions;
  - `table.move` and `table.unpack` get fallbacks (`unpack` in 5.1);
  - `goto` and `//` aren't generated for 5.1;
  - `math.type` and `math.tointeger` are replaced as above;
  - coroutines and `string.format` work as they are.
- **Tests:** the conformance fixtures, the node audit and the Lua interop tests under LuaJIT and Lua 5.1 when installed.
