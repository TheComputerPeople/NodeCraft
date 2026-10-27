# C for Blueprint Visual Scripting

An example language pack shipped as its own VS Code extension. Graphs whose language is `c` compile to a `name_vgraph.c` file next to the graph. Run builds that file with gcc or clang, and Debug runs it under the C/C++ extension's debugger.

The pack is data: [c.vgraph-language.json](c.vgraph-language.json) is a declarative definition, as described in [the pack SDK](../../packages/pack-sdk/README.md). It holds templates for the Visual IR, the C types, C implementations of the standard library nodes, the support code they use, and how to build, run and debug. [extension.js](extension.js) registers it through the extension's public API, `registerDeclarativePack`, and uses nothing else.

## What it covers

- **Classes:** a graph becomes a struct of its variables, and functions that take a pointer to it.
- **Values:** `long long`, `double`, `bool`, and immutable UTF-8 strings (`const char*`, never freed: generated programs are short-lived). Untyped values are a tagged union, `VgValue`. Numbers print as every other language prints them.
- **Functions** with several outputs return them through pointer parameters.
- **Errors:** an Assert or a runtime error, such as Divide by zero, stops the program with the message, or fails the test that is running (`setjmp`/`longjmp`).
- **Tests:** Run Tests runs each Test Case on a new object.
- **Symbol import:** functions marked `@blueprint` in headers, found through the language server (clangd or the C/C++ extension).

C can't express arrays, sets or maps, objects of other classes, event dispatchers or latent actions here, so graphs using them are refused with a message, and the conformance suite reports those fixtures as not applicable.

## Check it

```sh
npm install
npm test
```

`npm test` runs the published conformance suite (`blueprint-conformance`) with the pack: every fixture it can express prints what Simulate prints.
