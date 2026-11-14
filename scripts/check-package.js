// Checks a built .vsix (the newest in the repository, or the one named) before it's published:
// - every module its code requires outside itself is in the package (0.1.0 left out web-tree-sitter
//   and elkjs, and couldn't activate);
// - every file package.json points to (walkthrough pages, schemas, the icon, the guide the Coming
//   from Unreal command opens) is in it;
// - no module in it has a license that would tie NodeCraft to the GPL (scripts/licenses.js);
// - the grammars are in it, and nothing that isn't needed at runtime (sources, tests) is;
// - the parser, extracted on its own, loads.
// Usage: node scripts/check-package.js [file.vsix]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { builtinModules } = require('module');
const { allowedLicense } = require('./licenses');

const root = path.resolve(__dirname, '..');
const vsix = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.readdirSync(root).filter((f) => f.endsWith('.vsix')).map((f) => path.join(root, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!vsix) {
  console.error('No .vsix to check: run `npm run package` first.');
  process.exit(1);
}

// The entries of a zip file, from its central directory.
function readZip(file) {
  const buf = fs.readFileSync(file);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(`${file} isn't a zip file`);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const entries = readZip(vsix);
const has = (p) => entries.has(`extension/${p}`);
const read = (p) => entries.get(`extension/${p}`)();
const problems = [];
const pkg = JSON.parse(read('package.json').toString('utf8'));

// Modules the code requires from outside itself.
const builtins = new Set([...builtinModules, 'vscode']);
const required = new Set();
for (const name of entries.keys()) {
  if (!name.startsWith('extension/dist/') || !name.endsWith('.js')) continue;
  const text = entries.get(name)().toString('utf8');
  for (const m of text.matchAll(/require\(["']([^"'./][^"']*)["']\)/g)) {
    const spec = m[1];
    if (spec.startsWith('node:') || builtins.has(spec.split('/')[0])) continue;
    // Only npm packages: generated code's templates require modules too (Lua's "vgraph_runtime").
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!fs.existsSync(path.join(root, 'node_modules', name))) continue;
    required.add(spec);
  }
}
for (const spec of required) {
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
  if (!has(`node_modules/${name}/package.json`)) problems.push(`the code requires ${name}, which isn't in the package`);
  else if (sub && !has(`node_modules/${name}/${sub}`) && !has(`node_modules/${name}/${sub}.js`)) problems.push(`the code requires ${spec}, which isn't in the package`);
}
for (const dependency of Object.keys(pkg.dependencies ?? {})) {
  if (!has(`node_modules/${dependency}/package.json`)) problems.push(`the dependency ${dependency} isn't in the package`);
}

// The modules' licenses: none may tie NodeCraft to the GPL (docs/licensing.md).
for (const name of entries.keys()) {
  const match = /^extension\/(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\/package\.json$/.exec(name);
  if (!match) continue;
  const manifest = JSON.parse(entries.get(name)().toString('utf8'));
  if (!manifest.name) continue;
  const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
  if (!allowedLicense(license)) problems.push(`${match[1]} is licensed ${license ?? '(not stated)'}, which NodeCraft can't include (docs/licensing.md)`);
}

// Files package.json points to.
const pointed = [pkg.main && `${pkg.main.replace(/^\.\//, '')}`];
if (pkg.icon) pointed.push(pkg.icon);
for (const walkthrough of pkg.contributes?.walkthroughs ?? []) {
  for (const step of walkthrough.steps) pointed.push(step.media?.markdown, step.media?.image, step.media?.svg);
}
for (const v of pkg.contributes?.jsonValidation ?? []) pointed.push(v.url);
pointed.push('docs/coming-from-unreal.md', 'README.md', 'LICENSE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md');
const seeLicense = /^SEE LICENSE IN (.+)$/.exec(pkg.license ?? '');
if (seeLicense) pointed.push(seeLicense[1]);
for (const file of pointed.filter(Boolean).map((f) => (typeof f === 'string' ? f : f.light ?? f.dark)).filter(Boolean)) {
  const clean = file.replace(/^\.\//, '');
  if (/^https?:/.test(clean)) continue;
  const name = clean === 'LICENSE' && !has('LICENSE') ? 'LICENSE.txt' : clean;
  if (!has(name) && !has(name.toLowerCase())) problems.push(`package.json points to ${clean}, which isn't in the package`);
}

// The grammars, and nothing that's only for development.
const grammars = [...entries.keys()].filter((n) => /^extension\/grammars\/.+\.wasm$/.test(n));
if (grammars.length < 10) problems.push(`only ${grammars.length} grammars are in the package`);
for (const name of entries.keys()) {
  if (/^extension\/(src|test|out|sample|examples|packages|scripts|\.vscode|\.vscode-test|\.claude)\//.test(name)) {
    problems.push(`${name.slice('extension/'.length)} is in the package, and isn't needed at runtime`);
    break;
  }
}

// The parser, extracted with the package's own modules, loads.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecraft-vsix-'));
try {
  for (const [name, data] of entries) {
    if (!name.startsWith('extension/') || name.endsWith('/')) continue;
    const target = path.join(temp, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data());
  }
  try {
    require(path.join(temp, 'extension', 'dist', 'extension', 'code-parser.js'));
  } catch (error) {
    problems.push(`the parser doesn't load from the package: ${error.message.split('\n')[0]}`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const size = (fs.statSync(vsix).size / 1e6).toFixed(1);
if (problems.length) {
  console.error(`${path.basename(vsix)} (${size} MB, ${entries.size} files) can't be published:`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log(`${path.basename(vsix)} (${size} MB, ${entries.size} files): ${pkg.publisher}.${pkg.name} ${pkg.version}, with ${[...required].sort().join(', ') || 'no outside modules'}, ${grammars.length} grammars and every file package.json points to.`);
