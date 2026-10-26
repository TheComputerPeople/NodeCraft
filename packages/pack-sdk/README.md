# Blueprint Visual Scripting pack SDK

Write a language pack for [Blueprint Visual Scripting](../../README.md), and check it with the same conformance suite the built-in languages pass.

A language pack turns the Visual IR (the language-neutral program a graph compiles to) into source code, and says how to run that code. The extension does everything else: the editor, lowering graphs to IR, Simulate, placing generated files, and Run, Debug and Run Tests through your pack's runner and debugger descriptions.

## Install

```sh
npm install --save-dev @blueprint-visual-scripting/pack-sdk
```

Build it from this repository with `npm run build:sdk` (the package is `packages/pack-sdk`).

## A pack

A pack is an object with the `LanguagePack` interface:

- **`id`, `displayName`, `generatedFileExtension`, `workspaceMarkers`:** the language and how to recognize a project that uses it.
- **`capabilities`:** which Blueprint concepts it can express (classes, inheritance, interfaces, latent actions, event dispatchers, which containers). The editor hides the rest, and compiling them is an `unsupported` error.
- **`mapType(type)`:** the language's spelling of a canonical type.
- **`generator`:**
  - `outputFileName`;
  - `generate(program, options)`, which returns the text, the generated class's name, and node lines (where each node's code starts, for breakpoints);
  - `libraryExports`;
  - optionally `moduleName`, `testFileName`.
- **`generator.runner`:** the commands that run the generated file (`start`, then `Main`), and its tests.
- **`generator.debugger`:** optional; a VS Code launch configuration for the language's debugger.

`CodeWriter`, `NameScope` and `toIdentifier`, `exprType` and `claimClassMembers` are the helpers the built-in packs use; `formatValue` is the reference for how values print (`docs/semantics.md`).

The SDK's `API_VERSION` is the version of these types; a pack registered with an extension that has a different major version is refused.

## The conformance suite

```sh
npx blueprint-conformance ./out/my-pack.js
```

The module exports the pack (as `pack`, as its default export, or as its only `LanguagePack` export). For each fixture graph, the suite runs it in Simulate, compiles it with your pack, runs it with your pack's runner, and compares what each prints. Programs of several files and Test Case events are checked the same way.

A fixture is:

- **passed** when the output matches;
- **failed** when the output differs, the code doesn't compile, or it crashes;
- **not applicable** when it needs something your pack's capabilities rule out (it compiles with only `unsupported` errors);
- **skipped** when your runner's tool isn't installed.

The command exits with 1 when a fixture fails.

Options:

| Option | What it does |
|---|---|
| `--filter <text>` | Runs only the fixtures whose names contain the text |
| `--fixtures <dir>` | Runs other fixtures, laid out as `graphs/`, `programs/<name>/`, `tests/` and `nodes/` |
| `--concurrency <n>` | How many fixtures run at once (4) |
| `--timeout <ms>` | The limit for each run |
| `--commonjs` | Generates CommonJS (JavaScript packs) |

From code:

```ts
import { runConformance, formatReport } from '@blueprint-visual-scripting/pack-sdk';
const report = await runConformance(myPack);
console.log(formatReport(report));
```
