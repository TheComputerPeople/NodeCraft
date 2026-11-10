// Builds the tree-sitter grammars the Codebase Map parses code with (docs/codebase-map.md, step 2)
// into grammars/, one .wasm per language, with grammars/grammars.json (each grammar's package,
// version, license, size and SHA-256) and the notices in THIRD_PARTY_NOTICES.md.
//
//   npm run build:grammars
//
// The .wasm files are committed, so only changing a grammar needs this. Each grammar is built from
// its npm package's generated parser (src/parser.c and its scanner), fetched with `npm pack` (its
// install scripts never run), by the tree-sitter CLI of web-tree-sitter's version, so the two share
// one ABI. The CLI downloads wasi-sdk (about 600 MB) into its own cache the first time.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'grammars');

// Each grammar: its file name in grammars/, the package and exact version, and the folder in the
// package that holds its src/ (packages with two grammars have one folder each).
const GRAMMARS = [
  { id: 'typescript', package: 'tree-sitter-typescript', version: '0.23.2', dir: 'typescript' },
  { id: 'tsx', package: 'tree-sitter-typescript', version: '0.23.2', dir: 'tsx' },
  { id: 'javascript', package: 'tree-sitter-javascript', version: '0.25.0' },
  { id: 'python', package: 'tree-sitter-python', version: '0.25.0' },
  { id: 'c_sharp', package: 'tree-sitter-c-sharp', version: '0.23.5' },
  { id: 'c', package: 'tree-sitter-c', version: '0.24.1' },
  { id: 'cpp', package: 'tree-sitter-cpp', version: '0.23.4' },
  { id: 'rust', package: 'tree-sitter-rust', version: '0.24.0' },
  { id: 'java', package: 'tree-sitter-java', version: '0.23.5' },
  { id: 'go', package: 'tree-sitter-go', version: '0.25.0' },
  { id: 'lua', package: '@tree-sitter-grammars/tree-sitter-lua', version: '0.4.1' },
  { id: 'gdscript', package: 'tree-sitter-gdscript', version: '6.1.0' },
  { id: 'ruby', package: 'tree-sitter-ruby', version: '0.23.1' },
  { id: 'php', package: 'tree-sitter-php', version: '0.24.2', dir: 'php' }
];

const NOTICES_BEGIN = '<!-- grammars:begin (written by scripts/build-grammars.js) -->';
const NOTICES_END = '<!-- grammars:end -->';

function run(command, args, cwd) {
  // npm through its own script when `npm run` started this (no shell on Windows, where npm is a .cmd).
  const npmScript = process.env.npm_execpath;
  if (command === 'npm' && npmScript && /\.[cm]?js$/.test(npmScript)) [command, args] = [process.execPath, [npmScript, ...args]];
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' && command === 'npm' });
}

function cli() {
  const binary = path.join(root, 'node_modules', 'tree-sitter-cli', process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter');
  if (!fs.existsSync(binary)) throw new Error('The tree-sitter CLI is missing: run npm install.');
  const cliVersion = run(binary, ['--version']).trim().split(/\s+/).pop();
  const runtime = require(path.join(root, 'node_modules', 'web-tree-sitter', 'package.json')).version;
  if (cliVersion !== runtime) throw new Error(`tree-sitter CLI ${cliVersion} doesn't match web-tree-sitter ${runtime}: pin them to one version.`);
  return { binary, version: cliVersion };
}

function licenseOf(folder) {
  const name = fs.readdirSync(folder).find((file) => /^licen[cs]e(\.md|\.txt)?$/i.test(file));
  if (!name) throw new Error(`No license file in ${folder}`);
  return fs.readFileSync(path.join(folder, name), 'utf8').replace(/\r\n/g, '\n').trim();
}

function main() {
  const tool = cli();
  const only = process.argv.slice(2);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-grammars-'));
  fs.mkdirSync(out, { recursive: true });
  const manifestFile = path.join(out, 'grammars.json');
  const previous = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).grammars : [];
  const manifest = [];
  const licenses = new Map();
  const unpacked = new Map();
  try {
    for (const grammar of GRAMMARS) {
      const key = `${grammar.package}@${grammar.version}`;
      let folder = unpacked.get(key);
      if (!folder) {
        folder = path.join(work, String(unpacked.size));
        fs.mkdirSync(folder);
        const tarball = run('npm', ['pack', key, '--silent', '--pack-destination', folder], folder).trim().split(/\r?\n/).pop();
        run('tar', ['-xzf', tarball], folder);
        folder = path.join(folder, 'package');
        unpacked.set(key, folder);
      }
      licenses.set(grammar.package, { version: grammar.version, text: licenseOf(folder) });
      const file = `tree-sitter-${grammar.id}.wasm`;
      const target = path.join(out, file);
      const kept = previous.find((p) => p.id === grammar.id && p.package === grammar.package && p.version === grammar.version && p.cli === tool.version);
      if ((only.length && !only.includes(grammar.id)) || (!only.length && kept && fs.existsSync(target))) {
        if (!kept || !fs.existsSync(target)) throw new Error(`${file} isn't built yet: build it too.`);
        manifest.push(kept);
        continue;
      }
      console.log(`Building ${file} from ${key}${grammar.dir ? ` (${grammar.dir}/)` : ''}`);
      run(tool.binary, ['build', '--wasm', '-o', target, grammar.dir ? path.join(folder, grammar.dir) : folder], folder);
      const bytes = fs.readFileSync(target);
      manifest.push({
        id: grammar.id, file, package: grammar.package, version: grammar.version, cli: tool.version,
        license: JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).license,
        bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify({ runtime: `web-tree-sitter@${tool.version}`, grammars: manifest }, null, 2)}\n`);
  writeNotices(tool.version, licenses);
  const total = manifest.reduce((sum, g) => sum + g.bytes, 0);
  console.log(`${manifest.length} grammars, ${(total / 1024 / 1024).toFixed(1)} MB, in ${path.relative(root, out)}`);
}

function writeNotices(runtimeVersion, licenses) {
  const notices = path.join(root, 'THIRD_PARTY_NOTICES.md');
  const runtimeLicense = licenseOf(path.join(root, 'node_modules', 'web-tree-sitter'));
  const sections = [
    NOTICES_BEGIN,
    '',
    '## tree-sitter',
    '',
    'The Codebase Map ([docs/codebase-map.md](docs/codebase-map.md)) parses code with web-tree-sitter and these grammars, built into `grammars/` from their packages.',
    '',
    `### web-tree-sitter ${runtimeVersion}`,
    '',
    '```',
    runtimeLicense,
    '```',
    ...[...licenses].flatMap(([name, { version, text }]) => ['', `### ${name} ${version}`, '', '```', text, '```']),
    '',
    NOTICES_END
  ].join('\n');
  let text = fs.readFileSync(notices, 'utf8');
  const begin = text.indexOf(NOTICES_BEGIN);
  const end = text.indexOf(NOTICES_END);
  text = begin >= 0 && end > begin ? `${text.slice(0, begin)}${sections}${text.slice(end + NOTICES_END.length)}` : `${text.trimEnd()}\n\n${sections}\n`;
  fs.writeFileSync(notices, text);
}

main();
