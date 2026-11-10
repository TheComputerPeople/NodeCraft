// Laying the Codebase Map out (docs/codebase-map.md, Part 3): ELK's layered algorithm, top to bottom,
// with boxes inside boxes and arrows between any of them, run in a worker thread so a large map never
// blocks the extension host. Free of the vscode API, so tests run it directly.
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { LaidScene, Scene } from '../core/codemap/scene';

export class MapLayout {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, { resolve: (scene: LaidScene) => void; reject: (error: Error) => void }>();
  private nextId = 1;

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, 'map-layout-worker.js'));
    worker.on('message', (response: { id: number; scene?: LaidScene; error?: string }) => {
      const waiting = this.pending.get(response.id);
      if (!waiting) return;
      this.pending.delete(response.id);
      if (response.scene) waiting.resolve(response.scene);
      else waiting.reject(new Error(response.error ?? 'The layout failed.'));
    });
    // A crashed worker fails what it was asked; the next layout starts a new one.
    const fail = (error: Error): void => {
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
      if (this.worker === worker) this.worker = undefined;
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`The layout worker stopped (exit code ${code}).`)));
    this.worker = worker;
    return worker;
  }

  layout(scene: Scene): Promise<LaidScene> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, scene });
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }
}
