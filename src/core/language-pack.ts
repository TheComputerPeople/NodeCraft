// A language pack is the unit of language support: everything the extension knows about one
// target language lives behind this interface, so the graph model and editor stay language-neutral.
// Debugging members arrive with Phase 5.
import { IrProgram } from './compiler/ir';
import { NodeLine } from './compiler/writer';
import { ModuleScan } from './importing/symbols';
import { OutputPlan, PlacementContext } from './output-plan';
import { TypeRef } from './types';

// Which Blueprint concepts generated code in the language can express (not which keywords the
// language has: JavaScript has no interface keyword but expresses Blueprint interfaces). The
// compiler reports and the editor hides what a graph's language can't (src/core/capabilities.ts).
export interface LanguageCapabilities {
  staticTyping: boolean;
  // Object references: Construct, Target pins, Self as a value, class-typed pins.
  classes: boolean;
  inheritance: boolean;
  interfaces: boolean;
  generics: boolean;
  // Latent actions such as Delay.
  async: boolean;
  exceptions: boolean;
  // Which containers it has (all three when absent).
  containers?: ('array' | 'set' | 'map')[];
  // Event dispatchers and bound events (true when absent).
  delegates?: boolean;
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
  // C# only: the namespace of the generated class (from the project's root namespace and folders).
  namespace?: string;
}

export interface GeneratedCode {
  text: string;
  // Files generated with it, next to it (a C++ header): names from CodeGenerator.companionFileNames.
  companionFiles?: { fileName: string; text: string }[];
  // The generated class's name, as the runner needs it.
  className: string;
  // Where each node's code starts, for jumping between graph and code and for debugging; and where
  // code that belongs to no node starts (CodeWriter.breaks).
  nodeLines: NodeLine[];
  codeBreaks?: number[];
  // Folders (relative to the workspace folder) the runtime must search for the project modules the
  // code imports, for languages that import by module name (Python's sys.path).
  importRoots?: string[];
  // Project source files (relative to the workspace folder) the code calls into, for languages
  // that compile them together with the generated file to run it (C#).
  importedFiles?: string[];
  // The method the class's Main event became, which Run calls after start with the arguments.
  mainMethod?: string;
  // Expressions that read pins' values in a paused frame of the node's method (docs/debugging.md,
  // "Values"), evaluated through the debugger.
  pinExpressions?: PinExpression[];
  // The class's Test Case events, each a method of the class (docs/debugging.md, "Test Case"), and
  // the test file that runs them with the language's test tool (CodeGenerator.testFileName).
  tests?: { name: string; method: string }[];
  testFile?: string;
}

export interface PinExpression {
  graphId: string;
  nodeId: string;
  pinId: string;
  expression: string;
}

// How to run generated code with the project's own toolchain.
// What the extension knows when it runs generated code.
export interface RunContext {
  // Absolute folders for GeneratedCode.importRoots.
  importRoots?: string[];
  // Absolute paths of the project's own source files that must be compiled with the generated file
  // (languages that build before running, such as C#).
  sources?: string[];
  // Where `scaffold`'s files were written.
  scaffoldDir?: string;
  // From `probe`, e.g. the .NET target framework.
  targetFramework?: string;
  // GeneratedCode.mainMethod, and the program's command-line arguments for it.
  mainMethod?: string;
  args?: string[];
  // Node.js's process.platform where it runs ("win32", "linux", "darwin").
  platform?: string;
}

export interface CodeRunner {
  // Candidate commands (an executable plus leading arguments), tried in order until one starts.
  commands(platform: string): string[][];
  // Arguments that load the generated file and call its start method.
  args(file: { path: string; url: string }, className: string, context?: RunContext): string[];
  // Environment variables for the command.
  env?: Record<string, string>;
  // Arguments that run a class's tests: its test file (when the language writes one), or each test
  // method by name. Run Tests uses them (docs/debugging.md, "Test Case").
  testArgs?(file: { path: string; url: string }, className: string, context: RunContext & { testFile?: string; tests: { name: string; method: string }[] }): string[];
  // Languages that build before running (C++): arguments for the candidate command that build the
  // program, and the program that is then run with `args` (or `testArgs`).
  build?(file: { path: string; url: string }, className: string, context: RunContext): string[];
  executable?(file: { path: string; url: string }, className: string, context: RunContext): string;
  // Asks the tool about itself before running (e.g. its version); the parsed values join the context.
  probe?: { args: string[]; parse(stdout: string): Partial<RunContext> | undefined };
  // Languages that run from a project: the files to write into a scratch folder before running.
  scaffold?(file: { path: string; url: string }, className: string, context: RunContext): Record<string, string>;
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
  // Name of the generated test file, for languages that write one (GeneratedCode.testFile).
  testFileName?(graphFileName: string): string;
  // Names of the files generated along with the main one (GeneratedCode.companionFiles), so they
  // follow the graph when it's renamed or deleted.
  companionFileNames?(graphFileName: string): string[];
  // The module (or namespace) other generated files import a generated file at the workspace's
  // root by, for languages that import by name. The extension works it out from the project's
  // structure; the conformance runner, which writes a program's files side by side, asks this.
  moduleName?(generatedFileName: string, options: GenerateOptions): string | undefined;
  // Registers generated files with the project's build (docs/output-placement.md): files the
  // extension owns, and one-time hooks into the user's build files. Asked after each compile,
  // and after a graph of the language is deleted or renamed.
  placement?(context: PlacementContext): OutputPlan;
  generate(program: IrProgram, options: GenerateOptions): GeneratedCode;
  // For a function library: the name each function (by graph id) is exported as, and the class
  // holding them in languages without free functions (C#). Callers import these names.
  libraryExports(libraryName: string, functions: { id: string; name: string }[]): { names: Map<string, string>; container?: string };
  runner?: CodeRunner;
  // Debugging the generated code with the language's VS Code debugger (docs/debugging.md).
  debugger?: CodeDebugger;
}

export interface CodeDebugger {
  // The debug type, and the extension that provides it when VS Code doesn't.
  type: string;
  extension?: { id: string; name: string };
  // Arguments for the runner's command that build the code before launching it (C# builds Run's
  // project), after the runner's probe and scaffold.
  build?(file: { path: string; url: string }, className: string, context: RunContext): string[];
  // A launch configuration running the generated file as Run does: Start, then Main. `command`
  // replaces the runner's executable (and leading arguments), as the runCommands setting does.
  configuration(file: { path: string; url: string }, className: string, context: RunContext & { cwd: string; command?: string[] }): Record<string, unknown>;
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
  // The API version a pack from another extension was built for (src/core/api.ts).
  apiVersion?: number;
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
  private readonly listeners = new Set<() => void>();

  constructor(packs: LanguagePack[] = []) {
    packs.forEach((p) => this.register(p));
  }

  // Registration order is detection priority: register more specific languages first
  // (TypeScript before JavaScript, since TypeScript projects also have a package.json).
  register(pack: LanguagePack): void {
    this.packs.set(pack.id, pack);
    this.listeners.forEach((listener) => listener());
  }

  unregister(id: string): void {
    if (this.packs.delete(id)) this.listeners.forEach((listener) => listener());
  }

  // Packs registered or removed (another extension's, through the API).
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
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
