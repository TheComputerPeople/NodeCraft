// blueprint-conformance: runs the conformance suite for a language pack and prints the report.
//
//   blueprint-conformance <pack> [--filter <text>] [--fixtures <dir>] [--concurrency <n>]
//                                [--timeout <ms>] [--commonjs]
//
// <pack> is a JavaScript module that exports a LanguagePack (as `pack`, as its default export, or
// as its only export that looks like one), or the id of a built-in pack. Exits with 1 when a fixture
// fails.
import * as path from 'node:path';
import { LanguagePack } from '../core/language-pack';
import { builtinLanguagePacks } from '../core/languages';
import { defaultFixtureSet, formatReport, loadFixtureSet, runConformance } from './conformance';

function isPack(value: unknown): value is LanguagePack {
  return !!value && typeof value === 'object' && typeof (value as LanguagePack).id === 'string' && typeof (value as LanguagePack).mapType === 'function';
}

export function loadPack(spec: string): LanguagePack {
  const builtin = builtinLanguagePacks().get(spec);
  if (builtin) return builtin;
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
  const valued = ['--filter', '--fixtures', '--concurrency', '--timeout'];
  const spec = argv.find((arg, i) => !arg.startsWith('--') && !valued.includes(argv[i - 1]));
  if (!spec) {
    console.error('Usage: blueprint-conformance <pack module or built-in id> [--filter <text>] [--fixtures <dir>] [--concurrency <n>] [--timeout <ms>] [--commonjs]');
    return 2;
  }
  const pack = loadPack(spec);
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
