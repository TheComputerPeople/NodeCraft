// Function libraries across files (docs/program-structure.md, "Functions"): the functions of a
// `functionLibrary` graph file become nodes that graphs in the library's languages can call. They
// are called like project functions (src/core/importing/symbols.ts): generated code imports them
// from the library's generated file in its own language, under the names its language pack exports
// them as. A library generated for several languages has a file for each (docs/node-authoring.md,
// gap 1), so its nodes' types name the library and function, not a language.
import { functionNodeType } from './importing/symbols';
import { MACRO_INSTANCE, MacroLookup, expandMacros, macroInstanceDefinition, macroLookup } from './macros';
import { FunctionVariant, GraphDocument, NodeDefinition, PinDefinition } from './model';
import { signatureMetadata } from './metadata';

// Where one language generates a library.
export interface LibraryOutput {
  // The generated file, relative to the workspace folder with "/" separators.
  generatedPath: string;
  // The exported name of each function (by graph id), and the class holding them (C#).
  exports: { names: Map<string, string>; container?: string };
  // Python: the generated module's import name. C#: the static class's namespace.
  module?: string;
}

export interface LibraryLocation extends LibraryOutput {
  // The library's .vgraph file, relative to the workspace folder with "/" separators.
  documentPath: string;
  // Its other languages' generated files.
  others?: Record<string, LibraryOutput>;
}

// A library function's node type.
export function libraryNodeType(documentPath: string, graphId: string): string {
  return `lib:${documentPath}#${graphId}`;
}

export function libraryDefinitions(doc: GraphDocument, location: LibraryLocation): NodeDefinition[] {
  const language = doc.language;
  if (doc.kind !== 'functionLibrary' || !language) return [];
  // A function's name and module in one language's generated file. C# calls
  // Namespace.Class.Method; Python imports the function from the module.
  const variant = (output: LibraryOutput, graphId: string): FunctionVariant | undefined => {
    const name = output.exports.names.get(graphId);
    if (!name) return undefined;
    const container = output.exports.container;
    const module = container ? (output.module ? `${output.module}.${container}` : container) : output.module;
    return { path: output.generatedPath, name, ...(module ? { module } : {}) };
  };
  return doc.graphs.filter((g) => g.kind === 'function').flatMap((graph) => {
    const own = variant(location, graph.id);
    if (!own) return [];
    const variants = Object.fromEntries(Object.entries(location.others ?? {}).flatMap(([other, output]) => {
      const found = variant(output, graph.id);
      return found ? [[other, found]] : [];
    }));
    const signature = graph.signature ?? { inputs: [], outputs: [] };
    const exec = (direction: PinDefinition['direction']): PinDefinition[] => signature.pure ? [] : [{ id: direction === 'input' ? 'execIn' : 'execOut', name: '', kind: 'exec', direction }];
    const data = (direction: PinDefinition['direction']) => (pin: (typeof signature.inputs)[number]): PinDefinition => ({
      id: pin.id, name: pin.name, kind: 'data', direction, ...(pin.type ? { type: pin.type } : {}), ...(pin.defaultValue !== undefined ? { defaultValue: pin.defaultValue } : {}),
      ...(pin.advanced && direction === 'input' ? { advanced: true } : {})
    });
    return [{
      type: libraryNodeType(location.documentPath, graph.id),
      version: 1,
      displayName: graph.name,
      category: signature.category || doc.name,
      ...(signature.description ? { description: signature.description } : {}),
      ...signatureMetadata(signature),
      inputs: [...exec('input'), ...signature.inputs.filter((p) => p.kind === 'data').map(data('input'))],
      outputs: [...exec('output'), ...signature.outputs.filter((p) => p.kind === 'data').map(data('output'))],
      implementation: {
        kind: 'function', language, ...own,
        source: { document: location.documentPath, graph: graph.id },
        ...(Object.keys(variants).length ? { variants } : {})
      },
      // Before libraries had several languages, their nodes were the generated file's functions.
      aliases: [functionNodeType(language, own.path, own.module && location.exports.container ? `${own.module}.${own.name}` : own.name)]
    }];
  });
}

// The macros of a `macroLibrary` graph file, as nodes for graphs in the library's language (or any
// language, for a library without one). Each embeds its macro's graph, with the library's other
// macros already expanded in it, so using it needs nothing else (src/core/macros.ts).
export function macroLibraryDefinitions(doc: GraphDocument, documentPath: string): NodeDefinition[] {
  if (doc.kind !== 'macroLibrary') return [];
  const ownMacros = macroLookup(doc.graphs, () => undefined);
  // Macros of other libraries are left for the graph that uses this one to expand.
  const lookup: MacroLookup = (node) => (node.type === MACRO_INSTANCE ? ownMacros(node) : undefined);
  return doc.graphs.filter((g) => g.kind === 'macro').map((graph) => {
    const expansion = expandMacros(graph, lookup, [`#${graph.id}`]);
    const [problem] = expansion.problems;
    const base = macroInstanceDefinition(MACRO_BASE, graph);
    return {
      ...base,
      type: macroNodeType(documentPath, graph.id),
      category: graph.signature?.category || doc.name,
      implementation: {
        kind: 'macro', graph: expansion.graph, source: { document: documentPath, graph: graph.id },
        ...(doc.language ? { language: doc.language } : {}),
        ...(problem ? { error: `In macro "${graph.name}": ${problem.message}` } : {})
      }
    };
  });
}

export function macroNodeType(documentPath: string, graphId: string): string {
  return `macro:${documentPath}#${graphId}`;
}

const MACRO_BASE: NodeDefinition = {
  type: '', version: 1, displayName: '', category: 'Macros', color: '#6b7280',
  inputs: [], outputs: [], implementation: { kind: 'native', operation: 'macro-instance' }
};
