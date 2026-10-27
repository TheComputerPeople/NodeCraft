// Declarative language packs (src/core/declarative): the template syntax, checking definitions, and
// generating code through templates, with node lines and `unsupported` for what a pack leaves out.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { compileDocument } from '../../src/core/compiler';
import { checkDefinition, declarativePack, loadDeclarativePack, parseTemplate, renderTemplate, TemplateError } from '../../src/core/declarative';
import { LanguagePackRegistry } from '../../src/core/language-pack';
import { NodeRegistry } from '../../src/core/registry';
import { doc, node, readRepoFile, repoRoot, wire } from './helpers';

const render = (source: string, context: Record<string, unknown>) => renderTemplate(parseTemplate(source), context as never);
const MINIJS = JSON.parse(readRepoFile('test/fixtures/declarative/minijs.vgraph-language.json'));

describe('templates', () => {
  test('values, lists with separators, and conditions', () => {
    assert.equal(render('{{name}}({{#each args ", "}}{{this}}{{/each}})', { name: 'f', args: ['a', 'b'] }), 'f(a, b)');
    assert.equal(render('{{#each items}}{{@index}}={{key}};{{/each}}', { items: [{ key: 'x' }, { key: 'y' }] }), '0=x;1=y;');
    assert.equal(render('{{#if a}}yes{{else}}no{{/if}} {{#unless a}}!{{/unless}}', { a: '' }), 'no !');
    assert.equal(render('{{#each list}}{{outer}}{{/each}}', { list: [1, 2], outer: 'o' }), 'oo', 'outer fields are visible inside');
    assert.equal(render('{{a.b}}', { a: { b: 'deep' } }), 'deep');
  });

  test('a block placeholder indents its lines to its column; section lines leave nothing behind', () => {
    const source = 'if (x) {\n    {{> body}}\n}\n{{#if extra}}\nmore\n{{/if}}\nend';
    assert.equal(render(source, { body: 'a();\nif (y) {\n  b();\n}', extra: false }), 'if (x) {\n    a();\n    if (y) {\n      b();\n    }\n}\nend');
    assert.equal(render('start\n  {{> body}}\nend', { body: '' }), 'start\nend', 'an empty block leaves no line');
  });

  test('mistakes are reported', () => {
    assert.throws(() => parseTemplate('{{#if a}}x'), TemplateError);
    assert.throws(() => parseTemplate('{{/each}}'), /without a matching/);
    assert.throws(() => parseTemplate('x {{> body}}'), /alone on its line/);
    assert.throws(() => parseTemplate('{{#if a "x"}}{{/if}}'), /one field/);
    assert.deepEqual([...parseTemplate('{{a}} {{#each b}}{{this}}{{c.d}}{{/each}}').fields].sort(), ['a', 'b', 'c']);
  });
});

describe('declarative pack definitions', () => {
  test('a definition becomes a pack: its file names, capabilities and types', () => {
    const pack = declarativePack(MINIJS);
    assert.equal(pack.id, 'minijs');
    assert.equal(pack.generator!.outputFileName('My Game.vgraph'), 'My Game.vgraph.mini.js');
    assert.equal(pack.generatedFileExtension, '.js');
    assert.equal(pack.capabilities.classes, false);
    assert.deepEqual(pack.capabilities.containers, ['array', 'set', 'map']);
    assert.equal(pack.mapType({ id: 'int', container: 'map', valueType: { id: 'string' } }), 'Map<number, string>');
    assert.deepEqual(pack.generator!.snippetLanguages, ['javascript']);
  });

  test('problems are listed, and a pack claiming what the format can\'t express is refused', () => {
    assert.deepEqual(checkDefinition(42).problems, ['A declarative pack definition must be a JSON object.']);
    const { problems } = loadDeclarativePack({ ...MINIJS, id: 'Bad Id', apiVersion: 99, capabilities: { classes: true }, templates: { file: '{{#if x}}', comment: '//' } });
    assert.ok(problems.some((p) => /"id" must be/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /apiVersion" is 99/.test(p)));
    assert.ok(problems.some((p) => /capabilities.classes" can't be true/.test(p)));
    assert.ok(problems.some((p) => /^file: .*never closed/.test(p)));
    assert.ok(problems.some((p) => /templates.function" is missing/.test(p)));
    assert.throws(() => declarativePack({ ...MINIJS, runner: { run: [] } }), /runner.commands/);
  });
});

describe('generating through templates', () => {
  const compile = (definition: Record<string, unknown>, nodes = [node('s', 'core:event.start'), node('p', 'core:console.print', { 'pin:value': 'hi' })], wires = [wire('s', 'execOut', 'p', 'execIn')]) => {
    const languages = new LanguagePackRegistry([declarativePack(definition as never)]);
    return compileDocument({ ...doc(nodes, wires), name: 'Hello', language: definition.id as string }, { registry: new NodeRegistry(), languages, generate: { sourceFileName: 'Hello.vgraph' } });
  };

  test('each node\'s code starts after its comment, and methods are breaks', () => {
    const result = compile(MINIJS);
    assert.deepEqual(result.diagnostics, []);
    const lines = result.output!.text.split('\n');
    const at = result.output!.nodeLines.find((n) => n.nodeId === 'p')!;
    assert.equal(lines[at.line - 2].trim(), '// Print (p)');
    assert.equal(lines[at.line - 1].trim(), 'console.log("hi");');
    assert.ok(result.output!.codeBreaks!.some((line) => lines[line - 1].trim() === 'start() {'));
    assert.ok(!result.output!.text.includes('\u0001'), 'no marks are left');
    assert.ok(!result.output!.text.includes('function formatValue'), 'support code only when used');
  });

  test('a construct without a template is unsupported on its node, and nothing is generated', () => {
    const { print: _print, ...templates } = MINIJS.templates;
    const result = compile({ ...MINIJS, templates });
    assert.equal(result.output, undefined);
    assert.deepEqual(result.diagnostics.map((d) => [d.code, d.nodeId, d.message]), [['unsupported', 'p', 'Mini JS can\'t express Print yet (its pack has no "print" template).']]);
  });

  test('a pack\'s own snippets implement library nodes that have none in its language', () => {
    const nodes = [node('s', 'core:event.start'), node('sqrt', 'core:math.sqrt', { 'pin:value': 16 }), node('p', 'core:console.print')];
    const wires = [wire('s', 'execOut', 'p', 'execIn'), wire('sqrt', 'returnValue', 'p', 'value')];
    const missing = compile({ ...MINIJS, snippetLanguages: ['nothing'] }, nodes, wires);
    assert.equal(missing.diagnostics[0]?.code, 'missing-snippet');
    const own = compile({ ...MINIJS, snippetLanguages: ['nothing'], snippets: { 'core:math.sqrt': 'return value ** 0.5;' } }, nodes, wires);
    assert.deepEqual(own.diagnostics, []);
    assert.match(own.output!.text, /return value \*\* 0\.5;/);
  });

  test('support code is included once, with the support code it uses', () => {
    const nodes = [node('s', 'core:event.start'), node('p', 'core:console.print', { 'pin:value': null })];
    const helpers = { first: 'function first() { return second(); }', second: 'function second() {}', unused: 'function unused() {}' };
    const result = compile({ ...MINIJS, helpers, templates: { ...MINIJS.templates, 'literal.null': 'first()' } }, nodes);
    const text = result.output!.text;
    assert.equal(text.match(/function first/g)?.length, 1);
    assert.ok(text.indexOf('function first') < text.indexOf('function second'), 'in the definition\'s order');
    assert.ok(!text.includes('function unused'));
    assert.ok(path.isAbsolute(repoRoot));
  });
});
