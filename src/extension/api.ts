// The public API other extensions use (docs/language-breadth.md): language packs and node libraries
// registered at runtime. Editors, compiling, and the scans of libraries and project functions follow
// the registries' change events.
import * as vscode from 'vscode';
import { API_VERSION, BlueprintVisualScriptingApi, NodeLibrary, packProblem } from '../core/api';
import { LanguagePack, LanguagePackRegistry } from '../core/language-pack';
import { NodeRegistry } from '../core/registry';

export function createApi(languages: LanguagePackRegistry, registry: NodeRegistry, output: () => vscode.OutputChannel): BlueprintVisualScriptingApi {
  const libraries = new Set<string>();
  return {
    apiVersion: API_VERSION,
    registerLanguagePack(pack: LanguagePack) {
      const problem = packProblem(pack, (id) => !!languages.get(id));
      if (problem) {
        output().appendLine(`[error] ${problem}`);
        throw new Error(problem);
      }
      languages.register(pack);
      return new vscode.Disposable(() => {
        if (languages.get(pack.id) === pack) languages.unregister(pack.id);
      });
    },
    registerNodeLibrary(library: NodeLibrary) {
      if (!library?.name || !Array.isArray(library.nodes)) throw new Error('A node library needs a name and a list of nodes.');
      if (libraries.has(library.name)) throw new Error(`A node library named "${library.name}" is already registered.`);
      libraries.add(library.name);
      const source = `api:${library.name}`;
      registry.setSource(source, library.nodes);
      return new vscode.Disposable(() => {
        libraries.delete(library.name);
        registry.setSource(source, []);
      });
    }
  };
}
