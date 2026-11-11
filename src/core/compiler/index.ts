// Compiles a graph document to source code in its target language.
import { GenerateOptions, GeneratedCode, LanguagePackRegistry } from '../language-pack';
import { DEFAULT_LANGUAGE } from '../languages';
import { GraphDocument } from '../model';
import { NodeRegistry } from '../registry';
import { checkCapabilities } from '../capabilities';
import { createResolver } from '../resolve';
import { CompileDiagnostic, hasErrors } from './diagnostics';
import { lowerDocument } from './lower';
import { pruneUnreadSlots } from './prune';

export interface CompileOptions {
  registry: NodeRegistry;
  languages: LanguagePackRegistry;
  generate: GenerateOptions;
  // Leaves out the outputs nothing reads (true by default). The code preview keeps them: it shows
  // one node, whose outputs nothing in the preview reads.
  prune?: boolean;
}

export interface CompiledOutput extends GeneratedCode {
  // Name of the generated file, to be placed next to the graph file.
  fileName: string;
  language: string;
}

export interface CompileResult {
  diagnostics: CompileDiagnostic[];
  // Absent when compilation failed.
  output?: CompiledOutput;
}

export function compileDocument(doc: GraphDocument, options: CompileOptions): CompileResult {
  const language = doc.language || DEFAULT_LANGUAGE;
  const pack = options.languages.get(language);
  if (!pack) return { diagnostics: [{ severity: 'error', code: 'unknown-language', message: `Unknown graph language "${language}".` }] };
  const generator = pack.generator;
  if (!generator) {
    return { diagnostics: [{ severity: 'error', code: 'no-generator', message: `${pack.displayName} graphs can't be compiled yet.` }] };
  }

  // What the language can't express is reported on the nodes that use it, before lowering.
  const unsupported = checkCapabilities(doc, createResolver(options.registry, doc), pack.capabilities, pack.displayName);
  if (hasErrors(unsupported)) return { diagnostics: unsupported };
  const lowered = lowerDocument(doc, {
    registry: options.registry, languageName: pack.displayName, snippetLanguages: generator.snippetLanguages, importLanguages: generator.importLanguages,
    ...(generator.codeParents ? { codeParents: true } : {}),
    languageNames: (id) => options.languages.get(id)?.displayName,
    ...(generator.snippets ? { snippets: generator.snippets } : {})
  });
  if (!lowered.program) return { diagnostics: lowered.diagnostics };
  const { diagnostics: generated = [], ...code } = generator.generate(options.prune === false ? lowered.program : pruneUnreadSlots(lowered.program), options.generate);
  const diagnostics = [...lowered.diagnostics, ...generated];
  if (hasErrors(generated)) return { diagnostics };
  return {
    diagnostics,
    output: { ...code, fileName: generator.outputFileName(options.generate.sourceFileName), language: pack.id }
  };
}

export type { CompileDiagnostic } from './diagnostics';
