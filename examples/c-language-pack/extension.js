// A language pack shipped as its own extension (docs/language-breadth.md, "Exit check"): it uses
// only Blueprint Visual Scripting's public API, registering the declarative definition in
// c.vgraph-language.json. Everything else (the editor, compiling, Run, Debug) is the extension's.
const vscode = require('vscode');
const definition = require('./c.vgraph-language.json');

async function activate(context) {
  const extension = vscode.extensions.getExtension('local.blueprint-visual-scripting');
  if (!extension) return;
  const api = await extension.activate();
  context.subscriptions.push(api.registerDeclarativePack(definition));
}

function deactivate() {}

module.exports = { activate, deactivate };
