// The nodes a graph file gives the files around it (docs/program-structure.md): a struct's or enum's
// Make, Break and Switch nodes, a class's Construct and members, an interface's Cast To, and a
// function or macro library's calls. The extension registers them for the workspace's files, and
// the conformance runner for a program's.
import { CodeGenerator } from './language-pack';
import { libraryDefinitions, macroLibraryDefinitions } from './libraries';
import { GraphDocument, NodeDefinition } from './model';
import { classDefinitions, declaredClass, declaredInterface, interfaceDefinitions } from './objects';
import { declaredType, userTypeDefinitions } from './user-types';

export interface GraphFileLocation {
  // The graph file and its generated file, relative to the workspace with "/" separators.
  document: string;
  generatedPath: string;
  // The generated file's module or namespace, for languages that import by name.
  module?: string;
  // A shared struct's, enum's or function library's generated file in each of its other languages.
  others?: Record<string, { generatedPath: string; module?: string }>;
}

// The file's nodes for other graphs, or undefined when it gives none (a plain class graph still
// gives its Construct node). `generatorFor` gives a library's other languages' export names.
export function graphFileDefinitions(doc: GraphDocument, location: GraphFileLocation, generator: CodeGenerator | undefined, generatorFor?: (language: string) => CodeGenerator | undefined): NodeDefinition[] | undefined {
  if (doc.kind === 'macroLibrary') return macroLibraryDefinitions(doc, location.document);
  if (!generator) return undefined;
  const source = { document: location.document, generatedPath: location.generatedPath, ...(location.module ? { module: location.module } : {}) };
  const others = location.others && Object.fromEntries(Object.entries(location.others).map(([language, other]) => [language, { document: location.document, ...other }]));
  const type = declaredType(doc, source, others);
  if (type) return userTypeDefinitions(type);
  const cls = declaredClass(doc, source);
  if (cls) return classDefinitions(cls);
  const iface = declaredInterface(doc, source);
  if (iface) return interfaceDefinitions(iface);
  if (doc.kind !== 'functionLibrary') return undefined;
  const functions = doc.graphs.filter((g) => g.kind === 'function').map((g) => ({ id: g.id, name: g.name }));
  const outputs = Object.fromEntries(Object.entries(location.others ?? {}).flatMap(([language, other]) => {
    const otherGenerator = generatorFor?.(language);
    return otherGenerator ? [[language, { ...other, exports: otherGenerator.libraryExports(doc.name, functions) }]] : [];
  }));
  return libraryDefinitions(doc, {
    documentPath: location.document,
    generatedPath: location.generatedPath,
    exports: generator.libraryExports(doc.name, functions),
    module: location.module,
    ...(Object.keys(outputs).length ? { others: outputs } : {})
  });
}
