// Fenced blocks in the user's build files (src/core/output-plan.ts): added once at an anchor, then
// only their lines change.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FencedBlock, findBlock, hasBlock, withBlock } from '../../src/core/output-plan';

const block = (text: string, anchor?: FencedBlock['anchor']): FencedBlock => ({ begin: '# vgraph:begin', end: '# vgraph:end', text, ...(anchor ? { anchor } : {}) });

describe('fenced blocks', () => {
  test('a new block goes at the end, on its own lines', () => {
    assert.equal(withBlock('project(x)', block('include(vgraph.cmake)')), 'project(x)\n# vgraph:begin\ninclude(vgraph.cmake)\n# vgraph:end\n');
    assert.equal(withBlock('', block('a')), '# vgraph:begin\na\n# vgraph:end\n');
  });

  test('or at the start, or after the last line matching its anchor', () => {
    assert.equal(withBlock('b\n', block('a', 'start')), '# vgraph:begin\na\n# vgraph:end\nb\n');
    const text = 'mod a;\nmod b;\n\nfn main() {}\n';
    assert.equal(withBlock(text, block('pub mod x_vgraph;', { after: '^mod ' })), 'mod a;\nmod b;\n# vgraph:begin\npub mod x_vgraph;\n# vgraph:end\n\nfn main() {}\n');
    assert.equal(withBlock('x\n', block('a', { after: '^nothing' })), 'x\n# vgraph:begin\na\n# vgraph:end\n', 'no match: the end');
  });

  test('an existing block keeps its place; only its lines change, with the file\'s line endings', () => {
    const text = 'top\r\n# vgraph:begin\r\nold\r\n# vgraph:end\r\nbottom\r\n';
    assert.equal(withBlock(text, block('one\ntwo')), 'top\r\n# vgraph:begin\r\none\r\ntwo\r\n# vgraph:end\r\nbottom\r\n');
    assert.equal(findBlock(text, block(''))?.inner, 'old\r\n');
    assert.equal(hasBlock(text, block('old')), true);
    assert.equal(hasBlock(text, block('new')), false);
  });
});
