// Indexing a workspace folder for the Codebase Map (docs/codebase-map.md, Part 1): its files are
// read by the parsing worker (cached by their content), its projects by the project model, its
// graph files by the serializer, and the index is built by src/core/codemap/code-index.ts. Free of
// the vscode API, so tests index fixture folders.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeIndex, IndexFile, IndexGraph, IndexProject, buildCodeIndex } from '../core/codemap/code-index';
import { FileFacts, QUERIES } from '../core/codemap/facts';
import { generatedFrom, isGeneratedSupport } from '../core/codemap/generated';
import { GrammarId, grammarForFile, grammarForShebang, mayBeScript } from '../core/parsing/grammars';
import { parseDocument } from '../core/serializer';
import { TOO_LONG } from './code-parser';
import { ParseService } from './parse-service';
import { findProjects } from './projects';

// Folders that hold no code of the project's own: dependencies, build output, tools' state.
export const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'vendor', 'dist', 'out', '.venv', 'venv', 'env', '__pycache__', '.godot', '.gradle', '.idea', '.vs', '.vscode-test', '.tox', 'site-packages', 'blueprint-packages']);

// Folders that are build output only beside their build's project file: bin/ is a .NET project's
// output, but a Node, Lua or Ruby project's programs.
const BUILD_OUTPUT: Record<string, RegExp> = {
  bin: /\.(cs|fs|vb)proj$/, obj: /\.(cs|fs|vb)proj$/,
  build: /^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|CMakeLists\.txt|setup\.py|pyproject\.toml|meson\.build)$/,
  target: /^(Cargo\.toml|pom\.xml)$/, x64: /\.(vcxproj|sln)$/, Debug: /\.(vcxproj|sln|csproj)$/, Release: /\.(vcxproj|sln|csproj)$/
};

// Files larger than this are indexed by name only (a generated parser, a bundled library), and read
// only as far as a generated file's header.
export const MAX_FILE_BYTES = 1024 * 1024;
const HEAD_BYTES = 512;
// Files read and parsed at a time, so a large folder's files aren't all in memory at once.
const READ_AT_ONCE = 16;

// Facts by path and content hash, kept between runs (in the extension's workspace storage).
export interface FactsCache {
  get(path: string, hash: string): FileFacts | undefined;
  set(path: string, hash: string, facts: FileFacts): void;
}

// The cache's version: when the queries or grammars change, cached facts are read again.
export function factsVersion(grammarDir: string): string {
  const hash = crypto.createHash('sha1').update(JSON.stringify(QUERIES));
  try {
    hash.update(fs.readFileSync(path.join(grammarDir, 'grammars.json')));
  } catch {
    // No manifest: the queries alone.
  }
  return hash.digest('hex').slice(0, 16);
}

// A FactsCache in one JSON file.
export class JsonFactsCache implements FactsCache {
  private entries = new Map<string, { hash: string; facts: FileFacts }>();
  private readonly used = new Set<string>();
  private dirty = false;

  constructor(private readonly file: string, private readonly version: string) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string; files?: Record<string, { hash: string; facts: FileFacts }> };
      if (saved.version === version && saved.files) this.entries = new Map(Object.entries(saved.files));
    } catch {
      // No cache yet, or an unreadable one: start empty.
    }
  }

  get(p: string, hash: string): FileFacts | undefined {
    this.used.add(p);
    const entry = this.entries.get(p);
    return entry?.hash === hash ? entry.facts : undefined;
  }

  set(p: string, hash: string, facts: FileFacts): void {
    this.used.add(p);
    this.entries.set(p, { hash, facts });
    this.dirty = true;
  }

  // Forgets the files the last index didn't read (deleted or excluded ones), then starts counting again.
  pruneUnused(): void {
    for (const p of this.entries.keys()) {
      if (!this.used.has(p)) {
        this.entries.delete(p);
        this.dirty = true;
      }
    }
    this.used.clear();
  }

  save(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: this.version, files: Object.fromEntries(this.entries) }));
    this.dirty = false;
  }
}

export interface IndexOptions {
  parser: ParseService;
  cache?: FactsCache;
  // At most this many source files (the scanLimit setting); the rest are left out and counted.
  limit?: number;
  // Paths (relative, "/") the user excludes (files.exclude).
  exclude?: (relativePath: string) => boolean;
}

export interface IndexResult {
  index: CodeIndex;
  files: number;
  parsed: number;
  // Source files past the limit, left out.
  skipped: number;
  // Source files the parser failed on (a crashed worker), on the map by name only.
  failed: number;
  milliseconds: number;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

// The start of a file, as text.
async function readHead(file: string): Promise<string | undefined> {
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const head = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
      return head.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

// The grammar of a script without an extension, from its `#!` line.
function scriptGrammar(file: string): GrammarId | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(200);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      return grammarForShebang(head.subarray(0, read).toString('utf8').split(/\r?\n/)[0]);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// The folder's source files (with the grammar each is parsed with) and graph files, skipping
// dependencies and build output.
function listFiles(root: string, exclude?: (p: string) => boolean): { sources: string[]; graphs: string[]; grammars: Map<string, GrammarId> } {
  const sources: string[] = [];
  const grammars = new Map<string, GrammarId>();
  const graphs: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.filter((e) => e.isFile()).map((e) => e.name);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, full));
      if (exclude?.(relative)) continue;
      if (entry.isDirectory()) {
        const output = BUILD_OUTPUT[entry.name];
        if (!SKIPPED_FOLDERS.has(entry.name) && !entry.name.startsWith('.') && !(output && names.some((n) => output.test(n)))) walk(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.vgraph')) graphs.push(relative);
        else {
          const grammar = grammarForFile(entry.name) ?? (mayBeScript(relative) ? scriptGrammar(full) : undefined);
          if (grammar) {
            sources.push(relative);
            grammars.set(relative, grammar);
          }
        }
      }
    }
  };
  walk(root);
  return { sources: sources.sort(), graphs: graphs.sort(), grammars };
}

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

// The projects of the folder, with what resolving imports needs from their files.
export function indexProjects(root: string): IndexProject[] {
  return findProjects(root).map((project) => {
    const rel = toPosix(path.relative(root, project.root));
    const indexed: IndexProject = { root: rel, name: rel ? path.basename(project.root) : path.basename(root), buildSystems: project.buildSystems, languages: project.languages };
    if (project.buildSystems.includes('npm')) {
      const pkg = readJson(path.join(project.root, 'package.json'));
      if (typeof pkg?.name === 'string') indexed.packageName = indexed.name = pkg.name;
      const main = typeof pkg?.module === 'string' ? pkg.module : typeof pkg?.main === 'string' ? pkg.main : undefined;
      if (main) indexed.main = main;
      const bin = pkg?.bin;
      const bins = typeof bin === 'string' ? [bin] : bin && typeof bin === 'object' ? Object.values(bin as Record<string, unknown>).filter((b): b is string => typeof b === 'string') : [];
      if (bins.length) indexed.bins = bins;
      // The files its scripts run with Node (or tsx, ts-node, Bun), and the module its index.html loads.
      const scripts = new Set<string>();
      for (const command of Object.values((pkg?.scripts ?? {}) as Record<string, unknown>)) {
        if (typeof command !== 'string') continue;
        for (const m of command.matchAll(/(?:^|[;&|]\s*)(?:node|tsx|ts-node|bun(?: run)?|deno run)(?:\s+--?[\w-]+(?:=\S+)?)*\s+([\w./@-]+\.[cm]?[jt]sx?)\b/g)) scripts.add(m[1]);
      }
      try {
        const html = fs.readFileSync(path.join(project.root, 'index.html'), 'utf8');
        for (const m of html.matchAll(/<script[^>]*\bsrc="\/?([^"]+\.[cm]?[jt]sx?)"/g)) scripts.add(m[1]);
      } catch {
        // No index.html.
      }
      if (scripts.size) indexed.scripts = [...scripts];
    }
    const read = (name: string): string | undefined => {
      try {
        return fs.readFileSync(path.join(project.root, name), 'utf8');
      } catch {
        return undefined;
      }
    };
    if (project.buildSystems.includes('cargo')) {
      const name = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(read('Cargo.toml') ?? '')?.[1];
      if (name) indexed.packageName = indexed.name = name;
    }
    if (project.buildSystems.includes('go')) {
      const module = /^module\s+(\S+)/m.exec(read('go.mod') ?? '')?.[1];
      if (module) indexed.goModule = module;
    }
    return indexed;
  });
}

export async function indexFolder(root: string, options: IndexOptions): Promise<IndexResult> {
  const started = performance.now();
  const listed = listFiles(root, options.exclude);
  const limit = options.limit ?? Infinity;
  const sources = listed.sources.slice(0, limit);
  let parsed = 0;
  let failed = 0;
  const files: IndexFile[] = [];
  // A few files at a time, read without blocking (docs/audit.md, third pass).
  let next = 0;
  const readOne = async (relative: string): Promise<void> => {
    const grammar = listed.grammars.get(relative)!;
    const full = path.join(root, relative);
    let size: number;
    try {
      size = (await fs.promises.stat(full)).size;
    } catch {
      return;
    }
    const nameOnly = (): FileFacts => ({ grammar, declarations: [], imports: [], entries: [], calls: [], bases: [], errors: 0 });
    // A file too large to parse: by name, with what its head says (a generated file's header).
    if (size > MAX_FILE_BYTES) {
      const head = await readHead(full);
      if (head === undefined) return;
      const graph = generatedFrom(head);
      files.push({ path: relative, facts: nameOnly(), ...(graph ? { generatedFrom: graph } : isGeneratedSupport(relative, head) ? { generatedFrom: 'support' } : {}) });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(full);
    } catch {
      return;
    }
    const text = bytes.toString('utf8');
    const hash = crypto.createHash('sha1').update(bytes).digest('hex');
    let facts = options.cache?.get(relative, hash);
    if (!facts) {
      try {
        facts = await options.parser.facts(grammar, text);
        options.cache?.set(relative, hash, facts);
      } catch (error) {
        // A file that takes too long is by name only, until it changes; one the parser fails on is
        // by name only this time. Either way the rest of the map is drawn.
        facts = nameOnly();
        if (error instanceof Error && error.message === TOO_LONG) options.cache?.set(relative, hash, facts);
        else failed++;
      }
      parsed++;
    }
    const graph = generatedFrom(text);
    files.push({ path: relative, facts, ...(graph ? { generatedFrom: graph } : isGeneratedSupport(relative, text) ? { generatedFrom: 'support' } : {}) });
  };
  await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, sources.length) }, async () => {
    while (next < sources.length) await readOne(sources[next++]);
  }));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const graphs: IndexGraph[] = [];
  for (const relative of listed.graphs) {
    try {
      graphs.push({ path: relative, document: parseDocument(fs.readFileSync(path.join(root, relative), 'utf8'), path.basename(relative, '.vgraph')).document });
    } catch {
      // An unreadable graph file isn't on the map until it's fixed.
    }
  }
  const index = buildCodeIndex({ files, graphs, projects: indexProjects(root), folderName: path.basename(root) });
  return { index, files: files.length, parsed, failed, skipped: listed.sources.length - sources.length, milliseconds: performance.now() - started };
}
