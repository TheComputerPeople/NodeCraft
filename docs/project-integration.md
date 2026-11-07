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

- **When it's older**, compiling a graph in that project gives a warning in Compiler Results (once per project): "This project declares Java 11 (pom.xml); generated code needs Java 17." Set Up in This Project lists it under **Can't** (Part 5). Generation goes on: the project may build with a newer toolchain than it declares.
- **Without a declaration**, nothing is said.

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
