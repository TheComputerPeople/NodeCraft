// Simulate under the debugger (docs/debugging.md, "Debugging in Simulate"). The interpreter is
// synchronous, so it runs in this worker thread, which can block while paused: it waits on a
// shared counter that the extension host bumps after posting a command to the command port.
import * as fs from 'fs';
import * as path from 'path';
import { MessagePort, parentPort, receiveMessageOnPort, workerData } from 'worker_threads';
import { DebugCommand, SimulateBreakpoint, SimulateDebugger } from '../core/debugger';
import type { DebugStop } from '../core/runtime';
import { builtinLanguagePacks } from '../core/languages';
import { GraphDocument, NodeDefinition } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { GraphRuntime } from '../core/runtime';
import { parseDocument } from '../core/serializer';
import { SimulateCommand, WorkerMessage } from './simulate-protocol';

export interface SimulateWorkerData {
  definitions: NodeDefinition[];
  document: GraphDocument;
  // The workspace folder, for the graph files the run reads (libraries, other classes).
  root?: string;
  // Open graph files' unsaved text, by workspace-relative path; they win over the files on disk.
  openDocuments: Record<string, string>;
  args: string[];
  breakpoints: SimulateBreakpoint[];
  // An Int32Array's buffer: the host adds 1 to element 0 after each command it posts.
  signal: SharedArrayBuffer;
  commands: MessagePort;
}

const data = workerData as SimulateWorkerData;
const signal = new Int32Array(data.signal);
const post = (message: WorkerMessage): void => parentPort!.postMessage(message);

function loadDocument(documentPath: string): GraphDocument | undefined {
  try {
    const text = data.openDocuments[documentPath] ?? (data.root ? fs.readFileSync(path.join(data.root, ...documentPath.split('/')), 'utf8') : undefined);
    return text === undefined ? undefined : parseDocument(text, path.basename(documentPath, '.vgraph')).document;
  } catch {
    return undefined;
  }
}

// Applies a command that doesn't resume (breakpoint changes, value reads while paused at `stop`),
// or returns one that does.
function handle(command: SimulateCommand, stop?: DebugStop): DebugCommand | undefined {
  switch (command.kind) {
    case 'breakpoints':
      debug.setBreakpoints(command.breakpoints);
      return undefined;
    case 'read':
      post({ kind: 'values', id: command.id, values: command.reads.map((r) => stop ? stop.read(r.frame, r.nodeId, r.pinId) : { unavailable: 'Values are read while paused.' }) });
      return undefined;
    case 'resume':
      return command.command;
  }
}

// While paused: blocks until a resuming command arrives.
function waitForCommand(stop: DebugStop): DebugCommand {
  for (;;) {
    const seen = Atomics.load(signal, 0);
    const message = receiveMessageOnPort(data.commands);
    if (message) {
      const command = handle(message.message as SimulateCommand, stop);
      if (command) return command;
      continue;
    }
    Atomics.wait(signal, 0, seen);
  }
}

const debug = new SimulateDebugger(data.breakpoints, (stop, reason) => {
  post({ kind: 'paused', stack: stop.stack, reason });
  const command = waitForCommand(stop);
  post({ kind: 'resumed' });
  return command;
}, () => {
  // While running: takes breakpoint changes without waiting.
  for (let message = receiveMessageOnPort(data.commands); message; message = receiveMessageOnPort(data.commands)) handle(message.message as SimulateCommand);
});

const registry = new NodeRegistry();
registry.registerMany(data.definitions);
const runtime = new GraphRuntime(registry, (event) => post({ kind: 'event', event }), builtinLanguagePacks(), loadDocument);
runtime.debug = debug;
try {
  runtime.run(data.document, data.args);
} catch (error) {
  post({ kind: 'event', event: { kind: 'error', message: error instanceof Error ? error.message : String(error) } });
}
post({ kind: 'done' });
