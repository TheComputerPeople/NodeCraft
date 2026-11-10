// Parsing in a worker thread (docs/codebase-map.md, step 2), so a large codebase never blocks the
// extension host. Free of the vscode API, like simulate-session.ts, so tests run it directly.
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileFacts } from '../core/codemap/facts';
import { GrammarId, grammarForFile } from '../core/parsing/grammars';
import type { ParseSummary } from './code-parser';
import type { ParseWorkerData } from './parse-worker';

// summary: the parse's size and syntax errors; facts: what the file declares and imports.
export interface ParseResults {
  summary: ParseSummary;
  facts: FileFacts;
}

export interface ParseRequest {
  id: number;
  want: keyof ParseResults;
  grammar: GrammarId;
  text: string;
}

export type ParseResponse = { id: number; result: ParseResults[keyof ParseResults]; error?: undefined } | { id: number; error: string; result?: undefined };

export class ParseService {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (result: never) => void; reject: (error: Error) => void }>();
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
      if (response.error === undefined) waiting.resolve(response.result as never);
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

  private request<K extends keyof ParseResults>(want: K, grammar: GrammarId, text: string): Promise<ParseResults[K]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<ParseResults[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: never) => void, reject });
      const request: ParseRequest = { id, want, grammar, text };
      this.worker.postMessage(request);
    });
  }

  // Parses `text` with a grammar.
  summarize(grammar: GrammarId, text: string): Promise<ParseSummary> {
    return this.request('summary', grammar, text);
  }

  // Parses a file's text with the grammar its name calls for; undefined when none parses it.
  summarizeFile(fileName: string, text: string): Promise<ParseSummary> | undefined {
    const grammar = grammarForFile(fileName);
    return grammar ? this.summarize(grammar, text) : undefined;
  }

  // What a file declares and imports.
  facts(grammar: GrammarId, text: string): Promise<FileFacts> {
    return this.request('facts', grammar, text);
  }

  async dispose(): Promise<void> {
    this.failure ??= new Error('The parsing worker was stopped.');
    await this.worker.terminate();
  }
}
