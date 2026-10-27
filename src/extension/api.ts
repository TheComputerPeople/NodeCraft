// The public API other extensions use (docs/language-breadth.md): language packs and node libraries
// registered at runtime. Editors, compiling, and the scans of libraries and project functions follow
// the registries' change events.
import * as vscode from 'vscode';
import { API_VERSION, BlueprintVisualScriptingApi, NodeLibrary, packProblem } from '../core/api';
import { DeclarativePackDefinition, loadDeclarativePack } from '../core/declarative';
import { LanguagePack, LanguagePackRegistry } from '../core/language-pack';
import { NodeLibraries } from './node-libraries';

export function createApi(languages: LanguagePackRegistry, libraries: NodeLibraries, output: () => vscode.OutputChannel): BlueprintVisualScriptingApi {
  const registerLanguagePack = (pack: LanguagePack): vscode.Disposable => {
    const problem = packProblem(pack, (id) => !!languages.get(id));
    if (problem) {
      output().appendLine(`[error] ${problem}`);
      throw new Error(problem);
    }
    languages.register(pack);
    return new vscode.Disposable(() => {
      if (languages.get(pack.id) === pack) languages.unregister(pack.id);
    });
  };
  return {
    apiVersion: API_VERSION,
    registerLanguagePack,
    registerDeclarativePack(definition: DeclarativePackDefinition) {
      const { pack, problems } = loadDeclarativePack(definition);
      if (!pack) {
        const problem = `The ${definition?.displayName ?? definition?.id ?? 'declarative'} pack can't be registered:\n${problems.map((p) => `  - ${p}`).join('\n')}`;
        output().appendLine(`[error] ${problem}`);
        throw new Error(problem);
      }
      return registerLanguagePack(pack);
    },
    registerNodeLibrary(library: NodeLibrary) {
      return libraries.register(library);
    }
  };
}
