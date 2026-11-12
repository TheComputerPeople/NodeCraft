// Blueprint packages on npm (src/extension/npm-registry.ts, docs/node-authoring.md gap 9): the
// registry an .npmrc names, search, a version's tarball, and unpacking it. A local HTTP server is
// the registry: the tests use no network.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { DEFAULT_REGISTRY, Registry, authorizationFor, blueprintFolder, downloadPackage, packageVersion, registryFor, searchPackages, untar } from '../../src/extension/npm-registry';
import { tar, tarball } from '../tar';

describe('registryFor', () => {
  test('npm unless the .npmrc names another', () => {
    assert.deepEqual(registryFor('combat'), { url: DEFAULT_REGISTRY });
    assert.deepEqual(registryFor('combat', '; a comment\n# another\nregistry = https://npm.example.com/team'), { url: 'https://npm.example.com/team/' });
  });

  test("a scope's registry is for that scope's packages", () => {
    const npmrc = 'registry=https://mirror.example.com/\n@studio:registry=https://npm.studio.example/\n';
    assert.equal(registryFor('@studio/combat', npmrc).url, 'https://npm.studio.example/');
    assert.equal(registryFor('@other/combat', npmrc).url, 'https://mirror.example.com/');
    assert.equal(registryFor('combat', npmrc).url, 'https://mirror.example.com/');
  });

  test("a registry's token, from the environment when it says so", () => {
    process.env.VG_TEST_NPM_TOKEN = 'secret';
    try {
      const npmrc = '@studio:registry=https://npm.studio.example/\n//npm.studio.example/:_authToken=${VG_TEST_NPM_TOKEN}\n//other.example/:_authToken=nope';
      assert.deepEqual(registryFor('@studio/combat', npmrc), { url: 'https://npm.studio.example/', token: 'secret' });
      assert.deepEqual(registryFor('combat', npmrc), { url: DEFAULT_REGISTRY });
    } finally {
      delete process.env.VG_TEST_NPM_TOKEN;
    }
  });

  test("the user's .npmrc, with the workspace's over it", () => {
    const user = 'registry=https://npm.studio.example/\n//npm.studio.example/:_authToken=mine\n';
    assert.deepEqual(registryFor('combat', user, ''), { url: 'https://npm.studio.example/', token: 'mine' });
    assert.deepEqual(registryFor('combat', user, 'registry=https://mirror.example.com/'), { url: 'https://mirror.example.com/' });
  });
});

// A token goes only to its own registry's URLs, never in the clear across the network.
describe('authorizationFor', () => {
  const registry = { url: 'https://npm.studio.example/team/', token: 'abc' };

  test('a URL under the registry gets the token', () => {
    assert.deepEqual(authorizationFor('https://npm.studio.example/team/-/v1/search?text=x', registry), { header: 'Bearer abc' });
    assert.deepEqual(authorizationFor('https://npm.studio.example/team/combat/-/combat-1.0.0.tgz', registry), { header: 'Bearer abc' });
    assert.deepEqual(authorizationFor('https://npm.studio.example/team/x', { url: registry.url }), {});
  });

  test('another host, port, protocol or path gets none', () => {
    for (const url of ['https://evil.example/team/x', 'https://npm.studio.example:8443/team/x', 'http://npm.studio.example/team/x', 'https://npm.studio.example/other/x', 'https://npm.studio.example.evil.example/team/x', 'not a url']) {
      const auth = authorizationFor(url, registry);
      assert.equal(auth.header, undefined, url);
      assert.ok(auth.withheld, url);
    }
  });

  test('plain http only to this computer', () => {
    assert.deepEqual(authorizationFor('http://127.0.0.1:4873/x', { url: 'http://127.0.0.1:4873/', token: 't' }), { header: 'Bearer t' });
    assert.deepEqual(authorizationFor('http://localhost:4873/x', { url: 'http://localhost:4873/', token: 't' }), { header: 'Bearer t' });
    assert.match(authorizationFor('http://npm.corp.example/x', { url: 'http://npm.corp.example/', token: 't' }).withheld ?? '', /only sent over https/);
  });
});

describe('blueprintFolder', () => {
  test("a package's Blueprint folder is inside it", () => {
    const dir = path.join(os.tmpdir(), 'vg-pkg');
    assert.equal(blueprintFolder(dir, 'blueprint/graphs'), path.join(dir, 'blueprint', 'graphs'));
    assert.equal(blueprintFolder(dir, '.'), path.resolve(dir));
    for (const outside of ['..', '../other', 'a/../../b', path.resolve(os.tmpdir(), 'elsewhere')]) assert.throws(() => blueprintFolder(dir, outside), /outside the package/, outside);
  });
});

describe('untar', () => {
  test("a tarball's files, with folders left out and long paths read from pax headers", () => {
    const long = `package/${'deep/'.repeat(25)}combat.vgraph`;
    const files = untar(tar([
      { path: 'package/', type: '5' },
      { path: 'package/package.json', data: '{"name":"combat"}' },
      { path: long, data: 'graph' },
      { path: 'package/empty.txt' }
    ]));
    assert.deepEqual(files.map((f) => [f.path, f.data.toString()]), [['package/package.json', '{"name":"combat"}'], [long, 'graph'], ['package/empty.txt', '']]);
  });
});

describe('a registry', () => {
  let server: http.Server;
  let registry: Registry;
  const requests: { url: string; authorization?: string }[] = [];
  const documents: Record<string, unknown> = {};
  const tarballs: Record<string, Buffer> = {};

  before(async () => {
    server = http.createServer((request, response) => {
      requests.push({ url: request.url!, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
      const url = new URL(request.url!, 'http://localhost');
      if (url.pathname === '/-/v1/search') {
        const text = url.searchParams.get('text') ?? '';
        const objects = text.includes('keywords:blueprint-package') && text.includes('combat') ? [{ package: { name: 'combat-graphs', version: '2.0.0', description: 'Combat nodes' } }, { package: { name: '@studio/combat', version: '0.1.0' } }] : [];
        response.end(JSON.stringify({ objects, total: objects.length }));
      } else if (url.pathname.startsWith('/tarballs/') && tarballs[url.pathname]) {
        response.end(tarballs[url.pathname]);
      } else if (documents[decodeURIComponent(url.pathname.slice(1))]) {
        response.end(JSON.stringify(documents[decodeURIComponent(url.pathname.slice(1))]));
      } else {
        response.statusCode = 404;
        response.end('{"error":"Not found"}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    registry = { url: base, token: 'abc' };
    const version = (v: string, blueprint?: string) => ({ name: 'combat-graphs', version: v, dist: { tarball: `${base}tarballs/combat-${v}.tgz` }, ...(blueprint ? { blueprint } : {}) });
    documents['combat-graphs'] = { name: 'combat-graphs', 'dist-tags': { latest: '2.0.0' }, versions: { '1.0.0': version('1.0.0', 'graphs'), '2.0.0': version('2.0.0', 'blueprint/graphs') } };
    documents['@studio/combat'] = { name: '@studio/combat', 'dist-tags': { latest: '0.1.0' }, versions: { '0.1.0': version('0.1.0') } };
    tarballs['/tarballs/combat-2.0.0.tgz'] = tarball({ 'package.json': '{}', 'blueprint/graphs/combat.vgraph-package.json': '{"name":"combat-graphs"}' });
    tarballs['/tarballs/combat-1.0.0.tgz'] = gzipSync(tar([{ path: 'package/graphs/ok.txt', data: 'ok' }, { path: 'package/../../escaped.txt', data: 'no' }]));
    tarballs['/tarballs/big.tgz'] = gzipSync(tar([{ path: 'package/zeros.bin', data: '\0'.repeat(200000) }]));
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('a token is sent only to its registry', async () => {
    const before = requests.length;
    await assert.rejects(downloadPackage({ url: 'https://npm.studio.example/', token: 'abc' }, `${registry.url}tarballs/none.tgz`, os.tmpdir()), /404/);
    assert.equal(requests.length, before + 1);
    assert.equal(requests[before].authorization, undefined);
  });

  test('search finds the Blueprint packages, sending the token', async () => {
    assert.deepEqual(await searchPackages(registry, 'combat'), [{ name: 'combat-graphs', version: '2.0.0', description: 'Combat nodes' }, { name: '@studio/combat', version: '0.1.0' }]);
    assert.deepEqual(await searchPackages(registry, 'nothing'), []);
    assert.equal(requests.find((r) => r.url.startsWith('/-/v1/search'))?.authorization, 'Bearer abc');
  });

  test("a version's tarball and Blueprint folder, the latest unless one is asked for", async () => {
    assert.deepEqual(await packageVersion(registry, 'combat-graphs'), { version: '2.0.0', tarball: `${registry.url}tarballs/combat-2.0.0.tgz`, blueprint: 'blueprint/graphs' });
    assert.equal((await packageVersion(registry, 'combat-graphs', '1.0.0')).blueprint, 'graphs');
    await assert.rejects(packageVersion(registry, 'combat-graphs', '9.9.9'), /combat-graphs@9\.9\.9 isn't in the registry/);
    await assert.rejects(packageVersion(registry, 'missing'), /404/);
    await assert.rejects(packageVersion(registry, '@studio/combat'), /@studio\/combat@0\.1\.0 isn't a Blueprint package/);
    assert.ok(requests.some((r) => r.url === '/@studio%2fcombat'), "a scoped name's slash is escaped");
  });

  test('a download unpacks without "package/", and nothing outside the folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-npm-'));
    try {
      const unpacked = path.join(dir, 'unpacked');
      await downloadPackage(registry, `${registry.url}tarballs/combat-2.0.0.tgz`, unpacked);
      assert.equal(fs.readFileSync(path.join(unpacked, 'blueprint/graphs/combat.vgraph-package.json'), 'utf8'), '{"name":"combat-graphs"}');
      const other = path.join(dir, 'a', 'b');
      await downloadPackage(registry, `${registry.url}tarballs/combat-1.0.0.tgz`, other);
      assert.equal(fs.readFileSync(path.join(other, 'graphs/ok.txt'), 'utf8'), 'ok');
      assert.ok(!fs.existsSync(path.join(dir, 'a', 'escaped.txt')) && !fs.existsSync(path.join(dir, 'escaped.txt')), 'the escaping entry was skipped');
      await assert.rejects(downloadPackage(registry, `${registry.url}tarballs/none.tgz`, unpacked), /404/);
      // Too big, downloaded or unpacked.
      const big = `${registry.url}tarballs/big.tgz`;
      await assert.rejects(downloadPackage(registry, big, path.join(dir, 'c'), { download: 100, unpacked: 1e9 }), /too big/);
      await assert.rejects(downloadPackage(registry, big, path.join(dir, 'd'), { download: 1e9, unpacked: 100000 }), /too big/);
      assert.ok(!fs.existsSync(path.join(dir, 'd')), 'nothing was unpacked');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
