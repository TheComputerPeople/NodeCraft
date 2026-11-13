// Test Node Library's Simulate part (docs/node-authoring.md, gap 8) in a worker thread, so an
// example that never ends can be stopped and doesn't hold up the extension host.
import { parentPort, workerData } from 'node:worker_threads';
import { simulateNodeExamples } from '../conformance/conformance';
import { NodeDefinition } from '../core/model';

export interface ExamplesWorkerData {
  nodes: NodeDefinition[];
  language?: string;
}

const { nodes, language } = workerData as ExamplesWorkerData;
parentPort!.postMessage(simulateNodeExamples(nodes, language));
