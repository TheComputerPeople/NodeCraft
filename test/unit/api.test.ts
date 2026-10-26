// The public API's checks (src/core/api.ts) and the language registry's change events.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, packProblem } from '../../src/core/api';
import { LanguagePackRegistry } from '../../src/core/language-pack';
import { javascriptPack } from '../../src/core/languages/javascript';

describe('public API', () => {
  const pack = { ...javascriptPack, id: 'echo', displayName: 'Echo', apiVersion: API_VERSION };

  test('a pack built for this API version with a free id is accepted', () => {
    assert.equal(packProblem(pack, () => false), undefined);
  });

  test('a pack for another API version, a taken id or a missing part is refused, saying why', () => {
    assert.match(packProblem({ ...pack, apiVersion: 2 }, () => false)!, /built for API version 2, but this extension provides version 1/);
    assert.match(packProblem({ ...pack, apiVersion: undefined }, () => false)!, /API version \(none\)/);
    assert.match(packProblem(pack, (id) => id === 'echo')!, /"echo" is already registered/);
    assert.match(packProblem({ ...pack, mapType: undefined }, () => false)!, /missing displayName, capabilities or mapType/);
  });

  test('the registry tells listeners when packs come and go', () => {
    const registry = new LanguagePackRegistry();
    let changes = 0;
    const listener = registry.onDidChange(() => changes++);
    registry.register(pack);
    registry.unregister('echo');
    registry.unregister('echo');
    listener.dispose();
    registry.register(pack);
    assert.equal(changes, 2);
  });
});
