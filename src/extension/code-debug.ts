// Debugging generated code with the language's own debugger (docs/debugging.md, "Debugging
// generated code"). Graph breakpoints become breakpoints in the generated file, the debugger's
// stops are shown as graph nodes, stepping goes node by node, and pins are read with `evaluate`.
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { unsubstituted } from '../core/debug-configuration';
import { breakpointLines, nodeAtLine } from '../core/debug-lines';
import { definitionFor } from '../core/editing';
import { LanguagePackRegistry, debuggerOn } from '../core/language-pack';
import { visibleNodeId } from '../core/macros';
import { CompileReport, DebugAction, DebugValue, GraphDocument, PinRef } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { createResolver } from '../core/resolve';
import { parseDocument } from '../core/serializer';
import { DebugMarks } from './breakpoints';
import { CompileService, GeneratedFile } from './compile-service';
import { GraphDebug, GraphStackFrame, NOT_RUNNING } from './graph-debug';
import { BuildError, ToolNotFoundError, prepareDebugging } from './runner';

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
  // The configurations launched, by GRAPH_KEY, as written: VS Code substitutes ${...} in them, and
  // their values are put back (docs/audit.md, third pass).
  private readonly configurations = new Map<string, vscode.DebugConfiguration>();

  constructor(
    readonly host: DebugHost,
    readonly compiler: CompileService,
    private readonly marks: DebugMarks,
    private readonly registry: NodeRegistry,
    private readonly languages: LanguagePackRegistry,
    private readonly output: () => vscode.OutputChannel
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
      vscode.window.tabGroups.onDidChangeTabs((event) => this.closeGeneratedTabs([...event.opened, ...event.changed])),
      vscode.debug.registerDebugConfigurationProvider('*', {
        resolveDebugConfigurationWithSubstitutedVariables: (_folder, configuration) => {
          const written = this.configurations.get(configuration[GRAPH_KEY]);
          this.configurations.delete(configuration[GRAPH_KEY]);
          return written ? unsubstituted(configuration, written) as vscode.DebugConfiguration : configuration;
        }
      })
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
    const { type, extension } = debuggerOn(spec, process.platform);
    if (extension && !vscode.extensions.getExtension(extension.id)) {
      const show = await vscode.window.showErrorMessage(`Debugging ${language} graphs needs the ${extension.name} extension.`, 'Show Extension');
      if (show) await vscode.commands.executeCommand('workbench.extensions.search', extension.id);
      return;
    }
    // The compile above mirrors the breakpoints; they must be in place before the code starts.
    await this.mirror(uri);
    const generated = this.compiler.generatedFile(uri);
    const silent = generated ? await this.breakpointsWithoutCode(generated) : [];
    if (silent.length) {
      const names = [...new Set(silent)].join(', ');
      void vscode.window.showWarningMessage(
        `${silent.length === 1 ? 'A breakpoint' : `${silent.length} breakpoints`} won't stop when debugging the generated code (${names}): compiling left no code for ${silent.length === 1 ? 'its node' : 'their nodes'}, because ${silent.length === 1 ? "it's" : "they're"} on a branch that never runs or nothing reads ${silent.length === 1 ? 'its value' : 'their values'}. Simulate still stops there.`
      );
    }
    const command = vscode.workspace.getConfiguration('blueprintVisualScripting').get<Record<string, string[]>>('runCommands', {})[pack!.id];
    const cwd = path.dirname(outcome.outputPath);
    const options = {
      cwd, command, importRoots: outcome.importRoots, sources: outcome.sources, crate: outcome.crate, goModule: outcome.goModule, projectDir: outcome.projectDir, mainMethod: outcome.mainMethod,
      args: vscode.workspace.getConfiguration('blueprintVisualScripting', uri).get<string[]>('runArguments', [])
    };
    // C# builds Run's project first.
    const runner = pack!.generator!.runner;
    let context;
    try {
      context = runner
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Preparing ${language} for debugging…` }, () => prepareDebugging(runner, spec, outcome.outputPath!, outcome.className!, options))
        : { importRoots: options.importRoots, sources: options.sources, crate: options.crate, goModule: options.goModule, projectDir: options.projectDir, mainMethod: options.mainMethod, args: options.args };
    } catch (error) {
      const message = error instanceof ToolNotFoundError ? error.message : error instanceof BuildError ? `The ${language} build failed; see the Output panel.` : error instanceof Error ? error.message : String(error);
      if (error instanceof BuildError) {
        this.output().appendLine(error.message);
        this.output().show(true);
      }
      void vscode.window.showErrorMessage(message);
      return;
    }
    const id = `${uri.toString()}#${++this.launches}`;
    let launch: Record<string, unknown>;
    try {
      launch = spec.configuration({ path: outcome.outputPath, url: pathToFileURL(outcome.outputPath).href }, outcome.className, { ...context, cwd, command, platform: process.platform });
    } catch (error) {
      // What the debugger can't be given as it is (GDScript's, through a shell).
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    const configuration: vscode.DebugConfiguration = { name: `Debug ${path.basename(uri.fsPath)}`, ...launch, type, request: 'launch', [GRAPH_KEY]: id };
    if (this.active) this.active.act('stop');
    this.configurations.set(id, structuredClone(configuration));
    const debug = new CodeDebug(id, uri, this, this.openTextTabs(), spec.displayValue, spec.stepsLeaveFunctions === false);
    this.active = debug;
    this.host.debugStarted(debug);
    const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), configuration);
    this.configurations.delete(id);
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
      return { graphId: at.graphId, graphName: graph?.name ?? at.graphId, nodeId, nodeName, uri: generated.graph, ...(at.line > frame.line ? { prologue: true } : {}) };
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

  // The nodes of enabled breakpoints that have no generated line: compiling removed their code (a
  // branch on a constant's other side, a value nothing reads), so they can't stop.
  private async breakpointsWithoutCode(generated: GeneratedFile): Promise<string[]> {
    const doc = await this.graphDocument(generated.graph);
    if (!doc) return [];
    const resolver = createResolver(this.registry, doc);
    const names: string[] = [];
    for (const b of this.marks.breakpoints.get(generated.graph)) {
      const graph = doc.graphs.find((g) => g.id === b.graphId);
      const node = graph?.nodes.find((n) => n.id === b.nodeId);
      if (!b.enabled || !graph || !node) continue;
      const resolve = (id: string) => {
        const other = graph.nodes.find((n) => n.id === id);
        return other && resolver(other);
      };
      if (!breakpointLines(graph, b.nodeId, generated.nodeLines, resolve).length) names.push(definitionFor(node, resolver).displayName);
    }
    return names;
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
  // A step in progress: line steps repeat until execution reaches another node (`entered`: a method,
  // then past its prologue).
  private stepping: { request: string; from?: GraphStackFrame; depth: number; steps: number; entered?: boolean } | undefined;
  // The stopped frames as the debugger gave them, and a source's breakpoints to put back after a step
  // done as a breakpoint (CodeDebugger.stepsLeaveFunctions).
  private frames: DapStackFrame[] = [];
  private restore: { path: string; breakpoints: { line: number; condition?: string }[] } | undefined;

  constructor(readonly id: string, readonly graph: vscode.Uri, private readonly service: CodeDebugService, readonly userTabs: Set<string>, private readonly display?: (text: string) => string, private readonly stepByBreakpoint = false) {}

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
    let stack = await Promise.all(frames.map((f) => this.service.mapFrame(f, this.graph)));
    // Below the outermost graph frame is only the code that started the program (Run's launcher,
    // the runtime's own startup): left out, as Unreal's call stack ends at the event.
    const outermost = stack.map((f) => !f.external).lastIndexOf(true);
    if (outermost >= 0) {
      stack = stack.slice(0, outermost + 1);
      frames = frames.slice(0, outermost + 1);
    }
    if (this.restore) {
      const { path, breakpoints } = this.restore;
      this.restore = undefined;
      await session.customRequest('setBreakpoints', { source: { path }, breakpoints }).then(undefined, () => undefined);
    }
    const step = this.stepping;
    if (step) {
      const top = stack[0];
      const same = !!top && !top.external && !!step.from && top.uri.toString() === step.from.uri.toString() && top.graphId === step.from.graphId && top.nodeId === step.from.nodeId;
      // A step into a method stops at its opening; it goes on, line by line, to the first node's
      // code, where the parameters can be read (the Visual Studio debugger can't before).
      const inPrologue = !!top?.prologue && !top.external;
      const entering = inPrologue && (step.request === 'next' && step.entered ? graphDepth(stack) === step.depth : graphDepth(stack) > step.depth);
      const leaving = !step.entered && same && graphDepth(stack) === step.depth;
      if ((leaving || entering) && step.steps < MAX_LINE_STEPS) {
        step.steps++;
        if (entering) Object.assign(step, { request: 'next', depth: graphDepth(stack), entered: true });
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
    this.frames = frames;
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
    if (action !== 'resume' && this.stepByBreakpoint && this.leavesFunction(action)) {
      void this.resumeToCaller(session, threadId);
      return;
    }
    const request = action === 'resume' ? 'continue' : DAP_STEPS[action];
    const top = stack[0];
    if (action !== 'resume') this.stepping = { request, from: top.external ? undefined : top, depth: graphDepth(stack), steps: 0 };
    this.stack = undefined;
    this.service.host.debugChanged(this);
    session.customRequest(request, { threadId }).then(undefined, () => {
      this.stepping = undefined;
    });
  }

  // Whether the step leaves the function it's in: Step Out, or a step from its last node.
  private leavesFunction(action: DebugAction): boolean {
    const stack = this.stack!;
    if (graphDepth(stack) < 2 || stack[0].external) return false;
    if (action === 'stepOut') return true;
    const generated = this.service.compiler.generatedFile(stack[0].uri);
    return !!generated && !generated.nodeLines.some((n) => n.graphId === stack[0].graphId && n.line > this.frames[0].line);
  }

  // Resumes to the caller's next node, through a breakpoint that is taken away when execution stops:
  // for a debugger whose steps can't leave a function (CodeDebugger.stepsLeaveFunctions).
  private async resumeToCaller(session: vscode.DebugSession, threadId: number): Promise<void> {
    const caller = this.stack!.findIndex((f, i) => i > 0 && !f.external);
    const frame = this.frames[caller];
    const generated = frame && this.service.compiler.generatedFile(this.stack![caller].uri);
    const next = generated?.nodeLines.filter((n) => n.graphId === this.stack![caller].graphId && n.line > frame.line).map((n) => n.line).sort((a, b) => a - b)[0];
    const path = frame?.source?.path;
    this.stack = undefined;
    this.service.host.debugChanged(this);
    if (next !== undefined && path) {
      const same = (file: string) => file.toLowerCase() === path.toLowerCase();
      const breakpoints = vscode.debug.breakpoints
        .filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint && b.enabled && same(b.location.uri.fsPath))
        .map((b) => ({ line: b.location.range.start.line + 1, ...(b.condition ? { condition: b.condition } : {}) }));
      this.restore = { path, breakpoints };
      await session.customRequest('setBreakpoints', { source: { path }, breakpoints: [...breakpoints, { line: next }] }).then(undefined, () => undefined);
    }
    session.customRequest('continue', { threadId }).then(undefined, () => undefined);
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
      let text: string;
      try {
        const response = await session.customRequest('evaluate', { expression, frameId: this.frameIds[frame], context: 'watch' });
        text = String(response?.result ?? '');
      } catch (error) {
        // A debugger that can't evaluate here (Java's, outside a project it knows) still lists the
        // frame's variables: a name, or a field of `this`, is found among them.
        const found = await readVariable(session, this.frameIds[frame], expression);
        if (found === undefined) return { unavailable: error instanceof Error ? error.message : String(error) };
        text = found;
      }
      const value = shortestDecimal(text);
      return { value: this.display ? this.display(value) : value };
    }));
  }

  breakpointsChanged(): void {
    // The service mirrors them into the generated files, which the debugger picks up.
  }
}

// A dotted name's value from the frame's variables (scopes, then their variables, then `this`'s
// fields), or undefined when it isn't one of them.
async function readVariable(session: vscode.DebugSession, frameId: number, expression: string): Promise<string | undefined> {
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(expression)) return undefined;
  type Variable = { name: string; value: string; variablesReference: number };
  const children = async (reference: number): Promise<Variable[]> => {
    try {
      return ((await session.customRequest('variables', { variablesReference: reference }))?.variables ?? []) as Variable[];
    } catch {
      return [];
    }
  };
  let scopes: { variablesReference: number }[] = [];
  try {
    scopes = (await session.customRequest('scopes', { frameId }))?.scopes ?? [];
  } catch {
    return undefined;
  }
  const [first, ...rest] = expression.replace(/^this\./, '').split('.');
  let current: Variable | undefined;
  for (const scope of scopes) {
    const variables = await children(scope.variablesReference);
    current = variables.find((v) => v.name === first);
    if (!current) {
      const self = variables.find((v) => v.name === 'this' || v.name === 'self');
      if (self?.variablesReference) current = (await children(self.variablesReference)).find((v) => v.name === first);
    }
    if (current) break;
  }
  for (const name of rest) {
    if (!current?.variablesReference) return undefined;
    current = (await children(current.variablesReference)).find((v) => v.name === name);
  }
  return current?.value;
}

// A decimal a debugger pads (the Visual Studio debugger shows 30.0 as "30.000000000000000") in its
// shortest form; short ones, such as Python's "30.0", are left as they are.
export function shortestDecimal(text: string): string {
  return /^-?\d+\.\d{6,}$/.test(text) ? String(Number(text)) : text;
}

// How many graph calls deep a stack is (frames outside generated code don't count).
function graphDepth(stack: GraphStackFrame[]): number {
  return stack.filter((f) => !f.external).length;
}
