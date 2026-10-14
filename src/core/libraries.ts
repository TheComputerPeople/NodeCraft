// Function libraries across files (docs/program-structure.md, "Functions"): the functions of a
// `functionLibrary` graph file become nodes that any graph in the same language can call. They are
// called like project functions (src/core/importing/symbols.ts): generated code imports them from
// the library's generated file, under the names its language pack exports them as.
import { functionNodeType } from './importing/symbols';
import { GraphDocument, NodeDefinition, PinDefinition } from './model';

export interface LibraryLocation {
  // The library's .vgraph file, relative to the workspace folder with "/" separators.
  documentPath: string;
  // Its generated file, likewise.
  generatedPath: string;
  // The exported name of each function (by graph id), and the class holding them (C#).
  exports: { names: Map<string, string>; container?: string };
  // Python: the generated module's import name. C#: the static class's namespace.
  module?: string;
}

export function libraryDefinitions(doc: GraphDocument, location: LibraryLocation): NodeDefinition[] {
  const language = doc.language;
  if (doc.kind !== 'functionLibrary' || !language) return [];
  const container = location.exports.container;
  // C# calls Namespace.Class.Method; Python imports the function from the module.
  const module = container ? (location.module ? `${location.module}.${container}` : container) : location.module;
  return doc.graphs.filter((g) => g.kind === 'function').flatMap((graph) => {
    const name = location.exports.names.get(graph.id);
    if (!name) return [];
    const signature = graph.signature ?? { inputs: [], outputs: [] };
    const exec = (direction: PinDefinition['direction']): PinDefinition[] => signature.pure ? [] : [{ id: direction === 'input' ? 'execIn' : 'execOut', name: '', kind: 'exec', direction }];
    const data = (direction: PinDefinition['direction']) => (pin: (typeof signature.inputs)[number]): PinDefinition => ({
      id: pin.id, name: pin.name, kind: 'data', direction, ...(pin.type ? { type: pin.type } : {}), ...(pin.defaultValue !== undefined ? { defaultValue: pin.defaultValue } : {})
    });
    return [{
      type: functionNodeType(language, location.generatedPath, container ? `${module}.${name}` : name),
      version: 1,
      displayName: graph.name,
      category: signature.category || doc.name,
      ...(signature.description ? { description: signature.description } : {}),
      inputs: [...exec('input'), ...signature.inputs.filter((p) => p.kind === 'data').map(data('input'))],
      outputs: [...exec('output'), ...signature.outputs.filter((p) => p.kind === 'data').map(data('output'))],
      implementation: {
        kind: 'function', language, path: location.generatedPath, name, ...(module ? { module } : {}),
        source: { document: location.documentPath, graph: graph.id }
      }
    }];
  });
}
