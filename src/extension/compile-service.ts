// Compiles graph documents to their target language, writes the generated file next to the graph,
// reports results (Problems panel and the editor's Compiler Results), and runs generated code.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompileDiagnostic } from '../core/compiler';
import { LanguagePackRegistry } from '../core/language-pack';
import { NodeLine } from '../core/compiler/writer';
import { PinExpression } from '../core/language-pack';
import { CompileReport, GraphDocument, RunStatus } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { parseDocument } from '../core/serializer';
import { cppRunSources, csharpRunSources, godotProject, goPackage, goRunSources, javaProject, rustRunSources } from './placement';
import { compileGraphFile, outputPathsFor } from './graph-compile';
import { ProjectVersionCheck } from './projects';
import { OutputPlans } from './output-plans';
import { ToolNotFoundError, runGeneratedCode } from './runner';

// Diagnostics about the graph's project rather than the graph.
const PROJECT_CODES = new Set(['project-version']);

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
  crate?: { src: string; modules: string[]; name?: string };
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
  // Problems of a graph's project, shown once, on the project's file (the version it declares), by
  // project root.
  private readonly projectProblems = vscode.languages.createDiagnosticCollection('blueprintVisualScripting.projects');
  private readonly projectProblemFiles = new Map<string, vscode.Uri>();
  private readonly runs = new Map<string, AbortController>();
  private readonly lastReports = new Map<string, CompileReport>();
  private readonly generated = new Map<string, GeneratedFile>();
  private readonly compiled = new vscode.EventEmitter<GeneratedFile>();
  // Each graph's compile running now, and the one waiting for it (docs/audit.md, second pass).
  private readonly compiling = new Map<string, { running: Promise<CompileOutcome>; waiting?: Promise<CompileOutcome> }>();
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

  // Compiles of a graph take turns, so an older one can't finish last and leave its files: a
  // compile asked for while one runs waits for it, and the requests that come in meanwhile share
  // that one compile, which reads the graph when it starts.
  compile(document: vscode.TextDocument): Promise<CompileOutcome> {
    const key = document.uri.toString();
    const current = this.compiling.get(key);
    if (current?.waiting) return current.waiting;
    const start = (): Promise<CompileOutcome> => {
      const entry: { running: Promise<CompileOutcome>; waiting?: Promise<CompileOutcome> } = { running: this.compileNow(document) };
      this.compiling.set(key, entry);
      const done = (): void => {
        if (this.compiling.get(key) === entry && !entry.waiting) this.compiling.delete(key);
      };
      entry.running.then(done, done);
      return entry.running;
    };
    if (!current) return start();
    const after = (): Promise<CompileOutcome> => start();
    current.waiting = current.running.then(after, after);
    return current.waiting;
  }

  private async compileNow(document: vscode.TextDocument): Promise<CompileOutcome> {
    const report = (diagnostics: CompileDiagnostic[], language: string, outputFile?: string): CompileReport => ({
      status: diagnostics.some((d) => d.severity === 'error') ? 'errors' : diagnostics.length ? 'warnings' : 'ok',
      diagnostics,
      language,
      ...(outputFile ? { outputFile } : {})
    });
    const finish = (outcome: CompileOutcome, graph?: GraphDocument): CompileOutcome => {
      this.lastReports.set(document.uri.toString(), outcome.report);
      // The project's own problems are in Problems on the project's file (reportProject).
      this.problems.set(document.uri, outcome.report.diagnostics.filter((d) => !PROJECT_CODES.has(d.code)).map((d) => this.toProblem(document, d, graph)));
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
    const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? graphDir;
    let compiled: Awaited<ReturnType<typeof compileGraphFile>>;
    try {
      compiled = await this.compileFile(graph, graphPath, root);
    } catch (error) {
      // A bug in the compiler, or a generated file that can't be written: said in Compiler Results
      // and Problems, with the details in the output, rather than lost (docs/audit.md, step 3).
      const message = error instanceof Error ? error.message : String(error);
      this.output().appendLine(`Compiling ${vscode.workspace.asRelativePath(graphPath)} failed: ${error instanceof Error && error.stack ? error.stack : message}`);
      return finish({ report: report([{ severity: 'error', code: 'compile-failed', message: `Compiling stopped: ${message}. The Blueprint Visual Scripting output has the details.` }], graph.language ?? '') }, graph);
    }
    const { result, language, diagnostics } = compiled;
    this.reportProject(compiled.versionCheck);
    if (!result.output || !compiled.outputPath) return finish({ report: report(diagnostics, language) }, graph);
    const outputPath = compiled.outputPath;
    const testPath = compiled.testPath;
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

  private compileFile(graph: GraphDocument, graphPath: string, root: string): ReturnType<typeof compileGraphFile> {
    return compileGraphFile(graph, graphPath, root, {
      registry: this.registry,
      languages: this.languages,
      write: (file, text) => writeIfChanged(vscode.Uri.file(file), text),
      remove: async (file) => {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: false });
        } catch (error) {
          // Another compile of the graph (Compile while compile-on-save runs) removed it first.
          if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) throw error;
        }
      },
      ...(this.outputPlans ? { register: (pack, folder, outputFile) => this.outputPlans!.apply(pack, folder, outputFile) } : {})
    });
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
    return outputPathsFor(this.languages, graphPath);
  }


  forget(uri: vscode.Uri): void {
    this.problems.delete(uri);
    this.lastReports.delete(uri.toString());
    this.generated.delete(uri.toString());
  }

  // The project's version warning, on the file that declares the version; cleared when it's gone.
  private reportProject(check: ProjectVersionCheck | undefined): void {
    if (!check) return;
    const previous = this.projectProblemFiles.get(check.root);
    if (previous) this.projectProblems.delete(previous);
    this.projectProblemFiles.delete(check.root);
    if (!check.file || !check.diagnostics.length) return;
    const uri = vscode.Uri.file(check.file);
    const range = new vscode.Range(check.line ?? 0, 0, check.line ?? 0, Number.MAX_SAFE_INTEGER);
    this.projectProblems.set(uri, check.diagnostics.map((d) => {
      const problem = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Warning);
      problem.code = d.code;
      problem.source = 'Blueprint Visual Scripting';
      return problem;
    }));
    this.projectProblemFiles.set(check.root, uri);
  }

  dispose(): void {
    this.problems.dispose();
    this.projectProblems.dispose();
    this.compiled.dispose();
    this.runs.forEach((c) => c.abort());
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
