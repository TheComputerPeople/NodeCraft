// Debugging generated code with the language's own debugger (docs/debugging.md, "Debugging
// generated code"). Graph breakpoints become breakpoints in the generated file, the debugger's
// stops are shown as graph nodes, stepping goes node by node, and pins are read with `evaluate`.
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { breakpointLines, nodeAtLine } from '../core/debug-lines';
import { definitionFor } from '../core/editing';
import { LanguagePackRegistry } from '../core/language-pack';
import { visibleNodeId } from '../core/macros';
import { CompileReport, DebugAction, DebugValue, GraphDocument, PinRef } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { createResolver } from '../core/resolve';
import { parseDocument } from '../core/serializer';
import { DebugMarks } from './breakpoints';
import { CompileService, GeneratedFile } from './compile-service';
import { GraphDebug, GraphStackFrame, NOT_RUNNING } from './graph-debug';

// Marks a launch configuration as a graph's debugging session.
const GRAPH_KEY = '__blueprintGraph';
// Stepping by node gives up after this many line steps on one node (a long loop on one line).
const MAX_LINE_STEPS = 500;
const DAP_STEPS = { stepOver: 'next', stepInto: 'stepIn', stepOut: 'stepOut' } as const;

// The graph editors, which show the session.
export interface DebugHost {
  debugStarted(debug: GraphDebug): void;
  debugChanged(debug: GraphDebug): void;
  debugEnded(debug: GraphDebug): void;
  notifyCompiled(uri: vscode.Uri, report: CompileReport): void;
}

interface DapStackFrame {
  id: number;
  name: string;
  line: number;
  source?: { path?: string; name?: string };
  presentationHint?: string;
}

export class CodeDebugService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  // The breakpoints set in generated files for graph breakpoints, by graph file, and their ids.
  private readonly mirrored = new Map<string, vscode.SourceBreakpoint[]>();
  private readonly mirroredIds = new Set<string>();
  // Mirroring runs one graph at a time, so concurrent updates don't duplicate breakpoints.
  private mirroring: Promise<void> = Promise.resolve();
  private active: CodeDebug | undefined;
  private launches = 0;

  constructor(
    readonly host: DebugHost,
    readonly compiler: CompileService,
    private readonly marks: DebugMarks,
    private readonly registry: NodeRegistry,
    private readonly languages: LanguagePackRegistry
  ) {
    this.disposables.push(
      compiler.onDidGenerate((generated) => this.mirror(generated.graph)),
      marks.breakpoints.onDidChange((uri) => this.mirror(uri)),
      vscode.debug.onDidChangeBreakpoints((event) => void this.removedElsewhere(event.removed)),
      vscode.debug.registerDebugAdapterTrackerFactory('*', { createDebugAdapterTracker: (session) => this.tracker(session) }),
      vscode.debug.onDidStartDebugSession((session) => {
        if (this.active && session.configuration[GRAPH_KEY] === this.active.id) this.active.root = session;
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (this.active && session.configuration[GRAPH_KEY] === this.active.id) this.end(this.active);
      }),
      vscode.window.tabGroups.onDidChangeTabs((event) => this.closeGeneratedTabs([...event.opened, ...event.changed]))
    );
  }

  // Debug (toolbar, F5 in the graph editor): compiles, then runs the generated code under the
  // language's debugger, as Run runs it.
  async start(uri: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('Debugging graphs is disabled in Restricted Mode. Trust this workspace to debug graphs.');
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const outcome = await this.compiler.compile(document);
    this.host.notifyCompiled(uri, outcome.report);
    if (!outcome.outputPath || !outcome.className) {
      void vscode.window.showErrorMessage('Fix the compile errors before debugging.');
      return;
    }
    const pack = this.languages.get(outcome.report.language);
    const spec = pack?.generator?.debugger;
    const language = pack?.displayName ?? outcome.report.language;
    if (!spec) {
      void vscode.window.showErrorMessage(`${language} graphs can't be debugged yet.`);
      return;
    }
    if (spec.extension && !vscode.extensions.getExtension(spec.extension.id)) {
      const show = await vscode.window.showErrorMessage(`Debugging ${language} graphs needs the ${spec.extension.name} extension.`, 'Show Extension');
      if (show) await vscode.commands.executeCommand('workbench.extensions.search', spec.extension.id);
      return;
    }
    // The compile above mirrors the breakpoints; they must be in place before the code starts.
    await this.mirror(uri);
    const command = vscode.workspace.getConfiguration('blueprintVisualScripting').get<Record<string, string[]>>('runCommands', {})[pack!.id];
    const id = `${uri.toString()}#${++this.launches}`;
    const configuration: vscode.DebugConfiguration = {
      name: `Debug ${path.basename(uri.fsPath)}`,
      ...spec.configuration({ path: outcome.outputPath, url: pathToFileURL(outcome.outputPath).href }, outcome.className, {
        cwd: path.dirname(outcome.outputPath),
        importRoots: outcome.importRoots,
        sources: outcome.sources,
        mainMethod: outcome.mainMethod,
        args: vscode.workspace.getConfiguration('blueprintVisualScripting', uri).get<string[]>('runArguments', []),
        command
      }),
      type: spec.type,
      request: 'launch',
      [GRAPH_KEY]: id
    };
    if (this.active) this.active.act('stop');
    const debug = new CodeDebug(id, uri, this, this.openTextTabs());
    this.active = debug;
    this.host.debugStarted(debug);
    const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), configuration);
    if (!started) this.end(debug);
  }

  // The session the editors show, if a generated-code session is running.
  get session(): GraphDebug | undefined {
    return this.active;
  }

  end(debug: CodeDebug): void {
    if (this.active === debug) this.active = undefined;
    this.host.debugEnded(debug);
  }

  // A stack frame in graph terms: the node whose code the frame's line is in, or (outside generated
  // code) the frame's own function, file and line.
  async mapFrame(frame: DapStackFrame, fallback: vscode.Uri): Promise<GraphStackFrame> {
    const file = frame.source?.path;
    const generated = file ? this.compiler.generatedFileAt(file) : undefined;
    const at = generated && nodeAtLine(generated.nodeLines, frame.line, generated.codeBreaks);
    if (generated && at) {
      const doc = await this.graphDocument(generated.graph);
      const graph = doc?.graphs.find((g) => g.id === at.graphId);
      const nodeId = visibleNodeId(at.nodeId);
      const node = graph?.nodes.find((n) => n.id === nodeId);
      const nodeName = node && doc ? definitionFor(node, createResolver(this.registry, doc)).displayName : nodeId;
      return { graphId: at.graphId, graphName: graph?.name ?? at.graphId, nodeId, nodeName, uri: generated.graph };
    }
    return {
      graphId: '', graphName: frame.name, nodeId: '', nodeName: file ? `${path.basename(file)}:${frame.line}` : frame.source?.name ?? '',
      uri: file ? vscode.Uri.file(file) : fallback, external: true
    };
  }

  dispose(): void {
    this.active?.act('stop');
    for (const list of this.mirrored.values()) vscode.debug.removeBreakpoints(list);
    this.disposables.forEach((d) => d.dispose());
  }

  private tracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
    const debug = this.active;
    if (!debug?.owns(session)) return undefined;
    return {
      onDidSendMessage: (message: { type?: string; event?: string; body?: { threadId?: number } }) => {
        if (message.type !== 'event') return;
        if (message.event === 'stopped' && message.body?.threadId !== undefined) void debug.stopped(session, message.body.threadId);
        else if (message.event === 'continued') debug.continued();
      }
    };
  }

  // Mirrors a graph's breakpoints into its generated file (docs/debugging.md, "Breakpoints"), on the
  // lines of the latest compile. They show in VS Code's Breakpoints view too.
  private mirror(graph: vscode.Uri): Promise<void> {
    this.mirroring = this.mirroring.then(() => this.mirrorNow(graph)).catch(() => undefined);
    return this.mirroring;
  }

  private async mirrorNow(graph: vscode.Uri): Promise<void> {
    const key = graph.toString();
    const generated = this.compiler.generatedFile(graph);
    const wanted = generated ? await this.mirroredLines(generated) : new Map<number, boolean>();
    const old = this.mirrored.get(key) ?? [];
    old.forEach((b) => this.mirroredIds.delete(b.id));
    const file = generated && vscode.Uri.file(generated.outputPath);
    const fresh = file ? [...wanted].map(([line, enabled]) => new vscode.SourceBreakpoint(new vscode.Location(file, new vscode.Position(line - 1, 0)), enabled)) : [];
    fresh.forEach((b) => this.mirroredIds.add(b.id));
    if (fresh.length) this.mirrored.set(key, fresh);
    else this.mirrored.delete(key);
    if (old.length) vscode.debug.removeBreakpoints(old);
    if (fresh.length) vscode.debug.addBreakpoints(fresh);
  }

  // Each generated line with a breakpoint, enabled when any graph breakpoint there is.
  private async mirroredLines(generated: GeneratedFile, only?: (b: { graphId: string; nodeId: string }) => boolean): Promise<Map<number, boolean>> {
    const lines = new Map<number, boolean>();
    const doc = await this.graphDocument(generated.graph);
    if (!doc) return lines;
    const resolver = createResolver(this.registry, doc);
    for (const b of this.marks.breakpoints.get(generated.graph)) {
      if (only && !only(b)) continue;
      const graph = doc.graphs.find((g) => g.id === b.graphId);
      if (!graph) continue;
      const resolve = (id: string) => {
        const node = graph.nodes.find((n) => n.id === id);
        return node && resolver(node);
      };
      for (const line of breakpointLines(graph, b.nodeId, generated.nodeLines, resolve)) lines.set(line, (lines.get(line) ?? false) || b.enabled);
    }
    return lines;
  }

  // A mirrored breakpoint removed in VS Code (the Breakpoints view, the editor's margin) removes the
  // graph breakpoints it stood for.
  private async removedElsewhere(removed: readonly vscode.Breakpoint[]): Promise<void> {
    const gone = removed.filter((b) => this.mirroredIds.has(b.id));
    if (!gone.length) return;
    for (const [key, list] of this.mirrored) {
      const lines = new Set(list.filter((b) => gone.some((g) => g.id === b.id)).map((b) => b.location.range.start.line + 1));
      if (!lines.size) continue;
      const uri = vscode.Uri.parse(key);
      const generated = this.compiler.generatedFile(uri);
      if (!generated) continue;
      const kept = [];
      for (const b of this.marks.breakpoints.get(uri)) {
        const own = await this.mirroredLines(generated, (other) => other === b);
        if (!own.size || ![...own.keys()].every((line) => lines.has(line))) kept.push(b);
      }
      await this.marks.breakpoints.set(uri, kept);
    }
  }

  private async graphDocument(uri: vscode.Uri): Promise<GraphDocument | undefined> {
    try {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      return parseDocument(text, path.basename(uri.fsPath, '.vgraph')).document;
    } catch {
      return undefined;
    }
  }

  private openTextTabs(): Set<string> {
    return new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs).flatMap((t) => (t.input instanceof vscode.TabInputText ? [path.resolve(t.input.uri.fsPath).toLowerCase()] : [])));
  }

  // When the debugger stops, VS Code shows the generated code there; the graph is shown instead, so
  // the preview tab it opened is closed (a generated file the user had open stays).
  private closeGeneratedTabs(tabs: readonly vscode.Tab[]): void {
    const debug = this.active;
    if (!debug) return;
    for (const tab of tabs) {
      if (!(tab.input instanceof vscode.TabInputText) || !tab.isPreview || tab.isDirty) continue;
      const file = path.resolve(tab.input.uri.fsPath).toLowerCase();
      if (debug.userTabs.has(file) || !this.compiler.generatedFileAt(file)) continue;
      void vscode.window.tabGroups.close(tab, true);
    }
  }
}

// One Debug run of a graph's generated code.
class CodeDebug implements GraphDebug {
  stack: GraphStackFrame[] | undefined;
  // The launched session (the debugger may run the code in a child session of it).
  root: vscode.DebugSession | undefined;
  private session: vscode.DebugSession | undefined;
  private threadId: number | undefined;
  private frameIds: number[] = [];
  // A step in progress: line steps repeat until execution reaches another node.
  private stepping: { request: string; from?: GraphStackFrame; depth: number; steps: number } | undefined;

  constructor(readonly id: string, readonly graph: vscode.Uri, private readonly service: CodeDebugService, readonly userTabs: Set<string>) {}

  owns(session: vscode.DebugSession): boolean {
    for (let s: vscode.DebugSession | undefined = session; s; s = s.parentSession) {
      if (s.configuration[GRAPH_KEY] === this.id) return true;
    }
    return false;
  }

  async stopped(session: vscode.DebugSession, threadId: number): Promise<void> {
    let frames: DapStackFrame[] = [];
    try {
      const response = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 100 });
      frames = (response?.stackFrames ?? []) as DapStackFrame[];
    } catch {
      frames = [];
    }
    // Async stack traces separate their parts with label frames.
    frames = frames.filter((f) => f.presentationHint !== 'label');
    const stack = await Promise.all(frames.map((f) => this.service.mapFrame(f, this.graph)));
    const step = this.stepping;
    if (step) {
      const top = stack[0];
      const same = !!top && !top.external && !!step.from && top.uri.toString() === step.from.uri.toString() && top.graphId === step.from.graphId && top.nodeId === step.from.nodeId;
      if (same && graphDepth(stack) === step.depth && step.steps < MAX_LINE_STEPS) {
        step.steps++;
        try {
          await session.customRequest(step.request, { threadId });
          return;
        } catch {
          // The step failed: show where execution is.
        }
      }
      this.stepping = undefined;
    }
    this.session = session;
    this.threadId = threadId;
    this.stack = stack;
    this.frameIds = frames.map((f) => f.id);
    this.service.host.debugChanged(this);
  }

  continued(): void {
    if (this.stepping || !this.stack) return;
    this.stack = undefined;
    this.service.host.debugChanged(this);
  }

  act(action: DebugAction): void {
    if (action === 'stop') {
      const session = this.root ?? this.session;
      if (session) void vscode.debug.stopDebugging(session);
      else this.service.end(this);
      return;
    }
    const { session, threadId, stack } = this;
    if (!session || threadId === undefined || !stack) return;
    const request = action === 'resume' ? 'continue' : DAP_STEPS[action];
    const top = stack[0];
    if (action !== 'resume') this.stepping = { request, from: top.external ? undefined : top, depth: graphDepth(stack), steps: 0 };
    this.stack = undefined;
    this.service.host.debugChanged(this);
    session.customRequest(request, { threadId }).then(undefined, () => {
      this.stepping = undefined;
    });
  }

  // Each pin is read in the innermost frame running its graph, with the generator's expression.
  async read(file: vscode.Uri, pins: PinRef[]): Promise<DebugValue[]> {
    const { session, stack } = this;
    if (!session || !stack) return pins.map(() => ({ unavailable: 'Values are read while paused.' }));
    const generated = this.service.compiler.generatedFile(file);
    return Promise.all(pins.map(async (pin): Promise<DebugValue> => {
      const frame = stack.findIndex((f) => !f.external && f.graphId === pin.graphId && f.uri.toString() === file.toString());
      if (frame < 0) return NOT_RUNNING;
      const expression = generated?.pinExpressions.find((p) => p.graphId === pin.graphId && p.nodeId === pin.nodeId && p.pinId === pin.pinId)?.expression;
      if (!expression) return { unavailable: "No value: it isn't stored, it's computed where it's used." };
      try {
        const response = await session.customRequest('evaluate', { expression, frameId: this.frameIds[frame], context: 'watch' });
        return { value: String(response?.result ?? '') };
      } catch (error) {
        return { unavailable: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  breakpointsChanged(): void {
    // The service mirrors them into the generated files, which the debugger picks up.
  }
}

// How many graph calls deep a stack is (frames outside generated code don't count).
function graphDepth(stack: GraphStackFrame[]): number {
  return stack.filter((f) => !f.external).length;
}
