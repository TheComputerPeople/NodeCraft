// Compiles graph documents to their target language, writes the generated file next to the graph,
// reports results (Problems panel and the editor's Compiler Results), and runs generated code.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompileDiagnostic, compileDocument } from '../core/compiler';
import { GenerateOptions, LanguagePackRegistry } from '../core/language-pack';
import { NodeLine } from '../core/compiler/writer';
import { PinExpression } from '../core/language-pack';
import { CompileReport, GraphDocument, RunStatus } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { parseDocument } from '../core/serializer';
import { typeLanguages } from '../core/user-types';
import { cppRunSources, csharpNamespace, csharpRunSources, godotProject, goPackage, goRunSources, javaProject, rustRunSources, detectImportExtension, detectModuleFormat, isGeneratedFrom, verifyPlacement } from './placement';
import { OutputPlans } from './output-plans';
import { ToolNotFoundError, runGeneratedCode } from './runner';

export interface CompileOutcome {
  report: CompileReport;
  // Present when compilation succeeded.
  outputPath?: string;
  className?: string;
  // Absolute folders where the runtime finds imported project modules.
  importRoots?: string[];
  // Project source files compiled with the generated file to run it (C#, C++, Rust).
  sources?: string[];
  // Rust: the project crate the code calls into.
  crate?: { src: string; modules: string[] };
  // Go: the project's module.
  goModule?: { path: string; dir: string };
  // GDScript: the graph's Godot project.
  projectDir?: string;
  // The method the class's Main event became.
  mainMethod?: string;
  // The class's tests, and their generated test file (docs/debugging.md, "Test Case").
  tests?: { name: string; method: string }[];
  testPath?: string;
}

// What the debugger needs to know about a graph's generated file (docs/debugging.md).
export interface GeneratedFile {
  graph: vscode.Uri;
  outputPath: string;
  language: string;
  nodeLines: NodeLine[];
  codeBreaks: number[];
  pinExpressions: PinExpression[];
}

export class CompileService implements vscode.Disposable {
  private readonly problems = vscode.languages.createDiagnosticCollection('blueprintVisualScripting');
  private readonly runs = new Map<string, AbortController>();
  private readonly lastReports = new Map<string, CompileReport>();
  private readonly generated = new Map<string, GeneratedFile>();
  private readonly compiled = new vscode.EventEmitter<GeneratedFile>();
  // Fires after a graph compiles, with its generated file.
  readonly onDidGenerate = this.compiled.event;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly languages: LanguagePackRegistry,
    private readonly output: () => vscode.OutputChannel,
    // Resolves when node definitions that load in the background (project functions) are ready.
    private readonly ready: () => Promise<void> = () => Promise.resolve(),
    // Registers generated files with the project's build (docs/output-placement.md).
    private readonly outputPlans?: OutputPlans
  ) {}

  lastReport(uri: vscode.Uri): CompileReport | undefined {
    return this.lastReports.get(uri.toString());
  }

  // The graph's generated file as last compiled, if it compiled in this session.
  generatedFile(graph: vscode.Uri): GeneratedFile | undefined {
    return this.generated.get(graph.toString());
  }

  // The graph a generated file was compiled from.
  generatedFileAt(outputPath: string): GeneratedFile | undefined {
    const wanted = path.resolve(outputPath).toLowerCase();
    return [...this.generated.values()].find((g) => path.resolve(g.outputPath).toLowerCase() === wanted);
  }

  async compile(document: vscode.TextDocument): Promise<CompileOutcome> {
    const report = (diagnostics: CompileDiagnostic[], language: string, outputFile?: string): CompileReport => ({
      status: diagnostics.some((d) => d.severity === 'error') ? 'errors' : diagnostics.length ? 'warnings' : 'ok',
      diagnostics,
      language,
      ...(outputFile ? { outputFile } : {})
    });
    const finish = (outcome: CompileOutcome, graph?: GraphDocument): CompileOutcome => {
      this.lastReports.set(document.uri.toString(), outcome.report);
      this.problems.set(document.uri, outcome.report.diagnostics.map((d) => this.toProblem(document, d, graph)));
      return outcome;
    };

    await this.ready();
    if (document.uri.scheme !== 'file') {
      return finish({ report: report([{ severity: 'error', code: 'unsaved', message: 'Save the graph to a file before compiling it.' }], '') });
    }
    let graph: GraphDocument;
    try {
      graph = parseDocument(document.getText(), path.basename(document.uri.fsPath, '.vgraph')).document;
    } catch (error) {
      return finish({ report: report([{ severity: 'error', code: 'invalid-document', message: `The graph file can't be read: ${error instanceof Error ? error.message : String(error)}` }], '') });
    }

    const graphPath = document.uri.fsPath;
    const graphDir = path.dirname(graphPath);
    const graphFileName = path.basename(graphPath);
    const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? graphDir;
    const result = compileDocument(graph, { registry: this.registry, languages: this.languages, generate: generateOptions(graph.language, graphFileName, graphDir, root) });
    const language = result.output?.language ?? graph.language ?? '';
    if (!result.output) return finish({ report: report(result.diagnostics, language) }, graph);

    const outputPath = path.join(graphDir, result.output.fileName);
    await writeIfChanged(vscode.Uri.file(outputPath), result.output.text);
    const companions = (result.output.companionFiles ?? []).map((c) => ({ path: path.join(graphDir, c.fileName), text: c.text }));
    for (const companion of companions) await writeIfChanged(vscode.Uri.file(companion.path), companion.text);
    const testFileName = result.output.testFile !== undefined ? this.languages.get(language)?.generator?.testFileName?.(graphFileName) : undefined;
    const testPath = testFileName ? path.join(graphDir, testFileName) : undefined;
    if (testPath) await writeIfChanged(vscode.Uri.file(testPath), result.output.testFile!);
    const shared = await this.compileOtherLanguages(graph, graphFileName, graphDir, root);
    await this.removeStaleOutputs(graphDir, graphFileName, [outputPath, ...companions.map((c) => c.path), ...(testPath ? [testPath] : []), ...shared.paths]);
    const pack = this.languages.get(language);
    const registration = pack && this.outputPlans ? await this.outputPlans.apply(pack, root, outputPath) : [];
    const diagnostics = [...result.diagnostics, ...verifyPlacement(language, outputPath, root), ...registration, ...shared.diagnostics];
    // Java finds the project's classes in its source roots (javac's -sourcepath).
    const javaRoots = language === 'java' ? javaProject(graphDir, root).sourceRoots : [];
    const importRoots = javaRoots.length ? javaRoots : result.output.importRoots?.map((r) => path.join(root, r));
    const sources = language === 'csharp' ? csharpRunSources(graphDir, root, outputPath, result.output.importedFiles ?? [])
      : language === 'cpp' ? cppRunSources(outputPath)
      : language === 'rust' ? rustRunSources(outputPath, root, result.output.importedFiles ?? []).generated
      : language === 'java' ? (result.output.importedFiles ?? []).map((f) => path.join(root, f))
      : language === 'go' ? goRunSources(outputPath) : undefined;
    const goModule = language === 'go' ? goPackage(graphDir, root).module : undefined;
    const crate = language === 'rust' ? rustRunSources(outputPath, root, result.output.importedFiles ?? []).crate : undefined;
    const projectDir = language === 'gdscript' ? godotProject(graphDir, root) : undefined;
    const generated: GeneratedFile = { graph: document.uri, outputPath, language, nodeLines: result.output.nodeLines, codeBreaks: result.output.codeBreaks ?? [], pinExpressions: result.output.pinExpressions ?? [] };
    this.generated.set(document.uri.toString(), generated);
    this.compiled.fire(generated);
    return finish({
      report: report(diagnostics, language, vscode.workspace.asRelativePath(outputPath)), outputPath, className: result.output.className, importRoots, sources, ...(crate ? { crate } : {}), ...(goModule ? { goModule } : {}), ...(projectDir ? { projectDir } : {}), mainMethod: result.output.mainMethod,
      ...(result.output.tests?.length ? { tests: result.output.tests, ...(testPath ? { testPath } : {}) } : {})
    }, graph);
  }

  // Compiles, then runs the generated code with the project's toolchain: Start and Main, or with
  // `tests`, the class's Test Case events (Run Tests). A new run of the same graph stops the
  // previous one.
  async run(document: vscode.TextDocument, onStatus: (status: RunStatus) => void, onCompiled?: (report: CompileReport) => void, tests = false): Promise<void> {
    const outcome = await this.compile(document);
    onCompiled?.(outcome.report);
    if (!outcome.outputPath || !outcome.className) {
      onStatus({ state: 'failed', message: `Fix the compile errors before ${tests ? 'running tests' : 'running'}.` });
      return;
    }
    if (tests && !outcome.tests?.length) {
      onStatus({ state: 'failed', message: 'This graph has no Test Case events.' });
      return;
    }
    const pack = this.languages.get(outcome.report.language);
    const runner = pack?.generator?.runner;
    if (!pack || !runner) {
      onStatus({ state: 'failed', message: `${pack?.displayName ?? outcome.report.language} graphs can't be run from the editor yet.` });
      return;
    }

    const key = document.uri.toString();
    this.runs.get(key)?.abort();
    const controller = new AbortController();
    this.runs.set(key, controller);

    const out = this.output();
    out.clear();
    out.show(true);
    out.appendLine(tests ? `Running the tests of ${outcome.report.outputFile} (${pack.displayName})` : `Running ${outcome.report.outputFile} (${pack.displayName})`);
    onStatus({ state: 'running', message: tests ? `Running ${pack.displayName} tests…` : `Running ${pack.displayName}…` });
    const configured = vscode.workspace.getConfiguration('blueprintVisualScripting').get<Record<string, string[]>>('runCommands', {});
    try {
      const result = await runGeneratedCode(runner, outcome.outputPath, outcome.className, {
        cwd: path.dirname(outcome.outputPath),
        importRoots: outcome.importRoots,
        sources: outcome.sources,
        crate: outcome.crate,
        goModule: outcome.goModule,
        projectDir: outcome.projectDir,
        mainMethod: outcome.mainMethod,
        args: vscode.workspace.getConfiguration('blueprintVisualScripting', document.uri).get<string[]>('runArguments', []),
        command: configured[pack.id],
        signal: controller.signal,
        ...(tests ? { tests: { testFile: outcome.testPath, cases: outcome.tests! } } : {}),
        onStdout: (text) => out.append(text),
        onStderr: (text) => out.append(text)
      });
      if (result.aborted) return;
      if (result.exitCode === 0) {
        out.appendLine('[finished]');
        onStatus({ state: 'finished', message: tests ? 'All tests passed' : 'Run complete' });
      } else {
        out.appendLine(`[exited with code ${result.exitCode}]`);
        onStatus({ state: 'failed', message: tests ? 'Some tests failed; see the Output panel.' : `Run failed (exit code ${result.exitCode}); see the Output panel.` });
      }
    } catch (error) {
      const message = error instanceof ToolNotFoundError ? error.message : `Couldn't run the graph: ${error instanceof Error ? error.message : String(error)}`;
      out.appendLine(`[error] ${message}`);
      onStatus({ state: 'failed', message });
    } finally {
      if (this.runs.get(key) === controller) this.runs.delete(key);
    }
  }

  // Output paths every pack would use for a graph file (generated code and test files), e.g. for
  // following renames and deletes.
  outputPathsFor(graphPath: string): string[] {
    const dir = path.dirname(graphPath);
    const name = path.basename(graphPath);
    return this.languages.all().flatMap((p) => (p.generator
      ? [p.generator.outputFileName(name), ...(p.generator.companionFileNames?.(name) ?? []), ...(p.generator.testFileName ? [p.generator.testFileName(name)] : [])].map((f) => path.join(dir, f))
      : []));
  }

  forget(uri: vscode.Uri): void {
    this.problems.delete(uri);
    this.lastReports.delete(uri.toString());
    this.generated.delete(uri.toString());
  }

  dispose(): void {
    this.problems.dispose();
    this.compiled.dispose();
    this.runs.forEach((c) => c.abort());
  }

  // After switching a graph's language, its old generated file would linger; remove it, but only
  // if it really was generated from this graph.
  // A shared struct or enum is generated for its other languages too, next to its own output
  // (docs/multi-language.md, gap 2). Their problems name the language.
  private async compileOtherLanguages(graph: GraphDocument, graphFileName: string, graphDir: string, root: string): Promise<{ paths: string[]; diagnostics: CompileDiagnostic[] }> {
    const paths: string[] = [];
    const diagnostics: CompileDiagnostic[] = [];
    for (const language of typeLanguages(graph).slice(1)) {
      const pack = this.languages.get(language);
      const named = (list: CompileDiagnostic[]) => list.map((d) => ({ ...d, message: `${pack?.displayName ?? language}: ${d.message}` }));
      const result = compileDocument({ ...graph, language }, { registry: this.registry, languages: this.languages, generate: generateOptions(language, graphFileName, graphDir, root) });
      diagnostics.push(...named(result.diagnostics));
      if (!result.output || !pack) continue;
      const outputs = [{ path: path.join(graphDir, result.output.fileName), text: result.output.text }, ...(result.output.companionFiles ?? []).map((c) => ({ path: path.join(graphDir, c.fileName), text: c.text }))];
      for (const output of outputs) await writeIfChanged(vscode.Uri.file(output.path), output.text);
      paths.push(...outputs.map((o) => o.path));
      diagnostics.push(...named([...verifyPlacement(language, outputs[0].path, root), ...(this.outputPlans ? await this.outputPlans.apply(pack, root, outputs[0].path) : [])]));
    }
    return { paths, diagnostics };
  }

  private async removeStaleOutputs(graphDir: string, graphFileName: string, current: string[]): Promise<void> {
    for (const candidate of this.outputPathsFor(path.join(graphDir, graphFileName))) {
      if (!current.includes(candidate) && isGeneratedFrom(candidate, graphFileName)) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(candidate), { useTrash: false });
        } catch (error) {
          // Another compile of the graph (Compile while compile-on-save runs) removed it first.
          if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error;
        }
      }
    }
  }

  // Points a diagnostic at its node's id in the .vgraph text, so Problems can jump to it.
  private toProblem(document: vscode.TextDocument, d: CompileDiagnostic, graph?: GraphDocument): vscode.Diagnostic {
    let range = new vscode.Range(0, 0, 0, 0);
    if (d.nodeId && graph) {
      const text = document.getText();
      const graphStart = d.graphId ? findId(text, d.graphId, 0) : 0;
      const at = findId(text, d.nodeId, Math.max(graphStart, 0));
      if (at >= 0) range = new vscode.Range(document.positionAt(at), document.positionAt(at + d.nodeId.length + 2));
    }
    const problem = new vscode.Diagnostic(range, d.message, d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    problem.source = 'Blueprint';
    problem.code = d.code;
    return problem;
  }
}

// Offset of `"id": "<id>"`'s value (including quotes) at or after `from`, or -1.
function findId(text: string, id: string, from: number): number {
  const pattern = new RegExp(`"id"\\s*:\\s*(${JSON.stringify(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'g');
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? match.index + match[0].length - match[1].length : -1;
}

// Skips the write when the content is unchanged, so file watchers and builds aren't triggered.
async function writeIfChanged(uri: vscode.Uri, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  try {
    const existing = await vscode.workspace.fs.readFile(uri);
    if (existing.length === bytes.length && existing.every((b, i) => b === bytes[i])) return;
  } catch {
    // Not there yet.
  }
  await vscode.workspace.fs.writeFile(uri, bytes);
}

// What a language's generator needs to know about where a graph file is (docs/output-placement.md).
function generateOptions(language: string | undefined, graphFileName: string, graphDir: string, root: string): GenerateOptions {
  return {
    sourceFileName: graphFileName,
    moduleFormat: detectModuleFormat(graphDir, root),
    outputDir: path.relative(root, graphDir).split(path.sep).join('/'),
    importExtension: detectImportExtension(graphDir, root),
    namespace: language === 'java' ? javaProject(graphDir, root).package : language === 'go' ? goPackage(graphDir, root).name : csharpNamespace(graphDir, root),
    ...(language === 'go' && goPackage(graphDir, root).path ? { packagePath: goPackage(graphDir, root).path } : {})
  };
}
