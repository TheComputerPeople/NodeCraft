// The standard library nodes (docs/code-as-nodes.md, "Standard library nodes"): Unreal's math,
// string, utility and file nodes, implemented for every language pack so graphs stay portable. Each
// node's snippets must behave the same in every language (docs/semantics.md, enforced by the
// conformance suite); where languages differ (rounding, remainders, string lengths, parsing), the
// snippets spell out the rule.
import { NodeDefinition, PinDefinition } from './model';

const input = (id: string, name: string, type: string, defaultValue?: unknown): PinDefinition => ({
  id, name, kind: 'data', direction: 'input', type: { id: type }, ...(defaultValue !== undefined ? { defaultValue } : {})
});
const output = (type: string, name = 'Return Value'): PinDefinition => ({ id: 'returnValue', name, kind: 'data', direction: 'output', type: { id: type } });
const execIn: PinDefinition = { id: 'execIn', name: '', kind: 'exec', direction: 'input' };
const execOut: PinDefinition = { id: 'execOut', name: '', kind: 'exec', direction: 'output' };

interface Snippets {
  javascript: string;
  // When TypeScript needs different code from JavaScript (e.g. type assertions).
  typescript?: string;
  python: string;
  csharp: string;
}

interface Options {
  description: string;
  keywords?: string[];
  // Drawn as a compact node with the symbol in the middle, as Unreal draws operators.
  compact?: boolean;
  // Has exec pins: it runs when execution reaches it (e.g. file I/O).
  impure?: boolean;
}

function node(type: string, displayName: string, category: string, inputs: PinDefinition[], result: PinDefinition | undefined, code: Snippets, options: Options): NodeDefinition {
  const { typescript, ...rest } = code;
  return {
    type, version: 1, displayName, category, description: options.description,
    inputs: [...(options.impure ? [execIn] : []), ...inputs],
    outputs: [...(options.impure ? [execOut] : []), ...(result ? [result] : [])],
    implementation: { kind: 'code', languages: { ...rest, ...(typescript ? { typescript } : {}) } },
    ...(options.keywords ? { keywords: options.keywords } : {}),
    ...(options.compact ? { compact: true } : {})
  };
}

const a = (type = 'float') => input('a', 'A', type, type === 'bool' ? false : 0);
const b = (type = 'float') => input('b', 'B', type, type === 'bool' ? false : 0);

// A binary operator on floats; most are the same expression in every language.
function operator(name: string, symbol: string, code: string | Snippets, keywords: string[], description: string, result = 'float'): NodeDefinition {
  const snippets = typeof code === 'string' ? { javascript: `return ${code};`, python: `return ${code}`, csharp: `return ${code};` } : code;
  return node(`core:math.${name}`, symbol, 'Math', [a(), b()], output(result), snippets, { description, keywords, compact: true });
}

const DIVIDE_BY_ZERO = {
  javascript: 'if (b === 0) throw new Error("Divide by zero");',
  python: 'if b == 0:\n    raise ZeroDivisionError("Divide by zero")',
  csharp: 'if (b == 0) throw new DivideByZeroException("Divide by zero");'
};

// Plain decimal numbers, in each language's regular expression syntax.
const DECIMAL = '^\\s*[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*';
const INTEGER = '^\\s*[+-]?[0-9]+\\s*';

export function standardLibraryDefinitions(): NodeDefinition[] {
  return [
    // ---- Math: operators -----------------------------------------------------------------------
    operator('subtract', '-', 'a - b', ['subtract', 'minus'], 'Subtract B from A.'),
    operator('multiply', '×', 'a * b', ['multiply', 'times', '*'], 'Multiply A by B.'),
    operator('divide', '÷', {
      javascript: `${DIVIDE_BY_ZERO.javascript}\nreturn a / b;`,
      python: `${DIVIDE_BY_ZERO.python}\nreturn a / b`,
      csharp: `${DIVIDE_BY_ZERO.csharp}\nreturn a / b;`
    }, ['divide', '/'], 'Divide A by B. Dividing by zero stops the run with an error.'),
    // The remainder takes the sign of A, as in C++, C# and JavaScript (Python's % follows B).
    operator('modulo', '%', {
      javascript: `${DIVIDE_BY_ZERO.javascript}\nreturn a % b;`,
      python: `${DIVIDE_BY_ZERO.python}\nimport math\nreturn math.fmod(a, b)`,
      csharp: `${DIVIDE_BY_ZERO.csharp}\nreturn a % b;`
    }, ['modulo', 'remainder', 'mod'], 'The remainder of A divided by B, with the sign of A.'),
    operator('less', '<', 'a < b', ['less', 'less than'], 'True if A is less than B.', 'bool'),
    operator('less-equal', '<=', 'a <= b', ['less or equal'], 'True if A is less than or equal to B.', 'bool'),
    operator('greater', '>', 'a > b', ['greater', 'greater than'], 'True if A is greater than B.', 'bool'),
    operator('greater-equal', '>=', 'a >= b', ['greater or equal'], 'True if A is greater than or equal to B.', 'bool'),
    operator('equal', '==', { javascript: 'return a === b;', python: 'return a == b', csharp: 'return a == b;' }, ['equal', 'equals', 'same'], 'True if A equals B.', 'bool'),
    operator('not-equal', '!=', { javascript: 'return a !== b;', python: 'return a != b', csharp: 'return a != b;' }, ['not equal', 'different'], 'True if A does not equal B.', 'bool'),

    // ---- Math: boolean ----------------------------------------------------------------------------
    node('core:math.and', 'AND', 'Math / Boolean', [a('bool'), b('bool')], output('bool'), { javascript: 'return a && b;', python: 'return a and b', csharp: 'return a && b;' }, { description: 'True if both A and B are true.', keywords: ['and', '&&'], compact: true }),
    node('core:math.or', 'OR', 'Math / Boolean', [a('bool'), b('bool')], output('bool'), { javascript: 'return a || b;', python: 'return a or b', csharp: 'return a || b;' }, { description: 'True if A or B is true.', keywords: ['or', '||'], compact: true }),
    node('core:math.not', 'NOT', 'Math / Boolean', [input('a', 'A', 'bool', false)], output('bool'), { javascript: 'return !a;', python: 'return not a', csharp: 'return !a;' }, { description: 'True if A is false.', keywords: ['not', '!', 'invert'], compact: true }),

    // ---- Math: functions ----------------------------------------------------------------------
    node('core:math.min', 'Min', 'Math', [a(), b()], output('float'), { javascript: 'return Math.min(a, b);', python: 'return min(a, b)', csharp: 'return Math.Min(a, b);' }, { description: 'The smaller of A and B.', keywords: ['minimum', 'smallest'] }),
    node('core:math.max', 'Max', 'Math', [a(), b()], output('float'), { javascript: 'return Math.max(a, b);', python: 'return max(a, b)', csharp: 'return Math.Max(a, b);' }, { description: 'The larger of A and B.', keywords: ['maximum', 'largest'] }),
    node('core:math.clamp', 'Clamp', 'Math', [input('value', 'Value', 'float', 0), input('minimum', 'Min', 'float', 0), input('maximum', 'Max', 'float', 1)], output('float'), {
      javascript: 'return Math.min(Math.max(value, minimum), maximum);',
      python: 'return min(max(value, minimum), maximum)',
      csharp: 'return Math.Min(Math.Max(value, minimum), maximum);'
    }, { description: 'Value, kept between Min and Max.', keywords: ['limit', 'range'] }),
    node('core:math.abs', 'Abs', 'Math', [input('value', 'A', 'float', 0)], output('float'), { javascript: 'return Math.abs(value);', python: 'return abs(value)', csharp: 'return Math.Abs(value);' }, { description: 'The absolute value.', keywords: ['absolute'] }),
    // Halves round up (toward positive infinity), as in Unreal's Round and JavaScript's Math.round.
    node('core:math.round', 'Round', 'Math', [input('value', 'A', 'float', 0)], output('int'), {
      javascript: 'return Math.round(value);',
      python: 'import math\nreturn math.floor(value + 0.5)',
      csharp: 'return (int)Math.Floor(value + 0.5);'
    }, { description: 'The nearest whole number; halves round up.', keywords: ['nearest', 'integer'] }),
    node('core:math.floor', 'Floor', 'Math', [input('value', 'A', 'float', 0)], output('int'), {
      javascript: 'return Math.floor(value);', python: 'import math\nreturn math.floor(value)', csharp: 'return (int)Math.Floor(value);'
    }, { description: 'The largest whole number not above A.', keywords: ['round down', 'integer'] }),
    node('core:math.ceil', 'Ceil', 'Math', [input('value', 'A', 'float', 0)], output('int'), {
      javascript: 'return Math.ceil(value);', python: 'import math\nreturn math.ceil(value)', csharp: 'return (int)Math.Ceiling(value);'
    }, { description: 'The smallest whole number not below A.', keywords: ['ceiling', 'round up', 'integer'] }),
    node('core:math.sqrt', 'Sqrt', 'Math', [input('value', 'A', 'float', 0)], output('float'), {
      javascript: 'return Math.sqrt(value);',
      python: 'import math\nreturn math.sqrt(value) if value >= 0 else float("nan")',
      csharp: 'return Math.Sqrt(value);'
    }, { description: 'The square root; NaN for negative numbers.', keywords: ['square root', 'root'] }),
    node('core:math.power', 'Power', 'Math', [input('base', 'Base', 'float', 0), input('exponent', 'Exp', 'float', 1)], output('float'), {
      javascript: 'return base ** exponent;',
      python: 'import math\ntry:\n    return math.pow(base, exponent)\nexcept ValueError:\n    return float("nan")\nexcept OverflowError:\n    return float("inf")',
      // `base` is a C# keyword, so the snippet names the pin.
      csharp: 'return Math.Pow(${base}, exponent);'
    }, { description: 'Base raised to the power Exp.', keywords: ['pow', 'exponent', '^'] }),
    node('core:math.random-float-in-range', 'Random Float in Range', 'Math / Random', [input('minimum', 'Min', 'float', 0), input('maximum', 'Max', 'float', 1)], output('float'), {
      javascript: 'return minimum + Math.random() * (maximum - minimum);',
      python: 'import random\nreturn minimum + random.random() * (maximum - minimum)',
      csharp: 'return minimum + Random.Shared.NextDouble() * (maximum - minimum);'
    }, { description: 'A random number between Min and Max. A new one each time it is read.', keywords: ['random', 'rand'] }),
    node('core:math.random-integer-in-range', 'Random Integer in Range', 'Math / Random', [input('minimum', 'Min', 'int', 0), input('maximum', 'Max', 'int', 10)], output('int'), {
      javascript: 'return minimum + Math.floor(Math.random() * (maximum - minimum + 1));',
      python: 'import random\nreturn random.randint(minimum, maximum)',
      csharp: 'return Random.Shared.Next(minimum, maximum + 1);'
    }, { description: 'A random whole number from Min to Max, both included. A new one each time it is read.', keywords: ['random', 'rand', 'dice'] }),

    // ---- String ---------------------------------------------------------------------------------------
    node('core:string.append', 'Append', 'String', [input('a', 'A', 'string', ''), input('b', 'B', 'string', '')], output('string'), {
      javascript: 'return a + b;', python: 'return a + b', csharp: 'return a + b;'
    }, { description: 'A followed by B.', keywords: ['concatenate', 'join', 'combine', '+'] }),
    // Lengths and positions count characters (code points), as Python does.
    node('core:string.len', 'Len', 'String', [input('text', 'S', 'string', '')], output('int'), {
      javascript: 'return [...text].length;',
      python: 'return len(text)',
      csharp: 'int length = 0;\nforeach (var _ in text.EnumerateRunes()) length++;\nreturn length;'
    }, { description: 'The number of characters.', keywords: ['length', 'size', 'count'] }),
    node('core:string.contains', 'Contains', 'String', [input('text', 'Search In', 'string', ''), input('part', 'Substring', 'string', '')], output('bool'), {
      javascript: 'return text.includes(part);', python: 'return part in text', csharp: 'return text.Contains(part, StringComparison.Ordinal);'
    }, { description: 'True if Search In contains Substring (case-sensitive).', keywords: ['includes', 'find', 'has'] }),
    node('core:string.to-upper', 'To Upper', 'String', [input('text', 'Source String', 'string', '')], output('string'), {
      javascript: 'return text.toUpperCase();', python: 'return text.upper()', csharp: 'return text.ToUpperInvariant();'
    }, { description: 'The text in capital letters.', keywords: ['uppercase', 'capitals'] }),
    node('core:string.to-lower', 'To Lower', 'String', [input('text', 'Source String', 'string', '')], output('string'), {
      javascript: 'return text.toLowerCase();', python: 'return text.lower()', csharp: 'return text.ToLowerInvariant();'
    }, { description: 'The text in small letters.', keywords: ['lowercase'] }),
    node('core:string.trim', 'Trim', 'String', [input('text', 'Source String', 'string', '')], output('string'), {
      javascript: 'return text.trim();', python: 'return text.strip()', csharp: 'return text.Trim();'
    }, { description: 'The text without spaces at either end.', keywords: ['strip', 'whitespace'] }),
    // Every occurrence is replaced; an empty From leaves the text as it is.
    node('core:string.replace', 'Replace', 'String', [input('text', 'Source String', 'string', ''), input('find', 'From', 'string', ''), input('replacement', 'To', 'string', '')], output('string'), {
      javascript: 'return find === "" ? text : text.split(find).join(replacement);',
      python: 'return text if find == "" else text.replace(find, replacement)',
      csharp: 'return find.Length == 0 ? text : text.Replace(find, replacement, StringComparison.Ordinal);'
    }, { description: 'Replaces every From in the text with To.', keywords: ['substitute', 'swap'] }),
    node('core:string.substring', 'Substring', 'String', [input('text', 'Source String', 'string', ''), input('start', 'Start Index', 'int', 0), input('count', 'Length', 'int', 1)], output('string'), {
      javascript: 'const begin = Math.max(0, start);\nreturn [...text].slice(begin, begin + Math.max(0, count)).join("");',
      python: 'begin = max(0, start)\nreturn text[begin:begin + max(0, count)]',
      csharp: [
        'var characters = new List<string>();',
        'foreach (var rune in text.EnumerateRunes()) characters.Add(rune.ToString());',
        'int begin = Math.Max(0, start);',
        'if (begin >= characters.Count) return "";',
        'return string.Concat(characters.GetRange(begin, Math.Min(Math.Max(0, count), characters.Count - begin)));'
      ].join('\n')
    }, { description: 'Length characters of the text, from Start Index (0 is the first).', keywords: ['mid', 'slice', 'part'] }),
    // Only plain decimal numbers convert; anything else is 0, as in Unreal.
    node('core:string.to-float', 'String To Float', 'String', [input('text', 'String', 'string', '')], output('float'), {
      javascript: `return /${DECIMAL}$/.test(text) ? Number(text) : 0;`,
      python: `import re\nreturn float(text) if re.fullmatch(r"${DECIMAL}", text) else 0.0`,
      csharp: `return System.Text.RegularExpressions.Regex.IsMatch(text, @"${DECIMAL}\\z") ? double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture) : 0;`
    }, { description: 'The number the text spells, or 0 if it is not a number.', keywords: ['parse', 'number', 'convert'] }),
    node('core:string.to-int', 'String To Int', 'String', [input('text', 'String', 'string', '')], output('int'), {
      javascript: `return /${INTEGER}$/.test(text) ? Number.parseInt(text, 10) : 0;`,
      python: `import re\nreturn int(text) if re.fullmatch(r"${INTEGER}", text) else 0`,
      csharp: `return System.Text.RegularExpressions.Regex.IsMatch(text, @"${INTEGER}\\z") ? int.Parse(text, NumberStyles.Integer, CultureInfo.InvariantCulture) : 0;`
    }, { description: 'The whole number the text spells, or 0 if it is not one.', keywords: ['parse', 'integer', 'convert'] }),

    // ---- Utilities --------------------------------------------------------------------------------------
    node('core:utilities.is-valid', 'Is Valid', 'Utilities', [input('value', 'Input Object', 'any')], output('bool'), {
      javascript: 'return value !== null && value !== undefined;', python: 'return value is not None', csharp: 'return value is not null;'
    }, { description: 'True if the value is set (not null or None).', keywords: ['null', 'none', 'exists', 'valid'] }),
    node('core:utilities.select', 'Select', 'Utilities', [input('a', 'A', 'any'), input('b', 'B', 'any'), input('pickA', 'Pick A', 'bool', true)], output('any'), {
      javascript: 'return pickA ? a : b;', python: 'return a if pickA else b', csharp: 'return pickA ? a : b;'
    }, { description: 'A if Pick A is true, otherwise B.', keywords: ['choose', 'if', 'ternary', 'pick'] }),

    // ---- File (UFileHelper) -----------------------------------------------------------------------------
    // Paths are relative to the working directory. Failures stop the run with an error.
    node('core:file.load-to-string', 'Load File to String', 'File', [input('filename', 'Filename', 'string', '')], output('string', 'Result'), {
      javascript: 'const fs = /** @type {any} */ (globalThis).process.getBuiltinModule("node:fs");\nreturn fs.readFileSync(filename, "utf8");',
      typescript: 'const fs = (globalThis as any).process.getBuiltinModule("node:fs");\nreturn fs.readFileSync(filename, "utf8") as string;',
      python: 'with open(filename, encoding="utf-8") as f:\n    return f.read()',
      csharp: 'return System.IO.File.ReadAllText(filename, System.Text.Encoding.UTF8);'
    }, { description: 'The contents of a text file (UTF-8). A missing file stops the run with an error.', keywords: ['read', 'open', 'text file'], impure: true }),
    node('core:file.save-string', 'Save String to File', 'File', [input('text', 'String', 'string', ''), input('filename', 'Filename', 'string', '')], undefined, {
      javascript: '/** @type {any} */ (globalThis).process.getBuiltinModule("node:fs").writeFileSync(filename, text, "utf8");',
      typescript: '(globalThis as any).process.getBuiltinModule("node:fs").writeFileSync(filename, text, "utf8");',
      python: 'with open(filename, "w", encoding="utf-8") as f:\n    f.write(text)',
      csharp: 'System.IO.File.WriteAllText(filename, text, new System.Text.UTF8Encoding(false));'
    }, { description: 'Writes the text to a file (UTF-8), replacing it if it exists.', keywords: ['write', 'save', 'text file'], impure: true })
  ];
}
