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

## Declarative packs

A pack can also be data: a JSON definition of templates for the Visual IR, a type map and capabilities. Use one for a language whose generated code is close to what the IR says (Tier 2), or for an in-house or niche language (Tier 3). The schema is `schema/language-pack.schema.json` in this package, and `examples/minijs.vgraph-language.json` is a complete pack that passes every fixture it can express.

A definition is used in any of these ways:

- **From an extension:** `api.registerDeclarativePack(definition)`.
- **From a workspace:** every `*.vgraph-language.json` file is loaded as a pack and reloaded when it changes. Its problems are shown on the file.
- **From code:** `declarativePack(definition)` returns a `LanguagePack`.
- **To check it:** `npx blueprint-conformance my-language.vgraph-language.json`.

Declarative packs can't yet express object references, inheritance, interfaces, event dispatchers or latent actions. Their capabilities must leave those out, and fixtures that need them are not applicable.

### The definition

| Field | What it holds |
|---|---|
| `id`, `displayName`, `apiVersion` | The language (`id` is a graph's `language`), and the API version (1) |
| `fileName` | The generated file's name, a template over `name`, `snake`, `camel` and `pascal` (the graph file's name): `"{{snake}}_vgraph.c"` |
| `workspaceMarkers` | Globs that suggest a workspace uses the language |
| `capabilities` | `staticTyping`, `generics`, `exceptions` and `containers` |
| `snippetLanguages` | Keys of a code node's `languages` map to take snippets from (the pack's `id` by default) |
| `snippets` | Implementations of library nodes, by node type, for nodes that have none in the language: function bodies over the node's inputs, like a code node's snippet |
| `types.map`, `types.defaults` | Each type's spelling and default value, by key: `int`, `float`, `bool`, `string`, `any`; `array`, `set`, `map` (with `{{T}}`, and `{{K}}`, `{{V}}` for a map); `struct`, `enum` (with `{{name}}`; an enum's default also gets `{{first}}`, its first value) |
| `naming` | `reserved` words, and the case style (`snake`, `camel`, `pascal`, `keep`) of `type`, `function`, `variable`, `parameter` and `enumerator` names |
| `operators` | How `<`, `<=`, `>=`, `==`, `!=`, `&&`, `\|\|`, `+` and `-` are written (as themselves by default) |
| `templates` | The templates below |
| `helpers` | Support code by the identifier it defines. It's included once, at `{{> support}}` in the file template, when generated code (or included support code) uses the identifier |
| `importer` | Tier 2 symbol import: functions marked `@blueprint` in files with these `extensions`, found through the language server's document symbols and read from its hover. `comments` are the doc comment prefixes (`"///"`, `"/**"`, `"*"`), `parameters` how the hover writes one (`"type name"`, `"name: type"` or `"name type"`), `returns` where the return type is (`"before"` the name or `"after"` the parameters), `ignore` words that aren't part of a type, `void` how "returns nothing" is written, and `namespaceSeparator` how a function's namespaces are joined to call it |
| `runner`, `debugger` | How to run and debug generated code (below) |

### Templates

`{{field}}` inserts a value. `{{#each list ", "}}…{{/each}}` repeats, with an optional separator; inside, `{{this}}` is the item and `{{@index}}` its position. `{{#if field}}…{{else}}…{{/if}}` and `{{#unless field}}…{{/unless}}` test whether a value is there. A line holding only `{{> field}}` inserts multi-line text, such as a block of statements, indented to the placeholder's column. A line holding only a section tag leaves no blank line. Every template also sees `className`, `startName`, `library` and `sourceFileName`.

The emitter decides names, which conversions are needed and where each node's code starts; templates only spell the result. A construct whose template is missing is reported as `unsupported` on its node.

| Template | Fields |
|---|---|
| `file` | `fields` (`name`, `type`, `value`); `start`, `functions`, `testFunctions`, `blocks`, `helpers` and `all` (the functions, written with `function`); `signatures` (each function's `name`, `params`, `outputs`, `returnType`); `tests` (`name`, `method`, `quoted`); `mainMethod`, `hasMain`, `hasTests`; `imports`, the files the code imports (`path`, `relative`, `module`, and the `names` it uses); `support` |
| `function` | `name`, `params` and `outputs` (`name`, `type`), `returnType` (one output), `void`, `single`, `multiple`, `body`, `description`, and one of `start`, `function`, `event`, `test`, `block`, `helper` (and `main` for the Main event) |
| `comment` | `text`: the node's name and id, written before its code |
| `print` | `value`, `text` (the value as text), `type` |
| `assert` | `condition`, `message` |
| `assign`, `declare` | `target` or `name`, `value` (`declare` also `type`): a local variable |
| `statement` | `expression`: a call whose result isn't used |
| `if`, `while` | `condition`, `then` and `else`, or `body` |
| `for` | `counter`, `first`, `last` (read before each pass), `stop` (Break's flag, when there is one), `body` |
| `forEach` | `array`, `index`, `element`, `stop`, `body` |
| `return` | `value`, `values`, `count`, `multiple` |
| `callResults`, `callOutput` | A call of something with several outputs: `call`, and each `results` item's `target` and `index`, or one `index` |
| `literal.int`, `literal.float`, `literal.bool` | `value`, `text` (a float that is a whole number has `.0`) |
| `literal.string`, `literal.null` | `value`, `quoted` (a JSON string), `escaped` (without the quotes) |
| `field` | `name`: a variable or stored output of the class (locals are written by name) |
| `add`, `binary`, `binary.<op>`, `binary.<op>.<type>`, `not` | `left`, `right`, `op`; or `value`. Operands that are themselves operations come in parentheses |
| `toText`, `toNumber`, `toBoolean` (each also `.<type>`) | `value`. Text needs no conversion, a float no `toNumber`, a bool no `toBoolean`; an int needs `toNumber.int` only if the pack has it |
| `concat` | `parts` (each already text), `count` |
| `call`, `import`, `callFunction`, `callBlock` | `name`, `args`; `import` also `module` and `path` |
| `makeContainer.array`, `.set`, `.map` | `items`, `pairs` (`key`, `value`), `count`, `T`, `K`, `V` |
| `makeStruct`, `structField`, `enumValue` | `type`, `fields` (`name`, `value`); `value`, `field`; `value`, `text`, `index` |
| `structFile`, `enumFile` | A structure or enumeration document: `name`, and `fields` or `enumerators` (`name`, `text`, `quoted`, `index`) |

Types are keyed `int`, `float`, `bool`, `string`, `any`, `array`, `set`, `map`, `struct` and `enum` wherever a template name ends in `.<type>`. The defaults for templates left out are `{{text}}` for numbers and bools, `{{quoted}}` for strings, `{{left}} + {{right}}`, `{{left}} {{op}} {{right}}`, `!{{value}}`, `{{name}}(…args)` for calls, `{{name}}` for fields and `{{value}}.{{field}}` for struct fields.

### Running and debugging

`runner` has candidate `commands` (a list, or lists by platform with a `default`), `run` and `test` arguments, optional `build` arguments with the `executable` they produce, `scaffold` files written to a scratch folder first, `env` and a `missingToolMessage`. Arguments are templates over `file`, `url`, `dir`, `name`, `scaffold`, `className`, `mainMethod`, `exe` (`.exe` on Windows) and `platform`; an argument that is exactly `{{args}}` expands to the program's arguments, and `{{tests}}` to each test's name and method. `debugger` has a `type`, an `extension` (and other ones by `platforms`), optional `build` arguments, and a launch `configuration` whose strings are templates over the same facts plus `cwd`.
