// Parsing in a worker thread (docs/codebase-map.md, step 2), so a large codebase never blocks the
// extension host. Free of the vscode API, like simulate-session.ts, so tests run it directly.
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { GrammarId, grammarForFile } from '../core/parsing/grammars';
import type { ParseSummary } from './code-parser';
import type { ParseWorkerData } from './parse-worker';

export interface ParseRequest {
  id: number;
  grammar: GrammarId;
  text: string;
}

export type ParseResponse = { id: number; summary: ParseSummary; error?: undefined } | { id: number; error: string; summary?: undefined };

export class ParseService {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (summary: ParseSummary) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private failure: Error | undefined;

  // `grammarDir`: the extension's grammars/ folder.
  constructor(grammarDir: string) {
    const data: ParseWorkerData = { grammarDir };
    this.worker = new Worker(path.join(__dirname, 'parse-worker.js'), { workerData: data });
    this.worker.on('message', (response: ParseResponse) => {
      const waiting = this.pending.get(response.id);
      if (!waiting) return;
      this.pending.delete(response.id);
      if (response.summary) waiting.resolve(response.summary);
      else waiting.reject(new Error(response.error));
    });
    // A crashed worker fails what it was asked and everything asked later.
    const fail = (error: Error): void => {
      this.failure ??= error;
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => fail(new Error(`The parsing worker stopped (exit code ${code}).`)));
  }

  // Parses `text` with a grammar.
  summarize(grammar: GrammarId, text: string): Promise<ParseSummary> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: ParseRequest = { id, grammar, text };
      this.worker.postMessage(request);
    });
  }

  // Parses a file's text with the grammar its name calls for; undefined when none parses it.
  summarizeFile(fileName: string, text: string): Promise<ParseSummary> | undefined {
    const grammar = grammarForFile(fileName);
    return grammar ? this.summarize(grammar, text) : undefined;
  }

  async dispose(): Promise<void> {
    this.failure ??= new Error('The parsing worker was stopped.');
    await this.worker.terminate();
  }
}
