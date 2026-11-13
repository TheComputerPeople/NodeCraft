// nodecraft-conformance: runs the conformance suite for a language pack and prints the report.
//
//   nodecraft-conformance <pack> [--filter <text>] [--fixtures <dir>] [--concurrency <n>]
//                                [--timeout <ms>] [--commonjs]
//   nodecraft-conformance <pack> --nodes <file or folder> [--timeout <ms>] [--commonjs]
//   nodecraft-conformance <pack> --audit [--filter <text>] [--timeout <ms>] [--commonjs]
//
// With --nodes, it tests a node library instead: each node's examples run in the pack's language
// (docs/node-authoring.md, gap 8), and nodes without examples only have to compile. With --audit,
// every built-in node the pack's language is offered runs in it and in Simulate, and their outputs
// are compared (docs/language-context.md, part 1).
//
// <pack> is a JavaScript module that exports a LanguagePack (as `pack`, as its default export, or
// as its only export that looks like one), a declarative pack's definition (a .json file), or the
// id of a built-in pack. Exits with 1 when a fixture fails.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { declarativePack } from '../core/declarative';
import { LanguagePack } from '../core/language-pack';
import { builtinLanguagePacks } from '../core/languages';
import { auditPack, formatAudit } from './audit';
import { defaultFixtureSet, formatReport, loadFixtureSet, loadNodeFiles, runConformance, runNodeExamples } from './conformance';

function isPack(value: unknown): value is LanguagePack {
  return !!value && typeof value === 'object' && typeof (value as LanguagePack).id === 'string' && typeof (value as LanguagePack).mapType === 'function';
}

export function loadPack(spec: string): LanguagePack {
  const builtin = builtinLanguagePacks().get(spec);
  if (builtin) return builtin;
  if (spec.endsWith('.json')) return declarativePack(JSON.parse(fs.readFileSync(path.resolve(spec), 'utf8')));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const exported = require(path.resolve(spec)) as Record<string, unknown>;
  const candidates = [exported.pack, exported.default, ...Object.values(exported)].filter(isPack);
  if (!candidates.length) throw new Error(`${spec} doesn't export a language pack.`);
  return candidates[0];
}

export async function main(argv: string[]): Promise<number> {
  const option = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // The first argument that isn't an option or an option's value.
  const valued = ['--filter', '--fixtures', '--concurrency', '--timeout', '--nodes'];
  const spec = argv.find((arg, i) => !arg.startsWith('--') && !valued.includes(argv[i - 1]));
  if (!spec) {
    console.error('Usage: nodecraft-conformance <pack module, definition .json or built-in id> [--filter <text>] [--fixtures <dir>] [--concurrency <n>] [--timeout <ms>] [--commonjs] [--nodes <node file or folder>] [--audit]');
    return 2;
  }
  const pack = loadPack(spec);
  const nodes = option('--nodes');
  if (nodes) {
    const report = await runNodeExamples(pack, loadNodeFiles(path.resolve(nodes)), {
      timeoutMs: option('--timeout') ? Number(option('--timeout')) : undefined,
      generate: argv.includes('--commonjs') ? { moduleFormat: 'commonjs' } : undefined
    });
    console.log(formatReport(report));
    return report.failed ? 1 : 0;
  }
  if (argv.includes('--audit')) {
    const report = await auditPack(pack, undefined, {
      filter: option('--filter'),
      timeoutMs: option('--timeout') ? Number(option('--timeout')) : undefined,
      generate: argv.includes('--commonjs') ? { moduleFormat: 'commonjs' } : undefined
    });
    console.log(formatAudit(report));
    return report.findings.length || (report.skipped && !report.missingTool) ? 1 : 0;
  }
  const fixturesDir = option('--fixtures');
  const report = await runConformance(pack, {
    fixtures: fixturesDir ? loadFixtureSet(fixturesDir) : defaultFixtureSet(),
    filter: option('--filter'),
    concurrency: option('--concurrency') ? Number(option('--concurrency')) : undefined,
    timeoutMs: option('--timeout') ? Number(option('--timeout')) : undefined,
    generate: argv.includes('--commonjs') ? { moduleFormat: 'commonjs' } : undefined
  });
  console.log(formatReport(report));
  return report.failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
