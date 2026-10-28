// The TypeScript side of the boundary: a project function (docs/code-as-nodes.md) that runs the
// Python pricing service and reads its answer. Marked @blueprint, it is a node in TypeScript graphs.
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * The price of an item, from the Python pricing service (api/pricing.py).
 * @blueprint
 * @category Pricing
 */
export function priceOf(item: string): number {
  const script = path.join(import.meta.dirname, '..', 'api', 'pricing.py');
  const [command, ...args] = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
  const output = execFileSync(command, [...args, script, item], { encoding: 'utf8' });
  return (JSON.parse(output) as { price: number }).price;
}
