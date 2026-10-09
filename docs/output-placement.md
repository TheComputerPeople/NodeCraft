# Output placement

Design for where generated code goes and how each language's build picks it up. It implements roadmap decision 4 (generated code is committed next to its graph) while handling languages whose rules don't allow that as-is: Java, C, C++ and Rust. See [language-notes.md](language-notes.md) for the wider notes on those languages.

Status: design. The contract and the TypeScript/Python strategies are built in Phase 1; each other language's strategy arrives with its pack.

## Principles

1. **Detect, don't configure.** Placement comes from the project's real structure: build files, source roots, the module tree, the target list. Settings exist only to override a detection.
2. **Next to the graph whenever the language allows it.** That is the default everywhere. A strategy moves output elsewhere only when the language requires it, and says why in Compiler Results.
3. **Own files, don't edit the user's files.** Registration goes into files the extension owns and regenerates freely (a CMake include, an MSBuild targets file, a Rust module file). A user-owned build file needs at most a one-time hook, such as an `include()` line or a fenced block.
4. **Consent for user-owned files.** The one-time hook is proposed as a diff preview and applied only when accepted, as an undoable edit. After that the extension edits only inside its own fenced block.
5. **Verify, then tell.** After generating, each strategy checks that the build will see the file. If it won't, Compiler Results shows a warning with a quick fix that re-offers the hook and a snippet the user can apply by hand. Declining never blocks generation.
6. **Follow the graph's lifecycle.** Renaming, moving or deleting a graph renames, moves or deletes its output and updates registrations. Every generated file starts with a header naming its source graph, so stale outputs can be found without a separate manifest.

## Per-language strategies

| Language | Generated file | Location | Build registration | Verification |
|---|---|---|---|---|
| TypeScript | `Inventory.vgraph.ts` | Next to the graph | None | The folder is covered by the nearest `tsconfig.json` `include`/`files`; otherwise warn, with a quick fix to add it |
| JavaScript | `Inventory.vgraph.js` (ESM or CommonJS, matching the project) | Next to the graph | None | As TypeScript, with `jsconfig.json` |
| Python | `inventory_vgraph.py` | Next to the graph | None | The folder is importable: inside the project's source root or a package |
| C# | `Inventory.vgraph.cs` | Next to the graph | None for SDK-style projects (they compile every `.cs`). Legacy projects: an extension-owned `vgraph.targets` plus a one-time `<Import>` | The file is inside the project folder |
| Java | `Inventory.java` (must match the class name) | `<source root>/<package path>/`. That is next to the graph when the graph is inside a source root | None: Maven and Gradle compile everything under their source roots | The package declaration matches the folder |
| C++ | `Inventory.vgraph.h` and `Inventory.vgraph.cpp` | Next to the graph | Depends on the build system (below) | The owning target's source list includes the file |
| C | `inventory_vgraph.h` and `inventory_vgraph.c`, plus the pack's runtime support library, vendored once | Next to the graph; the runtime in one project-level folder | As C++ | As C++ |
| Rust | `inventory_vgraph.rs` | Next to the graph when it's inside the crate's source tree; otherwise `src/vgraph/` | A `mod` declaration (below) | rust-analyzer reports no unlinked file, or `cargo check` sees the module |

### File naming

File names follow what each language's import system accepts:

- **`Name.vgraph.<ext>`** where any file name works (TypeScript, JavaScript, C#, C++). It keeps the graph and its output side by side, and VS Code's Explorer file nesting can show the output under its graph.
- **`name_vgraph.<ext>`** where the name must be a valid module identifier (Python, Rust, and C by convention).
- **The class name** where the language requires it (Java).

C and C++ deliberately avoid the `.generated.h` suffix: Unreal's header tool produces `*.generated.h`, so the same suffix would collide in Unreal projects.

### Java

1. **Find the source roots.** In order of preference: ask the Java language server's project model when it's available; otherwise read `pom.xml` (`<sourceDirectory>`, default `src/main/java`); otherwise assume Gradle's default `src/main/java`.
2. **Graph inside a source root:** the package is the graph's folder relative to that root, and the file goes next to the graph. Decision 4 holds unchanged.
3. **Graph outside every source root:** the package comes from the graph's `java.package` setting, or defaults to the graph's folder relative to the workspace. The file goes to `<main source root>/<package path>/`. Compiler Results names the location, so moving the graph into the source tree is an obvious fix.
4. **No registration needed.** Build tools compile everything under their source roots.

### C and C++

The generated pair always goes next to the graph. Only registration differs.

1. **Detect the build system** from the project's files: `CMakeLists.txt`, `*.vcxproj`, `meson.build`, `*.uproject` (Unreal), Bazel `BUILD` files or a plain `Makefile`.
2. **Find the owning target.** With CMake, prefer the File API (the codemodel reply in an existing build folder lists every target and its source folders). Otherwise use the nearest `CMakeLists.txt` and its `add_executable`/`add_library` calls. Ask the user only when several targets are plausible, and remember the answer in the graph's settings.
3. **Register per build system:**
   - **CMake:** the extension owns `vgraph.cmake`, which defines the source list. The one-time hook adds `include(vgraph.cmake)` and a `target_sources` call for the chosen target to `CMakeLists.txt`. If the target already picks up the folder through `file(GLOB …)`, nothing is needed.
   - **MSBuild (`.vcxproj`):** the extension owns `vgraph.targets`, with item globs for its generated files. The one-time hook is an `<Import Project="vgraph.targets" />`.
   - **Meson:** Meson deliberately has no globbing. The extension owns `vgraph/meson.build`, which defines a `files()` list. The one-time hook adds `subdir('vgraph')` and the list to the target's sources.
   - **Unreal:** the build tool compiles every file under a module's `Source` folder, so nothing is needed. Only the naming rule above matters.
   - **Bazel, Make and others:** no automatic edits. Compiler Results lists the files to add.
4. **C's runtime library** is vendored once into a project-level folder and registered the same way as generated files.
5. **Includes:** generated sources include their own header by relative path, so the include paths don't change. Making generated headers visible to other user code is the user's build decision.

### Rust

1. **Find the crate.** `cargo metadata --no-deps --offline` gives each package's targets and their root files (`lib.rs`, `main.rs`). Without Cargo, read `Cargo.toml` directly. In a workspace, the owning crate is the one whose folder contains the graph.
2. **Graph inside the crate's source tree:** the file goes next to the graph, and its parent module (`mod.rs`, `<folder>.rs` or the crate root) needs `pub mod inventory_vgraph;`. The extension keeps those declarations in a fenced block in the parent module:

   ```rust
   // vgraph:begin (managed by Blueprint Visual Scripting)
   pub mod inventory_vgraph;
   // vgraph:end
   ```

   Adding the block is the one-time consented edit; later updates touch only the block.
3. **Graph outside the source tree:** the file goes to `src/vgraph/`. The extension fully owns `src/vgraph/mod.rs`, and the one-time hook is `mod vgraph;` in the crate root.
4. **Verify** with rust-analyzer's unlinked-file diagnostic, or by running `cargo check` when the user builds.

## Architecture

Placement splits into four parts, so the decision logic stays testable and language-neutral:

1. **Project probing (extension host).** It collects facts a strategy asks for: whether files exist and what they contain, the CMake File API reply, `cargo metadata` output, the Java language server's source paths. Each language pack declares which probes it needs.
2. **Planning (language pack, in `src/core`).** A pure function from the graph's location plus the probe results to an **output plan**: which files to write and where, which extension-owned files to regenerate, which one-time hooks to propose, and which diagnostics to report. It has no file system access, so it's unit-testable with fixture projects.
3. **Applying (extension host).** It writes generated and extension-owned files through a workspace edit, so it's undoable. It proposes one-time hooks as a diff preview, remembers the answer per workspace, and never re-asks after a decline unless the quick fix is used.
4. **Verifying (extension host plus pack).** It runs the pack's checks after generation and on build, and reports in Compiler Results.

The same machinery covers edge cases in the first three languages: a TypeScript folder outside `tsconfig.json`'s `include`, a Python folder that isn't importable, a legacy C# project. So it isn't special machinery for four languages.

### Security

Some probes execute project tooling: configuring CMake runs the project's CMake scripts, and Cargo can run build scripts. Those probes run only in trusted workspaces, consistent with the Workspace Trust rules in [architecture.md](architecture.md). In Restricted Mode, strategies fall back to reading files statically. `cargo metadata` runs with `--no-deps --offline`, so probing never downloads anything.

## Roadmap placement

- **Phase 1:** the output-plan contract; probing and applying for the default (next to the graph); naming; lifecycle handling (rename, move, delete); verification for TypeScript and Python.
- **With the C# pack:** consented one-time hooks and extension-owned files (needed for legacy projects).
- **Phase 6:** the Java, C/C++ and Rust strategies above, each with fixture projects for every build system it supports.
