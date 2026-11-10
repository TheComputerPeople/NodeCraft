// The parsing worker (docs/codebase-map.md, step 2): parses files with tree-sitter off the extension
// host's thread, one request at a time, and answers with plain data (trees stay here).
import { parentPort, workerData } from 'node:worker_threads';
import { CodeParser } from './code-parser';
import type { ParseRequest, ParseResponse } from './parse-service';

export interface ParseWorkerData {
  grammarDir: string;
}

const { grammarDir } = workerData as ParseWorkerData;
const parser = CodeParser.create(grammarDir);

parentPort?.on('message', (request: ParseRequest) => {
  void (async (): Promise<ParseResponse> => {
    try {
      return { id: request.id, summary: await (await parser).summarize(request.grammar, request.text) };
    } catch (error) {
      return { id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
  })().then((response) => parentPort?.postMessage(response));
});
