// A debug Simulate run in a worker thread (docs/debugging.md, "Debugging in Simulate"). Commands
// go through a message port; bumping the shared counter wakes the worker if it is paused.
import * as path from 'path';
import { MessageChannel, Worker } from 'worker_threads';
import { DebugCommand, SimulateBreakpoint } from '../core/debugger';
import { DebugFrame, DebugValue, RuntimeLogEvent } from '../core/model';
import { SimulateCommand, ValueRead, WorkerMessage } from './simulate-protocol';
import type { SimulateWorkerData } from './simulate-worker';

export interface SimulateListener {
  event(event: RuntimeLogEvent): void;
  paused(stack: DebugFrame[], reason: 'breakpoint' | 'step'): void;
  resumed(): void;
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
