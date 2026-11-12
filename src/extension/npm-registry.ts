// Blueprint packages on npm (docs/node-authoring.md, gap 9; decided 2026-10-29): a Blueprint
// package is an npm package whose package.json has a `blueprint` field, the folder (relative to
// it) holding its *.vgraph-package.json, and the keyword `blueprint-package` so search finds it.
// Add Blueprint Package searches the registry, downloads a version's tarball and adds the
// package's folder as it adds a local one. The registry is npm's unless an .npmrc names another
// (`registry=`, or `@scope:registry=` for a scope), with its `_authToken`: the user's ~/.npmrc, and
// the workspace's over it when the workspace is trusted (a cloned repository's .npmrc could name
// any server, and a token `${ANY_VARIABLE}` from the environment). A token goes only to its
// registry's own URLs, and only over https (or http to this computer).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
export const BLUEPRINT_KEYWORD = 'blueprint-package';

export interface Registry {
  url: string;
  token?: string;
}

// The most a package may be: its download, and its files unpacked.
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

// The registry for a package name, from .npmrc texts, each over the ones before it (as npm reads
// the user's, then the project's).
export function registryFor(name: string, ...npmrcs: string[]): Registry {
  const settings = new Map<string, string>();
  for (const npmrc of npmrcs) {
    for (const line of npmrc.split(/\r?\n/)) {
      const match = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) settings.set(match[1], match[2]);
    }
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

// The authorization header for a request to `url`: the registry's token, when `url` is under the
// registry (as npm keys tokens, by host and path) and the token wouldn't cross the network in the
// clear. Otherwise none, with why when there was a token to send.
export function authorizationFor(url: string, registry: Registry): { header?: string; withheld?: string } {
  if (!registry.token) return {};
  let target: URL;
  let own: URL;
  try {
    target = new URL(url);
    own = new URL(registry.url);
  } catch {
    return { withheld: `${url} isn't a URL` };
  }
  if (target.protocol !== own.protocol || target.host !== own.host || !target.pathname.startsWith(own.pathname)) return { withheld: `${url} isn't on the registry ${registry.url}` };
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) return { withheld: `the token in .npmrc is only sent over https, and ${registry.url} is ${target.protocol.replace(':', '')}` };
  return { header: `Bearer ${registry.token}` };
}

async function request(url: string, registry: Registry, accept?: string): Promise<Response> {
  const auth = authorizationFor(url, registry);
  const response = await fetch(url, { headers: { ...(accept ? { accept } : {}), ...(auth.header ? { authorization: auth.header } : {}) } });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}${auth.withheld && (response.status === 401 || response.status === 403) ? ` (no token was sent: ${auth.withheld})` : ''}`);
  return response;
}

async function getJson(url: string, registry: Registry): Promise<unknown> {
  return (await request(url, registry, 'application/json')).json();
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

// The package's Blueprint folder in the folder it was unpacked into; never outside it.
export function blueprintFolder(dir: string, blueprint: string): string {
  const folder = path.resolve(dir, blueprint);
  const root = path.resolve(dir);
  if (folder !== root && !folder.startsWith(root + path.sep)) throw new Error(`The package's "blueprint" folder (${blueprint}) is outside the package.`);
  return folder;
}

// Downloads a package's tarball and unpacks it into `dir` (npm's "package/" folder dropped).
// `limits` are for tests.
export async function downloadPackage(registry: Registry, tarball: string, dir: string, limits = { download: MAX_DOWNLOAD_BYTES, unpacked: MAX_UNPACKED_BYTES }): Promise<void> {
  const response = await request(tarball, registry);
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
  const tooBig = `${tarball} is too big: a Blueprint package may be ${mb(limits.download)}, and ${mb(limits.unpacked)} unpacked.`;
  if (Number(response.headers.get('content-length') ?? 0) > limits.download) throw new Error(tooBig);
  const compressed = Buffer.from(await response.arrayBuffer());
  if (compressed.length > limits.download) throw new Error(tooBig);
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: limits.unpacked });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error(tooBig);
    throw error;
  }
  for (const entry of untar(archive)) {
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
