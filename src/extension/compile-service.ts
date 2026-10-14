// Compiles graph documents to their target language, writes the generated file next to the graph,
// reports results (Problems panel and the editor's Compiler Results), and runs generated code.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompileDiagnostic, compileDocument } from '../core/compiler';
import { LanguagePackRegistry } from '../core/language-pack';
import { CompileReport, GraphDocument, RunStatus } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { parseDocument } from '../core/serializer';
import { csharpNamespace, csharpRunSources, detectImportExtension, detectModuleFormat, isGeneratedFrom, verifyPlacement } from './placement';
import { ToolNotFoundError, runGeneratedCode } from './runner';

export interface CompileOutcome {
  report: CompileReport;
  // Present when compilation succeeded.
  outputPath?: string;
  className?: string;
  // Absolute folders where the runtime finds imported project modules.
  importRoots?: string[];
  // Project source files compiled with the generated file to run it (C#).
  sources?: string[];
  // The method the class's Main event became.
  mainMethod?: string;
}

export class CompileService implements vscode.Disposable {
  private readonly problems = vscode.languages.createDiagnosticCollection('blueprintVisualScripting');
  private readonly runs = new Map<string, AbortController>();
  private readonly lastReports = new Map<string, CompileReport>();

  constructor(
    private readonly registry: NodeRegistry,
    private readonly languages: LanguagePackRegistry,
    private readonly output: () => vscode.OutputChannel,
    // Resolves when node definitions that load in the background (project functions) are ready.
    private readonly ready: () => Promise<void> = () => Promise.resolve()
  ) {}

  lastReport(uri: vscode.Uri): CompileReport | undefined {
    return this.lastReports.get(uri.toString());
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
    const result = compileDocument(graph, {
      registry: this.registry,
      languages: this.languages,
      generate: {
        sourceFileName: graphFileName,
        moduleFormat: detectModuleFormat(graphDir, root),
        outputDir: path.relative(root, graphDir).split(path.sep).join('/'),
        importExtension: detectImportExtension(graphDir, root),
        namespace: csharpNamespace(graphDir, root)
      }
    });
    const language = result.output?.language ?? graph.language ?? '';
    if (!result.output) return finish({ report: report(result.diagnostics, language) }, graph);

    const outputPath = path.join(graphDir, result.output.fileName);
    await writeIfChanged(vscode.Uri.file(outputPath), result.output.text);
    await this.removeStaleOutputs(graphDir, graphFileName, outputPath);
    const diagnostics = [...result.diagnostics, ...verifyPlacement(language, outputPath, root)];
    const importRoots = result.output.importRoots?.map((r) => path.join(root, r));
    const sources = language === 'csharp' ? csharpRunSources(graphDir, root, outputPath, result.output.importedFiles ?? []) : undefined;
    return finish({ report: report(diagnostics, language, vscode.workspace.asRelativePath(outputPath)), outputPath, className: result.output.className, importRoots, sources, mainMethod: result.output.mainMethod }, graph);
  }

  // Compiles, then runs the generated code with the project's toolchain. A new run of the same
  // graph stops the previous one.
  async run(document: vscode.TextDocument, onStatus: (status: RunStatus) => void, onCompiled?: (report: CompileReport) => void): Promise<void> {
    const outcome = await this.compile(document);
    onCompiled?.(outcome.report);
    if (!outcome.outputPath || !outcome.className) {
      onStatus({ state: 'failed', message: 'Fix the compile errors before running.' });
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
    out.appendLine(`Running ${outcome.report.outputFile} (${pack.displayName})`);
    onStatus({ state: 'running', message: `Running ${pack.displayName}…` });
    const configured = vscode.workspace.getConfiguration('blueprintVisualScripting').get<Record<string, string[]>>('runCommands', {});
    try {
      const result = await runGeneratedCode(runner, outcome.outputPath, outcome.className, {
        cwd: path.dirname(outcome.outputPath),
        importRoots: outcome.importRoots,
        sources: outcome.sources,
        mainMethod: outcome.mainMethod,
        args: vscode.workspace.getConfiguration('blueprintVisualScripting', document.uri).get<string[]>('runArguments', []),
        command: configured[pack.id],
        signal: controller.signal,
        onStdout: (text) => out.append(text),
        onStderr: (text) => out.append(text)
      });
      if (result.aborted) return;
      if (result.exitCode === 0) {
        out.appendLine('[finished]');
        onStatus({ state: 'finished', message: 'Run complete' });
      } else {
        out.appendLine(`[exited with code ${result.exitCode}]`);
        onStatus({ state: 'failed', message: `Run failed (exit code ${result.exitCode}); see the Output panel.` });
      }
    } catch (error) {
      const message = error instanceof ToolNotFoundError ? error.message : `Couldn't run the graph: ${error instanceof Error ? error.message : String(error)}`;
      out.appendLine(`[error] ${message}`);
      onStatus({ state: 'failed', message });
    } finally {
      if (this.runs.get(key) === controller) this.runs.delete(key);
    }
  }

  // Output paths every pack would use for a graph file, e.g. for following renames and deletes.
  outputPathsFor(graphPath: string): string[] {
    const dir = path.dirname(graphPath);
    const name = path.basename(graphPath);
    return this.languages.all().flatMap((p) => (p.generator ? [path.join(dir, p.generator.outputFileName(name))] : []));
  }

  forget(uri: vscode.Uri): void {
    this.problems.delete(uri);
    this.lastReports.delete(uri.toString());
  }

  dispose(): void {
    this.problems.dispose();
    this.runs.forEach((c) => c.abort());
  }

  // After switching a graph's language, its old generated file would linger; remove it, but only
  // if it really was generated from this graph.
  private async removeStaleOutputs(graphDir: string, graphFileName: string, current: string): Promise<void> {
    for (const candidate of this.outputPathsFor(path.join(graphDir, graphFileName))) {
      if (candidate !== current && isGeneratedFrom(candidate, graphFileName)) {
        await vscode.workspace.fs.delete(vscode.Uri.file(candidate), { useTrash: false });
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
