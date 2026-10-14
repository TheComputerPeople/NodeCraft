// A language pack is the unit of language support: everything the extension knows about one
// target language lives behind this interface, so the graph model and editor stay language-neutral.
// Debugging members arrive with Phase 5.
import { IrProgram } from './compiler/ir';
import { NodeLine } from './compiler/writer';
import { ModuleScan } from './importing/symbols';
import { TypeRef } from './types';

// What the language can express. The editor hides features a graph's language can't support
// instead of producing code that won't compile.
export interface LanguageCapabilities {
  staticTyping: boolean;
  classes: boolean;
  inheritance: boolean;
  interfaces: boolean;
  generics: boolean;
  async: boolean;
  exceptions: boolean;
}

// Executes code-node snippets inside the extension host, for Simulate mode. Only languages the
// host can run directly provide one; everything else runs through generated code.
export interface CodeSimulator {
  // Keys of a code node's `languages` map this simulator can execute, most preferred first.
  sourceLanguages: string[];
  // Runs a snippet with the node's data inputs and returns the value of its first data output.
  // Throws if the snippet fails.
  run(code: string, inputs: { id: string; value: unknown }[]): unknown;
}

export interface GenerateOptions {
  // The graph file's name, e.g. "Inventory.vgraph", for the generated file's header.
  sourceFileName: string;
  // JavaScript only: the project's module system (from the nearest package.json).
  moduleFormat?: 'esm' | 'commonjs';
  // The generated file's folder, relative to the workspace folder with "/" separators ("" for the
  // folder itself). Imports of project code are relative to it.
  outputDir?: string;
  // TypeScript only: how relative imports of TypeScript modules end (docs/code-as-nodes.md,
  // "Generated imports"). Defaults to "ts".
  importExtension?: 'ts' | 'js' | 'none';
}

export interface GeneratedCode {
  text: string;
  // The generated class's name, as the runner needs it.
  className: string;
  // Where each node's code starts, for jumping between graph and code (and debugging later).
  nodeLines: NodeLine[];
}

// How to run generated code with the project's own toolchain.
export interface CodeRunner {
  // Candidate commands (an executable plus leading arguments), tried in order until one starts.
  commands(platform: string): string[][];
  // Arguments that load the generated file and call its start method.
  args(file: { path: string; url: string }, className: string): string[];
  // Shown when no candidate command could start.
  missingToolMessage: string;
}

export interface CodeGenerator {
  // Keys of a code node's `languages` map usable in generated code, most preferred first.
  snippetLanguages: string[];
  // Languages of project code that generated code can import and call (docs/code-as-nodes.md).
  importLanguages: string[];
  // Name of the generated file for a graph file, following the language's import rules
  // (docs/output-placement.md): "Inventory.vgraph" → "Inventory.vgraph.ts" or "inventory_vgraph.py".
  outputFileName(graphFileName: string): string;
  generate(program: IrProgram, options: GenerateOptions): GeneratedCode;
  runner?: CodeRunner;
}

// Reads the functions in the language's source files, for exposing them as nodes
// (docs/code-as-nodes.md).
export interface SymbolImporter {
  // Extensions of the source files it reads, with the dot.
  extensions: string[];
  scan(source: string): ModuleScan;
}

export interface LanguagePack {
  // The value of a graph's `language` field, e.g. "typescript".
  id: string;
  displayName: string;
  // Extension of generated source files, including the dot.
  generatedFileExtension: string;
  // Workspace-relative glob patterns whose presence suggests a project uses this language.
  workspaceMarkers: string[];
  capabilities: LanguageCapabilities;
  // The language's spelling of a canonical type.
  mapType(type: TypeRef): string;
  simulator?: CodeSimulator;
  generator?: CodeGenerator;
  importer?: SymbolImporter;
}

export class LanguagePackRegistry {
  private readonly packs = new Map<string, LanguagePack>();

  constructor(packs: LanguagePack[] = []) {
    packs.forEach((p) => this.register(p));
  }

  // Registration order is detection priority: register more specific languages first
  // (TypeScript before JavaScript, since TypeScript projects also have a package.json).
  register(pack: LanguagePack): void {
    this.packs.set(pack.id, pack);
  }

  get(id: string): LanguagePack | undefined {
    return this.packs.get(id);
  }

  all(): LanguagePack[] {
    return [...this.packs.values()];
  }

  // The first pack, in priority order, with a marker the workspace contains.
  detect(hasMarker: (glob: string) => boolean): LanguagePack | undefined {
    return this.all().find((pack) => pack.workspaceMarkers.some(hasMarker));
  }
}
