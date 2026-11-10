// The code index (docs/codebase-map.md, Part 1): every project, module, file, type and function of a
// workspace folder, the graph files that stand in for their generated code, the imports between
// them and the entry points. Built from each file's facts (facts.ts) and the projects around them;
// pure, so tests build it from fixture folders.
import { CallEdge, InheritEdge, UnresolvedCall, linkCalls } from './calls';
import { FileFacts, ImportFact } from './facts';
import { GraphDocument } from '../model';
import { GrammarId } from '../parsing/grammars';

export type EntityKind = 'project' | 'module' | 'file' | 'graph-file' | 'graph' | 'type' | 'function' | 'external';

export interface EntryPoint {
  // main: a program's main; script: a file that runs as a whole; test: a test; engine: called by an
  // engine (Godot); event: a graph's Start or Main event; bin: a package's executable; handler: a
  // framework calls it (a route, a command, a controller's action).
  kind: 'main' | 'script' | 'test' | 'engine' | 'event' | 'bin' | 'handler';
  name?: string;
  line?: number;
}

export interface Entity {
  // Stable across rebuilds: "p:<root>", "m:<dir>", "f:<path>", "g:<path>", "g:<path>#<graph>",
  // "s:<path>#<qualified name>", "x:<language>:<package>".
  id: string;
  kind: EntityKind;
  name: string;
  parent?: string;
  // Relative to the workspace folder, with "/".
  path?: string;
  line?: number;
  endLine?: number;
  // The extension's language id (a file's, a declaration's, an external package's).
  language?: string;
  // What it is beyond its kind: a declaration's kind ("class", "method"), a graph's kind, a
  // module's package or namespace, a project's build systems.
  detail?: string;
  entries?: EntryPoint[];
}

export interface ImportEdge {
  // A file or graph file, and the file, graph file or external package it imports.
  from: string;
  to: string;
  line: number;
  source: string;
}

export interface UnresolvedImport {
  from: string;
  source: string;
  line: number;
}

export interface CodeIndex {
  // Parents before their children.
  entities: Entity[];
  imports: ImportEdge[];
  // Imports of the workspace's own code that weren't found (a relative path to nothing).
  unresolved: UnresolvedImport[];
  // Calls between the workspace's functions, methods and graphs (calls.ts), calls too ambiguous
  // to draw, and the types each type extends or implements.
  calls: CallEdge[];
  unresolvedCalls: UnresolvedCall[];
  inherits: InheritEdge[];
  // The generated files and the graph file each is shown as (support code's isn't shown).
  generated: { path: string; shownAs?: string }[];
}

// A project, as the extension's project model finds it, with what resolving imports needs.
export interface IndexProject {
  // Relative to the workspace folder ("" for the folder itself).
  root: string;
  name: string;
  buildSystems: string[];
  languages: string[];
  // The name other projects import it by: package.json's, Cargo's (as a crate), a gem's.
  packageName?: string;
  // package.json's main or module, and its bin targets, relative to the project's root.
  main?: string;
  bins?: string[];
  // Files its scripts run (`node src/server.js`) or its index.html loads, relative to its root.
  scripts?: string[];
  // go.mod's module path.
  goModule?: string;
  // Folders Lua's require and Python's imports start from, relative to the project's root.
  requireRoots?: string[];
}

export interface IndexFile {
  path: string;
  facts: FileFacts;
  // The graph file (its path) a generated file comes from, or "support" for generated support code.
  generatedFrom?: string;
}

export interface IndexGraph {
  path: string;
  document: GraphDocument;
}

export interface IndexInput {
  files: IndexFile[];
  graphs: IndexGraph[];
  projects: IndexProject[];
  // The workspace folder's name, for code outside every project.
  folderName: string;
}

// The extension's language id for a grammar.
export function languageOfGrammar(grammar: GrammarId): string {
  return grammar === 'c_sharp' ? 'csharp' : grammar === 'tsx' ? 'typescript' : grammar;
}

// Path helpers ("/"-separated, relative to the workspace folder; core has no node:path).
export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function joinPath(...parts: string[]): string {
  const out: string[] = [];
  for (const segment of parts.join('/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      // Above the workspace folder is outside it.
      if (!out.length || out[out.length - 1] === '..') out.push('..');
      else out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join('/');
}

function within(root: string, p: string): boolean {
  return root === '' || p === root || p.startsWith(`${root}/`);
}

function stem(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

export function buildCodeIndex(input: IndexInput): CodeIndex {
  const entities = new Map<string, Entity>();
  const add = (entity: Entity): Entity => {
    const existing = entities.get(entity.id);
    if (existing) return existing;
    entities.set(entity.id, entity);
    return entity;
  };

  // Projects, the deepest first when finding a file's, and one for the code outside them all.
  const projects = [...input.projects].sort((a, b) => b.root.length - a.root.length);
  const outside: IndexProject = { root: '', name: input.folderName, buildSystems: [], languages: [] };
  if (!projects.some((p) => p.root === '')) projects.push(outside);
  const projectOf = (p: string): IndexProject => projects.find((project) => within(project.root, p)) ?? outside;
  const projectId = (project: IndexProject) => `p:${project.root}`;
  const addProject = (project: IndexProject): void => {
    add({ id: projectId(project), kind: 'project', name: project.name, path: project.root, detail: project.buildSystems.join(', ') || undefined });
  };

  // A folder's module, and its parents up to its project.
  const moduleOf = (dir: string): string => {
    const project = projectOf(dir);
    addProject(project);
    if (dir === project.root) return projectId(project);
    const id = `m:${dir}`;
    if (!entities.has(id)) {
      const parent = moduleOf(dirname(dir) === dir ? project.root : (within(project.root, dirname(dir)) ? dirname(dir) : project.root));
      add({ id, kind: 'module', name: basename(dir), parent, path: dir });
    }
    return id;
  };

  // Generated files are shown as their graphs; their imports become the graph file's.
  const graphPaths = new Set(input.graphs.map((g) => g.path));
  const graphByName = new Map<string, string[]>();
  for (const g of input.graphs) graphByName.set(basename(g.path), [...(graphByName.get(basename(g.path)) ?? []), g.path]);
  const graphOfGenerated = (file: IndexFile): string | undefined => {
    if (!file.generatedFrom || file.generatedFrom === 'support') return undefined;
    const beside = joinPath(dirname(file.path), file.generatedFrom);
    if (graphPaths.has(beside)) return beside;
    // Java's output goes to its package folder: the one graph file of that name.
    const named = graphByName.get(basename(file.generatedFrom)) ?? [];
    return named.length === 1 ? named[0] : undefined;
  };
  // Where each file is shown: itself, its graph's file, or nowhere (support code).
  const shownAs = new Map<string, string | undefined>();
  for (const file of input.files) {
    shownAs.set(file.path, file.generatedFrom === 'support' ? undefined : file.generatedFrom ? (graphOfGenerated(file) ? `g:${graphOfGenerated(file)}` : `f:${file.path}`) : `f:${file.path}`);
  }

  // Graph files and their graphs.
  for (const graph of input.graphs) {
    const id = `g:${graph.path}`;
    const doc = graph.document;
    const entries: EntryPoint[] = [];
    add({ id, kind: 'graph-file', name: basename(graph.path), parent: moduleOf(dirname(graph.path)), path: graph.path, language: doc.language || undefined, detail: doc.kind });
    for (const g of doc.graphs) {
      const graphEntries: EntryPoint[] = [];
      for (const node of g.nodes) {
        if (node.type === 'core:event.start' || node.type === 'core:event.main') graphEntries.push({ kind: 'event', name: node.type === 'core:event.start' ? 'Start' : 'Main' });
        else if (node.type === 'core:test.case') graphEntries.push({ kind: 'test', name: String(node.properties?.name ?? 'Test Case') });
      }
      entries.push(...graphEntries);
      add({ id: `${id}#${g.id}`, kind: 'graph', name: g.name, parent: id, path: graph.path, language: doc.language || undefined, detail: g.kind, entries: graphEntries.length ? graphEntries : undefined });
    }
    if (entries.length) entities.get(id)!.entries = entries;
  }

  // Each file's declarations' entity ids. A generated file's are its graph's: a declaration named
  // as one of its graphs is that graph, any other its graph file.
  const declarationIds = new Map<string, Map<string, string>>();
  for (const file of input.files) {
    const shown = shownAs.get(file.path);
    if (!shown?.startsWith('g:')) continue;
    const doc = input.graphs.find((g) => `g:${g.path}` === shown)?.document;
    const ids = new Map<string, string>();
    for (const d of file.facts.declarations) {
      const graph = doc?.graphs.find((g) => g.name === d.name || g.id === d.name);
      ids.set([...d.container, d.name].join('.'), graph ? `${shown}#${graph.id}` : shown);
    }
    declarationIds.set(file.path, ids);
  }

  // Source files and their declarations.
  for (const file of input.files) {
    if (shownAs.get(file.path) !== `f:${file.path}`) continue;
    const { facts } = file;
    const language = languageOfGrammar(facts.grammar);
    const fileId = `f:${file.path}`;
    const fileEntity = add({ id: fileId, kind: 'file', name: basename(file.path), parent: moduleOf(dirname(file.path)), path: file.path, language, detail: facts.package });
    const fileEntries: EntryPoint[] = [];
    const ids = new Map<string, string>();
    for (const d of facts.declarations) {
      const qualified = [...d.container, d.name].join('.');
      let id = `s:${file.path}#${qualified}`;
      // Overloads and redeclarations: each its own, by line.
      if (entities.has(id)) id = `${id}@${d.line}`;
      ids.set(qualified, ids.get(qualified) ?? id);
      const parent = d.container.length ? ids.get(d.container.join('.')) ?? fileId : fileId;
      const isType = !['function', 'method', 'constructor'].includes(d.kind);
      const entries = facts.entries.filter((e) => e.name === d.name && e.line >= d.line && e.line <= d.endLine && e.kind !== 'script')
        .map((e) => ({ kind: e.kind, name: e.name, line: e.line }));
      add({ id, kind: isType ? 'type' : 'function', name: d.name, parent, path: file.path, line: d.line, endLine: d.endLine, language, detail: d.kind, entries: entries.length ? entries : undefined });
    }
    for (const e of facts.entries) {
      if (e.kind === 'script') fileEntries.push({ kind: 'script', line: e.line });
      // A test named by a string (`test("adds", ...)`) belongs to the file.
      else if (e.kind === 'test' && !facts.declarations.some((d) => d.name === e.name)) fileEntries.push({ kind: 'test', name: e.name, line: e.line });
    }
    if (fileEntries.length) fileEntity.entries = fileEntries;
    declarationIds.set(file.path, ids);
  }

  // Package executables, main files and the files a project's scripts run.
  const markFile = (p: string | undefined, entry: EntryPoint): void => {
    const shown = p && shownAs.get(p);
    const entity = shown && entities.get(shown);
    if (entity && !entity.entries?.some((e) => e.kind === entry.kind)) entity.entries = [...(entity.entries ?? []), entry];
  };
  const known = (f: string) => shownAs.has(f) || graphPaths.has(f);
  for (const project of input.projects) {
    for (const bin of project.bins ?? []) markFile(resolveJsFile(joinPath(project.root, bin), known), { kind: 'bin' });
    for (const script of project.scripts ?? []) markFile(resolveJsFile(joinPath(project.root, script), known), { kind: 'script' });
    if (project.main) markFile(resolveJsFile(joinPath(project.root, project.main), known), { kind: 'main' });
  }
  // Scripting languages' programs, by where they are: a bin/, exe/ or scripts/ folder, or a main
  // file at a project's top (Lua, Ruby and PHP have no main function).
  for (const file of input.files) {
    if (!['lua', 'ruby', 'php'].includes(file.facts.grammar)) continue;
    const project = projectOf(file.path);
    const inProject = project.root ? file.path.slice(project.root.length + 1) : file.path;
    if (/(^|\/)(bin|exe|scripts)\//.test(inProject) || /^(main\.(lua|rb|php)|index\.php|artisan)$/.test(inProject)) markFile(file.path, { kind: 'script' });
  }

  // Imports.
  const context = new ResolveContext(input, projects, projectOf);
  const imports: ImportEdge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const seen = new Set<string>();
  const importedFiles = new Map<string, string[]>();
  const aliases = new Map<string, Map<string, string[]>>();
  for (const file of input.files) {
    const from = shownAs.get(file.path);
    if (!from || !entities.has(from)) continue;
    for (const imp of file.facts.imports) {
      const target = context.resolve(file, imp);
      if (target && 'files' in target) {
        importedFiles.set(file.path, [...(importedFiles.get(file.path) ?? []), ...target.files]);
        if (imp.alias) {
          if (!aliases.has(file.path)) aliases.set(file.path, new Map());
          aliases.get(file.path)!.set(imp.alias, target.files);
        }
      }
      if (target === undefined) {
        unresolved.push({ from, source: imp.source, line: imp.line });
        continue;
      }
      if (target === null) continue;
      const targets = 'files' in target ? target.files.map((f) => shownAs.get(f)).filter((t): t is string => !!t) : [externalId(file, target.external, entities, add)];
      for (const to of targets) {
        // Imports of the generated code's support files, and of itself, aren't shown.
        if (to === from) continue;
        const key = `${from}>${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        imports.push({ from, to, line: imp.line, source: imp.source });
      }
    }
  }
  // A graph's project functions are imports of their files, even before it's compiled.
  for (const graph of input.graphs) {
    const from = `g:${graph.path}`;
    for (const g of graph.document.graphs) {
      for (const node of g.nodes) {
        const m = /^fn:[^:]+:(.+)#/.exec(node.type);
        const to = m && shownAs.get(m[1]);
        if (!to || to === from || seen.has(`${from}>${to}`)) continue;
        seen.add(`${from}>${to}`);
        imports.push({ from, to, line: 0, source: m[1] });
      }
    }
  }

  const linked = linkCalls({ files: input.files, graphs: input.graphs, declarationIds, shownAs, importedFiles, samePackage: (file) => context.samePackage(file), aliases });

  // Parents before children.
  const ordered: Entity[] = [];
  const placed = new Set<string>();
  const place = (entity: Entity): void => {
    if (placed.has(entity.id)) return;
    if (entity.parent && entities.has(entity.parent)) place(entities.get(entity.parent)!);
    placed.add(entity.id);
    ordered.push(entity);
  };
  for (const entity of entities.values()) place(entity);
  const generated = input.files.filter((f) => f.generatedFrom).map((f) => ({ path: f.path, ...(shownAs.get(f.path) ? { shownAs: shownAs.get(f.path) } : {}) }));
  return { entities: ordered, imports, unresolved, ...linked, generated };
}

// Package ecosystems: TypeScript and JavaScript files import the same npm packages.
const ECOSYSTEMS: Record<string, string> = {
  typescript: 'npm', javascript: 'npm', python: 'pypi', csharp: 'nuget', java: 'maven', go: 'go', rust: 'crates',
  ruby: 'gems', php: 'composer', lua: 'luarocks', c: 'c', cpp: 'c', gdscript: 'godot'
};

function externalId(file: IndexFile, name: string, entities: Map<string, Entity>, add: (e: Entity) => Entity): string {
  const language = languageOfGrammar(file.facts.grammar);
  const id = `x:${ECOSYSTEMS[language] ?? language}:${name}`;
  if (!entities.has(id)) add({ id, kind: 'external', name, language, detail: ECOSYSTEMS[language] });
  return id;
}

function resolveJsFile(base: string, exists: (p: string) => boolean): string | undefined {
  if (exists(base)) return base;
  const noJs = base.replace(/\.(m|c)?jsx?$/, '');
  for (const ext of TS_EXTENSIONS) if (exists(`${noJs}${ext}`)) return `${noJs}${ext}`;
  for (const ext of TS_EXTENSIONS) if (exists(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return undefined;
}

// What an import resolves to: workspace files, an external package, undefined when it should have
// been found (a relative path to nothing), or null when it's nothing to show (a builtin).
type Target = { files: string[] } | { external: string } | undefined | null;

class ResolveContext {
  private readonly paths: Set<string>;
  // Java and PHP types, and C# and Java packages and namespaces, by qualified name.
  private readonly typeFiles = new Map<string, string[]>();
  private readonly namespaceFiles = new Map<string, string[]>();
  private readonly byBasename = new Map<string, string[]>();
  private readonly dirFiles = new Map<string, string[]>();

  constructor(input: IndexInput, private readonly projects: IndexProject[], private readonly projectOf: (p: string) => IndexProject) {
    this.paths = new Set([...input.files.map((f) => f.path), ...input.graphs.map((g) => g.path)]);
    const push = (map: Map<string, string[]>, key: string, value: string): void => {
      const list = map.get(key);
      if (!list) map.set(key, [value]);
      else if (!list.includes(value)) list.push(value);
    };
    for (const file of input.files) {
      push(this.byBasename, basename(file.path), file.path);
      push(this.dirFiles, dirname(file.path), file.path);
      const { facts } = file;
      const sep = facts.grammar === 'php' ? '\\' : '.';
      const namespaces = new Set<string>();
      if (facts.package) namespaces.add(facts.package);
      for (const d of facts.declarations) {
        if (d.kind === 'namespace' && (facts.grammar === 'c_sharp' || facts.grammar === 'php')) namespaces.add([...d.container, d.name].join('.'));
      }
      for (const ns of namespaces) push(this.namespaceFiles, `${facts.grammar === 'php' ? 'php' : facts.grammar}:${ns}`, file.path);
      for (const d of facts.declarations) {
        if (d.container.length && !(facts.grammar === 'c_sharp' && d.container.every((c) => namespaces.has(c)))) continue;
        if (d.kind === 'method' || d.kind === 'constructor' || d.kind === 'namespace') continue;
        const prefix = facts.package ?? (facts.grammar === 'c_sharp' ? d.container.join('.') : '');
        push(this.typeFiles, `${facts.grammar}:${prefix ? `${prefix}${sep}` : ''}${d.name}`, file.path);
      }
    }
  }

  private exists = (p: string): boolean => this.paths.has(p);

  // The files of a file's package, which it sees without importing them: Go's folder, Java's
  // package, C#'s and PHP's namespace.
  samePackage(file: IndexFile): string[] {
    const { grammar } = file.facts;
    if (grammar === 'go') return (this.dirFiles.get(dirname(file.path)) ?? []).filter((f) => f.endsWith('.go'));
    if (!file.facts.package || !['java', 'c_sharp', 'php'].includes(grammar)) return [];
    return this.namespaceFiles.get(`${grammar}:${file.facts.package}`) ?? [];
  }

  resolve(file: IndexFile, imp: ImportFact): Target {
    const dir = dirname(file.path);
    const project = this.projectOf(file.path);
    switch (file.facts.grammar) {
      case 'typescript': case 'tsx': case 'javascript':
        return this.javascript(imp.source, dir);
      case 'python':
        return this.python(imp, dir, project);
      case 'c_sharp':
        return this.namespace('c_sharp', imp.source, file.path) ?? (/^(System|Microsoft)(\.|$)/.test(imp.source) ? null : { external: imp.source.split('.')[0] });
      case 'java':
        return this.java(imp.source, file.path);
      case 'c': case 'cpp':
        return this.include(imp, dir, project);
      case 'rust':
        return this.rust(imp, file.path, project);
      case 'go':
        return this.go(imp.source, file.path);
      case 'lua':
        return this.lua(imp.source, project);
      case 'gdscript':
        return this.gdscript(imp.source, dir, project);
      case 'ruby':
        return this.ruby(imp, dir, project);
      case 'php':
        return this.php(imp, dir, project);
    }
  }

  private javascript(source: string, dir: string): Target {
    if (source.startsWith('.') || source.startsWith('/')) {
      const found = resolveJsFile(joinPath(dir, source), this.exists);
      // Data and assets (JSON, styles, images) aren't code: nothing to show.
      return found ? { files: [found] } : NOT_CODE.test(source) ? null : undefined;
    }
    if (source.startsWith('node:') || NODE_BUILTINS.has(source.split('/')[0])) return null;
    // A workspace package (a monorepo's), by its name: its main file, or its index.
    const parts = source.split('/');
    const name = source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const pkg = this.projects.find((p) => p.packageName === name && p.buildSystems.includes('npm'));
    if (pkg) {
      const rest = source.slice(name.length).replace(/^\//, '');
      const found = rest ? resolveJsFile(joinPath(pkg.root, rest), this.exists) ?? resolveJsFile(joinPath(pkg.root, 'src', rest), this.exists)
        : (pkg.main && resolveJsFile(joinPath(pkg.root, pkg.main), this.exists)) || resolveJsFile(joinPath(pkg.root, 'src/index'), this.exists) || resolveJsFile(joinPath(pkg.root, 'index'), this.exists);
      if (found) return { files: [found] };
    }
    return { external: name };
  }

  private python(imp: ImportFact, dir: string, project: IndexProject): Target {
    const module = imp.source.replace(/\./g, '/');
    const asModule = (base: string): string | undefined => {
      for (const candidate of [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`]) if (this.exists(candidate)) return candidate;
      return undefined;
    };
    // The module, and the names imported from it that are modules themselves.
    const fromBase = (base: string): string[] => {
      const found: string[] = [];
      const own = module ? asModule(joinPath(base, module)) : undefined;
      for (const name of imp.names ?? []) {
        const sub = asModule(joinPath(base, module, name));
        if (sub) found.push(sub);
      }
      if (own && (!found.length || !own.endsWith('__init__.py'))) found.unshift(own);
      else if (!module && !found.length) {
        const init = asModule(base);
        if (init) found.push(init);
      }
      return found;
    };
    if (imp.level) {
      let base = dir;
      for (let i = 1; i < imp.level; i++) base = dirname(base);
      const found = fromBase(base);
      return found.length ? { files: found } : undefined;
    }
    const roots = [...new Set([
      ...(project.requireRoots ?? []).map((r) => joinPath(project.root, r)), project.root, joinPath(project.root, 'src'), dirname(project.root),
      ...this.projects.filter((p) => p.buildSystems.includes('python')).flatMap((p) => [p.root, joinPath(p.root, 'src')]),
      // A script's own folder: Python runs `python scripts/main.py` with scripts/ on its path.
      dir, ''
    ])];
    for (const root of roots) {
      const found = fromBase(root);
      if (found.length) return { files: found };
      // `import a.b.c` where c is a name in a/b.py: the longest prefix that's a module.
      const segments = imp.source.split('.');
      for (let n = segments.length - 1; n > 0; n--) {
        const prefix = asModule(joinPath(root, segments.slice(0, n).join('/')));
        if (prefix) return { files: [prefix] };
      }
    }
    const top = imp.source.split('.')[0];
    return PYTHON_STDLIB.has(top) ? null : { external: top };
  }

  private namespace(grammar: string, name: string, self: string): Target {
    const files = (this.namespaceFiles.get(`${grammar}:${name}`) ?? []).filter((f) => f !== self);
    const types = this.typeFiles.get(`${grammar}:${name}`) ?? [];
    const all = [...new Set([...files, ...types])];
    return all.length ? { files: all } : undefined;
  }

  private java(source: string, self: string): Target {
    if (source.endsWith('.*')) {
      const pkg = source.slice(0, -2);
      const files = (this.namespaceFiles.get(`java:${pkg}`) ?? []).filter((f) => f !== self);
      // A static import of a class's members (`import static a.B.*`) names the class.
      if (files.length) return { files };
      if (this.typeFiles.get(`java:${pkg}`)) return { files: this.typeFiles.get(`java:${pkg}`)! };
      return /^javax?\./.test(pkg) ? null : { external: pkg.split('.').slice(0, 2).join('.') };
    }
    const files = this.typeFiles.get(`java:${source}`);
    if (files) return { files };
    return /^javax?\./.test(source) ? null : { external: source.split('.').slice(0, 2).join('.') };
  }

  private include(imp: ImportFact, dir: string, project: IndexProject): Target {
    const relative = joinPath(dir, imp.source);
    if (this.exists(relative)) return { files: [relative] };
    // Elsewhere in the project (an include directory): the nearest file whose path ends with it.
    const name = basename(imp.source);
    const matches = (this.byBasename.get(name) ?? []).filter((p) => p === imp.source || p.endsWith(`/${imp.source}`));
    const inProject = matches.filter((p) => within(project.root, p));
    const pick = inProject.length ? inProject : matches;
    if (pick.length) return { files: [pick.sort((a, b) => distance(dir, a) - distance(dir, b))[0]] };
    if (imp.kind === 'include') return undefined;
    // The standard library: C++'s headers have no extension, C's are a known set.
    if (!imp.source.includes('.') || C_STANDARD_HEADERS.has(imp.source)) return null;
    return { external: imp.source.split('/')[0] };
  }

  private rust(imp: ImportFact, self: string, project: IndexProject): Target {
    const crateSrc = joinPath(project.root, 'src');
    const crateRoot = ['lib.rs', 'main.rs'].map((f) => joinPath(crateSrc, f)).find(this.exists);
    // The folder holding this file's child modules: a crate root's or mod.rs's own folder, else
    // a folder named after the file.
    const base = basename(self);
    const ownDir = base === 'lib.rs' || base === 'main.rs' || base === 'mod.rs' || dirname(self) === joinPath(crateSrc, 'bin') ? dirname(self) : joinPath(dirname(self), stem(self));
    const moduleFile = (dir: string, segments: string[]): string | undefined => {
      for (let n = segments.length; n > 0; n--) {
        const p = joinPath(dir, ...segments.slice(0, n));
        const found = [`${p}.rs`, `${p}/mod.rs`].find(this.exists);
        if (found) return found;
      }
      return undefined;
    };
    if (imp.kind === 'mod') {
      // #[path] is relative to the folder of a crate root or mod.rs, else to the module's own folder.
      if (imp.path) {
        const found = [joinPath(ownDir, imp.path), joinPath(dirname(self), imp.path)].find(this.exists);
        return found ? { files: [found] } : undefined;
      }
      const found = moduleFile(ownDir, [imp.source]);
      return found ? { files: [found] } : undefined;
    }
    const segments = imp.source.split('::');
    const first = segments[0];
    if (first === 'crate') {
      const found = moduleFile(crateSrc, segments.slice(1));
      return found ? { files: [found] } : crateRoot ? { files: [crateRoot] } : undefined;
    }
    if (first === 'self' || first === 'super') {
      let dir = ownDir;
      let i = 0;
      // `self::` is this file's own children; each `super::` goes one module up.
      if (first === 'self') i = 1;
      else {
        dir = base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs' ? dirname(dirname(self)) : dirname(self);
        i = 1;
        while (segments[i] === 'super') {
          dir = dirname(dir);
          i++;
        }
      }
      const found = moduleFile(dir, segments.slice(i));
      return found ? { files: [found] } : null;
    }
    // Another crate of the workspace, by its name (dashes become underscores).
    const crate = this.projects.find((p) => p.buildSystems.includes('cargo') && p.packageName?.replace(/-/g, '_') === first);
    if (crate) {
      const src = joinPath(crate.root, 'src');
      const found = moduleFile(src, segments.slice(1)) ?? ['lib.rs', 'main.rs'].map((f) => joinPath(src, f)).find(this.exists);
      if (found) return { files: [found] };
    }
    // A module of this crate named without `crate::` (2015 paths, or a module in scope).
    const local = segments.length > 1 ? moduleFile(crateSrc, segments) : undefined;
    if (local) return { files: [local] };
    return ['std', 'core', 'alloc'].includes(first) ? null : { external: first };
  }

  private go(source: string, self: string): Target {
    const module = this.projects.filter((p) => p.goModule && (source === p.goModule || source.startsWith(`${p.goModule}/`))).sort((a, b) => b.goModule!.length - a.goModule!.length)[0];
    if (module) {
      const dir = joinPath(module.root, source.slice(module.goModule!.length));
      const files = (this.dirFiles.get(dir) ?? []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && f !== self);
      return files.length ? { files } : undefined;
    }
    const segments = source.split('/');
    // The standard library has no dot in its first segment.
    if (!segments[0].includes('.')) return null;
    return { external: segments.slice(0, 3).join('/') };
  }

  private lua(source: string, project: IndexProject): Target {
    const module = source.replace(/\./g, '/');
    const roots = [...new Set([...(project.requireRoots ?? []), '', 'src', 'lua', 'lib'].map((r) => joinPath(project.root, r)))];
    for (const root of roots) {
      const found = [`${joinPath(root, module)}.lua`, `${joinPath(root, module)}/init.lua`].find(this.exists);
      if (found) return { files: [found] };
    }
    return { external: source.split('.')[0] };
  }

  private gdscript(source: string, dir: string, project: IndexProject): Target {
    const target = source.startsWith('res://') ? joinPath(project.root, source.slice('res://'.length)) : joinPath(dir, source);
    if (this.exists(target)) return { files: [target] };
    // Scenes and resources aren't code.
    return /\.(gd)$/.test(target) ? undefined : null;
  }

  private ruby(imp: ImportFact, dir: string, project: IndexProject): Target {
    const withRb = (p: string) => (p.endsWith('.rb') ? p : `${p}.rb`);
    if (imp.kind === 'file') {
      const target = withRb(joinPath(dir, imp.source));
      return this.exists(target) ? { files: [target] } : undefined;
    }
    // The lib/ folder the file is in (a gem's load path), its project's, and every gem's.
    const ownLib = /^(.*?\/)?lib(\/|$)/.exec(dir)?.[0].replace(/\/$/, '');
    const roots = [...new Set([...(ownLib !== undefined ? [ownLib] : []), joinPath(project.root, 'lib'), project.root, ...this.projects.filter((p) => p.buildSystems.includes('bundler')).map((p) => joinPath(p.root, 'lib'))])];
    for (const root of roots) {
      const target = withRb(joinPath(root, imp.source));
      if (this.exists(target)) return { files: [target] };
    }
    const gem = imp.source.split('/')[0];
    return RUBY_STDLIB.has(gem) ? null : { external: gem };
  }

  private php(imp: ImportFact, dir: string, project: IndexProject): Target {
    if (imp.kind === 'file') {
      for (const candidate of [joinPath(dir, imp.source), joinPath(project.root, imp.source)]) {
        if (this.exists(candidate)) return { files: [candidate] };
      }
      return undefined;
    }
    const files = this.typeFiles.get(`php:${imp.source}`) ?? this.namespaceFiles.get(`php:${imp.source}`);
    return files ? { files } : { external: imp.source.split('\\')[0] };
  }
}

// Files a JavaScript import may name that aren't code.
const NOT_CODE = /\.(json|jsonc|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|html|txt|md|wasm|node|woff2?|ttf|otf|mp3|wav|mp4|webm|yaml|yml|toml|graphql|gql)(\?.*)?$/i;

// Standard libraries aren't packages: their imports aren't shown.
const PYTHON_STDLIB = new Set(('__future__ abc argparse array ast asyncio base64 binascii bisect builtins calendar cmath collections concurrent contextlib copy csv ctypes dataclasses datetime decimal difflib '
  + 'email enum errno fnmatch fractions functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json keyword logging math mimetypes multiprocessing '
  + 'numbers operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3 ssl stat statistics string struct subprocess sys tempfile textwrap '
  + 'threading time timeit tokenize traceback types typing unicodedata unittest urllib uuid warnings weakref xml zipfile zlib zoneinfo').split(' '));
const NODE_BUILTINS = new Set(('assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path '
  + 'perf_hooks process punycode querystring readline repl stream string_decoder test timers tls trace_events tty url util v8 vm wasi worker_threads zlib').split(' '));
const RUBY_STDLIB = new Set(('base64 benchmark bigdecimal cgi csv date digest erb etc fiber fileutils forwardable io json logger monitor net observer open3 open-uri optparse ostruct pathname '
  + 'pp prettyprint securerandom set shellwords singleton socket stringio strscan tempfile time timeout tmpdir uri weakref yaml zlib').split(' '));
const C_STANDARD_HEADERS = new Set(('assert.h complex.h ctype.h errno.h fenv.h float.h inttypes.h iso646.h limits.h locale.h math.h setjmp.h signal.h stdalign.h stdarg.h stdatomic.h stdbool.h '
  + 'stddef.h stdint.h stdio.h stdlib.h stdnoreturn.h string.h tgmath.h threads.h time.h uchar.h wchar.h wctype.h').split(' '));

// How far apart two files' folders are, in folders.
function distance(dir: string, file: string): number {
  const a = dir ? dir.split('/') : [];
  const b = dirname(file) ? dirname(file).split('/') : [];
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return a.length - common + (b.length - common);
}

// The entity at a line of a file: the innermost type or function there, else the file; a generated
// file's line is its graph's. Undefined for a file the index doesn't have.
export function entityAt(index: CodeIndex, path: string, line: number): string | undefined {
  const generated = index.generated.find((g) => g.path === path);
  if (generated) return generated.shownAs;
  let found: Entity | undefined;
  for (const e of index.entities) {
    if (e.path !== path || (e.kind !== 'type' && e.kind !== 'function') || e.line === undefined || e.endLine === undefined) continue;
    if (e.line <= line && line <= e.endLine && (!found || e.line >= found.line!)) found = e;
  }
  if (found) return found.id;
  return index.entities.some((e) => e.id === `f:${path}`) ? `f:${path}` : undefined;
}
