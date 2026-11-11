// What hovering a box shows (src/core/codemap/hover.ts): a declaration's signature and doc comment,
// read from its file's text, in each language's style.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { declarationSummary } from '../../src/core/codemap/hover';

// The summary of the line marked "<<" (which the mark is removed from).
function at(source: string, language?: string): ReturnType<typeof declarationSummary> {
  const lines = source.split('\n');
  const line = lines.findIndex((l) => l.includes('<<'));
  assert.ok(line >= 0, 'a marked line');
  lines[line] = lines[line].replace(/\s*<<\s*/, '');
  return declarationSummary(lines.join('\n'), line + 1, language);
}

describe('declarationSummary', () => {
  test('TypeScript: a JSDoc block and the head up to its body', () => {
    assert.deepEqual(at([
      '/**',
      ' * Adds two numbers.',
      ' * @param a the first',
      ' */',
      'export function add(a: number, b: number): number { <<',
      '  return a + b;',
      '}'
    ].join('\n'), 'typescript'), { signature: 'export function add(a: number, b: number): number', doc: 'Adds two numbers.\n@param a the first' });
  });

  test('parameters over several lines are joined, and a return type with braces is kept', () => {
    assert.deepEqual(at([
      'function make( <<',
      '  name: string,',
      '  size = 2,',
      '): { name: string; size: number } {',
      '  return { name, size };',
      '}'
    ].join('\n'), 'typescript'), { signature: 'function make(name: string, size = 2,): { name: string; size: number }' });
  });

  test('a doc comment on one line', () => {
    assert.deepEqual(at('/** Doubles a number. */\nexport function doubleIt(n: number): number { <<', 'typescript'), { signature: 'export function doubleIt(n: number): number', doc: 'Doubles a number.' });
    assert.equal(at('/* Not JSDoc, but said. */\nfunction f() { <<', 'javascript')?.doc, 'Not JSDoc, but said.');
  });

  test('an arrow function, a body on one line, and a class', () => {
    assert.equal(at('export const twice = (n: number): number => { <<\n  return n * 2;\n};', 'typescript')?.signature, 'export const twice = (n: number): number');
    assert.equal(at('function one() { return 1; } <<', 'javascript')?.signature, 'function one()');
    assert.equal(at('export class Player extends Actor implements Damageable { <<\n}', 'typescript')?.signature, 'export class Player extends Actor implements Damageable');
  });

  test('Python: decorators skipped, the colon dropped, and the docstring below preferred', () => {
    assert.deepEqual(at([
      '# A comment above',
      '@app.route("/hello")',
      'def hello(name: str = "(you)") -> str: <<',
      '    """Says hello.',
      '',
      '    Twice, if asked.',
      '    """',
      '    return name'
    ].join('\n'), 'python'), { signature: 'def hello(name: str = "(you)") -> str', doc: 'Says hello.\n\nTwice, if asked.' });
    assert.deepEqual(at('class Box(Base): <<\n    \'\'\'A box.\'\'\'\n', 'python'), { signature: 'class Box(Base)', doc: 'A box.' });
    assert.deepEqual(at('# Without a docstring\ndef f(): <<\n    pass', 'python'), { signature: 'def f()', doc: 'Without a docstring' });
  });

  test('C#: /// XML documentation, read as text, above an attribute', () => {
    assert.deepEqual(at([
      '/// <summary>',
      '/// Moves the <see cref="Player"/> by <paramref name="dx"/>.',
      '/// </summary>',
      '/// <param name="dx">how far</param>',
      '[Obsolete]',
      'public void Move(int dx) <<',
      '{'
    ].join('\n'), 'csharp'), { signature: 'public void Move(int dx)', doc: 'Moves the Player by dx.\ndx: how far' });
  });

  test('Rust, Go, Lua, Ruby, GDScript and C++', () => {
    assert.deepEqual(at('/// Parses `Vec<u8>`.\n#[inline]\npub fn parse(bytes: &[u8]) -> Result<Value, Error> { <<', 'rust'), { signature: 'pub fn parse(bytes: &[u8]) -> Result<Value, Error>', doc: 'Parses `Vec<u8>`.' });
    assert.deepEqual(at('// Area of a rectangle.\nfunc (r *Rect) Area() float64 { <<', 'go'), { signature: 'func (r *Rect) Area() float64', doc: 'Area of a rectangle.' });
    assert.deepEqual(at('--- Greets.\n-- @param name who\nfunction M.greet(name) <<\nend', 'lua'), { signature: 'function M.greet(name)', doc: 'Greets.\n@param name who' });
    assert.deepEqual(at('# Says hi\ndef hi(name) <<\nend', 'ruby'), { signature: 'def hi(name)', doc: 'Says hi' });
    assert.deepEqual(at('## Called every frame.\nfunc _process(delta: float) -> void: <<', 'gdscript'), { signature: 'func _process(delta: float) -> void', doc: 'Called every frame.' });
    assert.deepEqual(at('#include <cmath>\nint area(int w, int h) <<\n{', 'cpp'), { signature: 'int area(int w, int h)' }, 'an #include is not a comment');
  });

  test('a comment parted from the declaration by a blank line is not its documentation', () => {
    assert.deepEqual(at('// Something else\n\nfunction f() {} <<', 'javascript'), { signature: 'function f()' });
    assert.equal(at('// -1 means none\nconst NONE = () => -1; <<', 'javascript')?.doc, '-1 means none');
  });

  test('a long doc comment is cut short; a line out of range has nothing', () => {
    const doc = Array.from({ length: 20 }, (_, i) => `// line ${i}`).join('\n');
    const summary = at(`${doc}\nfunction f() { <<\n}`, 'javascript');
    assert.equal(summary?.doc?.split('\n').length, 13);
    assert.ok(summary?.doc?.endsWith('…'));
    assert.equal(declarationSummary('function f() {}', 5), undefined);
    assert.equal(declarationSummary('\n\nfunction f() {}', 1), undefined);
  });
});
