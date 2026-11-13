// A Simulate run in a worker thread (docs/debugging.md, "Debugging in Simulate"): under the
// debugger, or a graph's tests. Commands go through a message port; bumping the shared counter
// wakes the worker if it is paused.
import * as path from 'path';
import { MessageChannel, Worker } from 'worker_threads';
import { ConformanceReport, unfinishedExamplesReport } from '../conformance/conformance';
import { DebugCommand, SimulateBreakpoint } from '../core/debugger';
import { DebugFrame, DebugValue, NodeDefinition, RuntimeLogEvent } from '../core/model';
import type { TestResult } from '../core/runtime';
import { SimulateCommand, ValueRead, WorkerMessage } from './simulate-protocol';
import type { ExamplesWorkerData } from './examples-worker';
import type { SimulateWorkerData } from './simulate-worker';

export interface SimulateListener {
  event(event: RuntimeLogEvent): void;
  paused(stack: DebugFrame[], reason: 'breakpoint' | 'step'): void;
  resumed(): void;
  // A tests run's results (SimulateOptions.tests), before it ends.
  tests?(results: TestResult[]): void;
  // The run finished, failed or was stopped.
  ended(): void;
}

export type SimulateOptions = Omit<SimulateWorkerData, 'signal' | 'commands'>;

export class SimulateSession {
  private readonly worker: Worker;
  private readonly signal = new Int32Array(new SharedArrayBuffer(4));
  private readonly commands = new MessageChannel();
  private finished = false;
  // Value reads waiting for the worker's answer, by request id.
  private readonly reads = new Map<number, (values: DebugValue[]) => void>();
  private nextRead = 0;
  // The call stack while paused.
  stack: DebugFrame[] | undefined;

  constructor(options: SimulateOptions, private readonly listener: SimulateListener) {
    const data: SimulateWorkerData = { ...options, signal: this.signal.buffer as SharedArrayBuffer, commands: this.commands.port2 };
    this.worker = new Worker(path.join(__dirname, 'simulate-worker.js'), { workerData: data, transferList: [this.commands.port2] });
    this.worker.on('message', (message: WorkerMessage) => {
      switch (message.kind) {
        case 'event':
          listener.event(message.event);
          break;
        case 'paused':
          this.stack = message.stack;
          listener.paused(message.stack, message.reason);
          break;
        case 'resumed':
          this.stack = undefined;
          listener.resumed();
          break;
        case 'tests':
          listener.tests?.(message.results);
          break;
        case 'values':
          this.reads.get(message.id)?.(message.values);
          this.reads.delete(message.id);
          break;
        case 'done':
          this.finish();
          break;
      }
    });
    this.worker.on('error', (error) => {
      listener.event({ kind: 'error', message: error.message });
      this.finish();
    });
    this.worker.on('exit', () => this.finish());
  }

  get running(): boolean {
    return !this.finished;
  }

  resume(command: DebugCommand): void {
    if (this.stack) this.send({ kind: 'resume', command });
  }

  // Reads pins' values while paused.
  read(reads: ValueRead[]): Promise<DebugValue[]> {
    if (!this.stack || this.finished) return Promise.resolve(reads.map(() => ({ unavailable: 'Values are read while paused.' })));
    const id = this.nextRead++;
    return new Promise((resolve) => {
      this.reads.set(id, resolve);
      this.send({ kind: 'read', id, reads });
    });
  }

  setBreakpoints(breakpoints: SimulateBreakpoint[]): void {
    this.send({ kind: 'breakpoints', breakpoints });
  }

  stop(): void {
    if (this.finished) return;
    void this.worker.terminate();
    this.listener.event({ kind: 'graph.complete', message: 'Simulate stopped.' });
    this.finish();
  }

  private send(command: SimulateCommand): void {
    if (this.finished) return;
    this.commands.port1.postMessage(command);
    Atomics.add(this.signal, 0, 1);
    Atomics.notify(this.signal, 0);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stack = undefined;
    for (const resolve of this.reads.values()) resolve([]);
    this.reads.clear();
    this.commands.port1.close();
    void this.worker.terminate();
    this.listener.ended();
  }
}

// Test Node Library's examples in Simulate, in a worker: stopped by `signal`, or when they take
// longer than `timeoutMs` (an example that never ends), with each node's examples failed.
export function simulateExamples(nodes: NodeDefinition[], language: string | undefined, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ConformanceReport> {
  const data: ExamplesWorkerData = { nodes, ...(language ? { language } : {}) };
  const worker = new Worker(path.join(__dirname, 'examples-worker.js'), { workerData: data });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (report: ConformanceReport): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      void worker.terminate();
      resolve(report);
    };
    const seconds = Math.max(1, Math.round(options.timeoutMs / 1000));
    const timer = setTimeout(() => settle(unfinishedExamplesReport(nodes, `Simulate didn't finish the examples in ${seconds} second${seconds === 1 ? '' : 's'}: an example may never end.`)), options.timeoutMs);
    const stop = (): void => settle(unfinishedExamplesReport(nodes, 'Stopped before Simulate finished the examples.'));
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener('abort', stop);
    worker.on('message', (report: ConformanceReport) => settle(report));
    worker.on('error', (error) => settle(unfinishedExamplesReport(nodes, `Simulate stopped: ${error.message}`)));
    worker.on('exit', () => settle(unfinishedExamplesReport(nodes, 'Simulate stopped before it finished the examples.')));
  });
}
