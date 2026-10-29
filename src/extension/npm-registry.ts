// Blueprint packages on npm (docs/node-authoring.md, gap 9; decided 2026-10-29): a Blueprint
// package is an npm package whose package.json has a `blueprint` field, the folder (relative to
// it) holding its *.vgraph-package.json, and the keyword `blueprint-package` so search finds it.
// Add Blueprint Package searches the registry, downloads a version's tarball and adds the
// package's folder as it adds a local one. The registry is npm's unless the workspace's .npmrc
// names another (`registry=`, or `@scope:registry=` for a scope), with its `_authToken`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
export const BLUEPRINT_KEYWORD = 'blueprint-package';

export interface Registry {
  url: string;
  token?: string;
}

// The registry for a package name, from an .npmrc's text.
export function registryFor(name: string, npmrc = ''): Registry {
  const settings = new Map<string, string>();
  for (const line of npmrc.split(/\r?\n/)) {
    const match = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) settings.set(match[1], match[2]);
  }
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
  const raw = (scope && settings.get(`${scope}:registry`)) || settings.get('registry') || DEFAULT_REGISTRY;
  const url = raw.endsWith('/') ? raw : `${raw}/`;
  // Tokens are keyed by the registry without its protocol: //host/path/:_authToken=…
  const key = `${url.replace(/^https?:/, '')}:_authToken`;
  const token = settings.get(key);
  return { url, ...(token ? { token: token.replace(/^\$\{(\w+)\}$/, (_m, env: string) => process.env[env] ?? '') } : {}) };
}

export interface FoundPackage {
  name: string;
  version: string;
  description?: string;
}

async function getJson(url: string, registry: Registry): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json', ...(registry.token ? { authorization: `Bearer ${registry.token}` } : {}) } });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

// Blueprint packages matching the text.
export async function searchPackages(registry: Registry, text: string): Promise<FoundPackage[]> {
  const query = encodeURIComponent(`${text.trim()} keywords:${BLUEPRINT_KEYWORD}`.trim());
  const result = (await getJson(`${registry.url}-/v1/search?text=${query}&size=25`, registry)) as { objects?: { package: FoundPackage }[] };
  return (result.objects ?? []).map((o) => ({ name: o.package.name, version: o.package.version, ...(o.package.description ? { description: o.package.description } : {}) }));
}

// A version's tarball and Blueprint folder (the latest when no version is given).
export async function packageVersion(registry: Registry, name: string, version?: string): Promise<{ version: string; tarball: string; blueprint: string }> {
  const document = (await getJson(`${registry.url}${name.replace('/', '%2f')}`, registry)) as { 'dist-tags'?: Record<string, string>; versions?: Record<string, { dist?: { tarball?: string }; blueprint?: string }> };
  const chosen = version ?? document['dist-tags']?.latest;
  const entry = chosen ? document.versions?.[chosen] : undefined;
  if (!chosen || !entry?.dist?.tarball) throw new Error(`${name}${version ? `@${version}` : ''} isn't in the registry.`);
  if (typeof entry.blueprint !== 'string') throw new Error(`${name}@${chosen} isn't a Blueprint package: its package.json has no "blueprint" field.`);
  return { version: chosen, tarball: entry.dist.tarball, blueprint: entry.blueprint };
}

// Downloads a package's tarball and unpacks it into `dir` (npm's "package/" folder dropped).
export async function downloadPackage(registry: Registry, tarball: string, dir: string): Promise<void> {
  const response = await fetch(tarball, { headers: registry.token ? { authorization: `Bearer ${registry.token}` } : {} });
  if (!response.ok) throw new Error(`${tarball}: ${response.status} ${response.statusText}`);
  for (const entry of untar(gunzipSync(Buffer.from(await response.arrayBuffer())))) {
    const relative = entry.path.replace(/^package\//, '');
    const target = path.resolve(dir, relative);
    // Entries can't write outside the folder.
    if (!target.startsWith(path.resolve(dir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
}

// The files of a tar archive (ustar, with pax headers' long paths).
export function untar(archive: Buffer): { path: string; data: Buffer }[] {
  const files: { path: string; data: Buffer }[] = [];
  const text = (from: number, length: number) => archive.subarray(from, from + length).toString('utf8').replace(/\0.*$/s, '');
  let offset = 0;
  let longPath: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = text(offset, 100);
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(offset + 345, 155);
    const data = archive.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      // A pax header: `length path=value\n` records; its path is the next entry's.
      longPath = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1];
    } else {
      if (type === '0') files.push({ path: longPath ?? (prefix ? `${prefix}/${name}` : name), data: Buffer.from(data) });
      longPath = undefined;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
