// Node library packages (docs/language-breadth.md, "Node library versioning"): node definitions
// shipped under a name and a semantic version, with the packages they depend on. Packages from the
// workspace (`*.vgraph-package.json` manifests) and from other extensions are resolved together, and
// each graph remembers the version of every package whose nodes it uses, so a new major version
// marks those nodes for Refresh Node, as a project function whose code changed is.
import { GraphDocument, NodeDefinition } from './model';

export interface NodePackageManifest {
  name: string;
  version: string;
  description?: string;
  // The node definition files it holds, relative to the manifest (globs allowed).
  nodes?: string[];
  // The graph files it holds (docs/node-authoring.md, gap 9): function and macro libraries,
  // structures and enumerations, relative to the manifest (globs allowed).
  graphs?: string[];
  // Package names with version ranges ("^1.2.0").
  dependencies?: Record<string, string>;
  // The extension API versions it works with: { "blueprint": "^1" }.
  engines?: { blueprint?: string };
}

export interface NodePackage {
  name: string;
  version: string;
  nodes: NodeDefinition[];
  dependencies?: Record<string, string>;
  engines?: { blueprint?: string };
  // Where it came from, as problems are filed: a manifest's URI, or "extension".
  origin: string;
  // How messages name where it came from (a manifest's relative path); `origin` by default.
  where?: string;
}

export interface PackageProblem {
  origin: string;
  package: string;
  message: string;
}

// A manifest's problems (empty when it can be used).
export function manifestProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['A package manifest must be a JSON object.'];
  const m = value as Partial<NodePackageManifest>;
  const problems: string[] = [];
  if (typeof m.name !== 'string' || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(m.name)) problems.push('"name" must be a package name, such as "math-nodes" or "@studio/math-nodes".');
  if (typeof m.version !== 'string' || !parseVersion(m.version)) problems.push('"version" must be a semantic version, such as "1.2.0".');
  const list = (value: unknown) => Array.isArray(value) && value.every((n) => typeof n === 'string');
  if (m.nodes !== undefined && !list(m.nodes)) problems.push('"nodes" must list the package\'s node definition files.');
  if (m.graphs !== undefined && !list(m.graphs)) problems.push('"graphs" must list the package\'s graph files.');
  if (m.nodes === undefined && m.graphs === undefined) problems.push('A package must list its "nodes" (node definition files), its "graphs" (graph files), or both.');
  for (const [name, range] of Object.entries(m.dependencies ?? {})) if (typeof range !== 'string' || !validRange(range)) problems.push(`The version range for "${name}" isn't valid: ${JSON.stringify(range)}.`);
  if (m.engines?.blueprint !== undefined && !validRange(m.engines.blueprint)) problems.push(`"engines.blueprint" isn't a valid version range: ${JSON.stringify(m.engines.blueprint)}.`);
  return problems;
}

// The node definitions of every package and loose file, each package's tagged with its name and
// version, and what's wrong: a missing dependency or one outside its range, an API version outside
// the package's engines, a package name used twice or a node type defined twice. Problems are
// warnings: the nodes still load. Of two packages with one name, or defining one node type, the
// newer version wins; a package's node wins over a loose file's.
export function resolvePackages(packages: NodePackage[], loose: NodeDefinition[], apiVersion: number): { definitions: NodeDefinition[]; problems: PackageProblem[] } {
  const problems: PackageProblem[] = [];
  const byName = new Map<string, NodePackage>();
  for (const pkg of [...packages].sort((a, b) => compareVersions(b.version, a.version))) {
    const kept = byName.get(pkg.name);
    if (kept) {
      problems.push({ origin: pkg.origin, package: pkg.name, message: `${pkg.name} ${pkg.version} isn't used: ${kept.origin === 'extension' ? 'an extension' : kept.where ?? kept.origin} has version ${kept.version}.` });
      continue;
    }
    byName.set(pkg.name, pkg);
  }
  for (const pkg of byName.values()) {
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      const dependency = byName.get(name);
      if (!dependency) problems.push({ origin: pkg.origin, package: pkg.name, message: `${pkg.name} needs ${name} ${range}, which isn't installed.` });
      else if (!satisfies(dependency.version, range)) problems.push({ origin: pkg.origin, package: pkg.name, message: `${pkg.name} needs ${name} ${range}, but version ${dependency.version} is installed.` });
    }
    if (pkg.engines?.blueprint && !satisfies(`${apiVersion}.0.0`, pkg.engines.blueprint)) {
      problems.push({ origin: pkg.origin, package: pkg.name, message: `${pkg.name} is for Blueprint Visual Scripting API ${pkg.engines.blueprint}, but this extension's API version is ${apiVersion}.` });
    }
  }
  const definitions = new Map<string, NodeDefinition>();
  for (const def of loose) definitions.set(def.type, def);
  // Older packages first, so newer ones replace their nodes.
  for (const pkg of [...byName.values()].sort((a, b) => compareVersions(a.version, b.version) || (a.name < b.name ? -1 : 1))) {
    for (const node of pkg.nodes) {
      const existing = definitions.get(node.type);
      if (existing?.library) {
        problems.push({ origin: pkg.origin, package: pkg.name, message: `${pkg.name} ${pkg.version} and ${existing.library.name} ${existing.library.version} both define ${node.type}; ${pkg.name}'s is used.` });
      }
      definitions.set(node.type, { ...node, library: { name: pkg.name, version: pkg.version } });
    }
  }
  return { definitions: [...definitions.values()], problems };
}

// ---- Graphs remembering versions ---------------------------------------------------------------

// The package versions a document's nodes were made with (metadata.libraries).
export function recordedLibraries(doc: Pick<GraphDocument, 'metadata'>): Record<string, string> {
  const value = doc.metadata?.libraries;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
}

// Whether a node's package changed major version since the graph recorded it.
export function libraryChange(doc: Pick<GraphDocument, 'metadata'>, definition: NodeDefinition | undefined): { name: string; from: string; to: string } | undefined {
  const library = definition?.library;
  if (!library) return undefined;
  const recorded = recordedLibraries(doc)[library.name];
  if (!recorded) return undefined;
  const before = parseVersion(recorded);
  const now = parseVersion(library.version);
  return before && now && before[0] !== now[0] ? { name: library.name, from: recorded, to: library.version } : undefined;
}

export function libraryChangeMessage(change: { name: string; from: string; to: string }): string {
  return `${change.name} is now version ${change.to}, a new major version (this graph was made with ${change.from}). Check the node, then right-click it and choose Refresh Node.`;
}

// Records the version of each package the document's nodes use, when it has none yet, and drops
// packages it no longer uses. A recorded version that differs stays until the nodes are refreshed
// (`refreshLibrary`). Returns whether anything changed.
// A graph package's graph files' definitions, tagged with the package as node files' are, so graphs
// using them record its version and get Refresh Node on a new major version.
export function tagPackageDefinitions(definitions: NodeDefinition[], pkg: { name: string; version: string }): NodeDefinition[] {
  return definitions.map((d) => ({ ...d, library: { name: pkg.name, version: pkg.version } }));
}

export function syncLibraryVersions(doc: GraphDocument, definition: (type: string) => NodeDefinition | undefined): boolean {
  const before = recordedLibraries(doc);
  const next: Record<string, string> = {};
  for (const type of new Set(doc.graphs.flatMap((g) => g.nodes.map((n) => n.type)))) {
    const library = definition(type)?.library;
    if (library) next[library.name] = before[library.name] ?? library.version;
  }
  if (JSON.stringify(next) === JSON.stringify(before)) return false;
  const metadata = { ...(doc.metadata ?? {}) };
  if (Object.keys(next).length) metadata.libraries = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
  else delete metadata.libraries;
  doc.metadata = metadata;
  return true;
}

// After the nodes of a package are refreshed: the graph now uses `version`.
export function refreshLibrary(doc: GraphDocument, name: string, version: string): void {
  doc.metadata = { ...(doc.metadata ?? {}), libraries: { ...recordedLibraries(doc), [name]: version } };
}

// ---- Versions ----------------------------------------------------------------------------------

// [major, minor, patch, prerelease] of a semantic version, or undefined.
export function parseVersion(text: string): [number, number, number, string] | undefined {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''] : undefined;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  // A prerelease comes before its release.
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

// npm's range syntax, as far as packages use it: "*", "1.2.3", "^1.2.3", "~1.2.3", "1.x", "1.2.x",
// comparisons (">=1.0.0 <2.0.0", space-separated, all must hold), and alternatives joined by "||".
export function satisfies(version: string, range: string): boolean {
  if (!parseVersion(version)) return false;
  return range.split('||').some((alternative) => {
    const parts = alternative.trim().split(/\s+/).filter(Boolean);
    return parts.length === 0 || parts.every((part) => comparatorHolds(version, part));
  });
}

function validRange(range: string): boolean {
  return range.split('||').every((alternative) => alternative.trim().split(/\s+/).filter(Boolean).every((part) => comparator(part) !== undefined));
}

function comparatorHolds(version: string, part: string): boolean {
  const c = comparator(part);
  return !!c && c.every(([op, bound]) => {
    const order = compareVersions(version, bound);
    return op === '>=' ? order >= 0 : op === '>' ? order > 0 : op === '<' ? order < 0 : op === '<=' ? order <= 0 : order === 0;
  });
}

// A range part as comparisons with full versions.
function comparator(part: string): [string, string][] | undefined {
  if (part === '*' || part === 'x' || part === 'X') return [];
  const match = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?$/.exec(part);
  if (!match) return undefined;
  const [, op = '', majorText, minorText, patchText, pre = ''] = match;
  const wild = (t: string | undefined) => t === undefined || /^[xX*]$/.test(t);
  if (wild(majorText)) return [];
  const major = Number(majorText);
  const minor = wild(minorText) ? undefined : Number(minorText);
  const patch = wild(patchText) ? undefined : Number(patchText);
  const v = (a: number, b: number, c: number, p = '') => `${a}.${b}.${c}${p}`;
  if (minor === undefined) {
    if (op === '' || op === '=' || op === '^' || op === '~') return [['>=', v(major, 0, 0)], ['<', v(major + 1, 0, 0, '-0')]];
    return [[op, v(major, 0, 0)]];
  }
  if (patch === undefined) {
    if (op === '^' && major > 0) return [['>=', v(major, minor, 0)], ['<', v(major + 1, 0, 0, '-0')]];
    if (op === '' || op === '=' || op === '~' || op === '^') return [['>=', v(major, minor, 0)], ['<', v(major, minor + 1, 0, '-0')]];
    return [[op, v(major, minor, 0)]];
  }
  const exact = v(major, minor, patch, pre);
  if (op === '^') {
    const upper = major > 0 ? v(major + 1, 0, 0, '-0') : minor > 0 ? v(0, minor + 1, 0, '-0') : v(0, 0, patch + 1, '-0');
    return [['>=', exact], ['<', upper]];
  }
  if (op === '~') return [['>=', exact], ['<', v(major, minor + 1, 0, '-0')]];
  return [[op === '' ? '=' : op, exact]];
}
