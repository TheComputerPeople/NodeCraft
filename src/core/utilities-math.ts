// Unreal's math nodes beyond the standard library's (docs/code-as-nodes.md, "More utilities"):
// blending and mapping ranges, signs and wrapping, trigonometry, logarithms, and the boolean and
// random nodes Unreal has. Each is the same expression in every graph language; where a language
// would differ (asin of 2, a log of 0, int division), the snippet spells out Unreal's rule.
import { BOOL, FLOAT, INT, input, Snippets, UtilityNode } from './utility-kit';

// The graph languages, and those whose statements end in a semicolon.
const LANGUAGES = ['javascript', 'python', 'csharp', 'cpp', 'rust', 'java', 'go', 'lua', 'gdscript', 'ruby', 'php'];
const SEMICOLON = new Set(['javascript', 'csharp', 'cpp', 'rust', 'java', 'php']);

// `return` of an expression in every language: `common` unless the language has its own.
function returns(common: string, own: Snippets): Snippets {
  return Object.fromEntries(LANGUAGES.map((language) => [language, `return ${own[language] ?? common}${SEMICOLON.has(language) ? ';' : ''}`]));
}

const float = (id: string, name: string, defaultValue = 0) => input(id, name, FLOAT, defaultValue);
const int = (id: string, name: string, defaultValue = 0) => input(id, name, INT, defaultValue);
const bool = (id: string, name: string) => input(id, name, BOOL, false);
const A = float('value', 'A');

// Ruby's and PHP's integer nodes return a value that isn't finite as it is, as Floor does.
const RB_NOT_FINITE = 'return value unless value.to_f.finite?';
// An int can't hold NaN or an infinity: as Round To says (and Python raises).
const PHP_NOT_FINITE = "if (!is_finite((float) $value)) {\n    throw new \\InvalidArgumentException('Value must be a finite number');\n}";

// Map Range: where Value is between In Range A and B (0 to 1, or beyond), applied to Out Range A
// and B. An empty in range is 1 at or past it and 0 before it, as in Unreal.
function mapRange(clamped: boolean): Snippets {
  return {
    javascript: [
      'const divisor = inRangeB - inRangeA;',
      `${clamped ? 'let' : 'const'} percent = divisor === 0 ? (value >= inRangeB ? 1 : 0) : (value - inRangeA) / divisor;`,
      ...(clamped ? ['percent = Math.min(Math.max(percent, 0), 1);'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA);'
    ].join('\n'),
    python: [
      'divisor = inRangeB - inRangeA',
      'percent = (1.0 if value >= inRangeB else 0.0) if divisor == 0 else (value - inRangeA) / divisor',
      ...(clamped ? ['percent = min(max(percent, 0.0), 1.0)'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA)'
    ].join('\n'),
    csharp: [
      'var divisor = inRangeB - inRangeA;',
      'var percent = divisor == 0 ? (value >= inRangeB ? 1.0 : 0.0) : (value - inRangeA) / divisor;',
      ...(clamped ? ['percent = Math.Min(Math.Max(percent, 0), 1);'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA);'
    ].join('\n'),
    cpp: [
      'double divisor = inRangeB - inRangeA;',
      'double percent = divisor == 0 ? (value >= inRangeB ? 1.0 : 0.0) : (value - inRangeA) / divisor;',
      ...(clamped ? ['percent = std::min(std::max(percent, 0.0), 1.0);'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA);'
    ].join('\n'),
    rust: [
      'let divisor = inRangeB - inRangeA;',
      'let percent = if divisor == 0.0 { if value >= inRangeB { 1.0 } else { 0.0 } } else { (value - inRangeA) / divisor };',
      ...(clamped ? ['let percent = percent.max(0.0).min(1.0);'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA);'
    ].join('\n'),
    java: [
      'double divisor = inRangeB - inRangeA;',
      'double percent = divisor == 0 ? (value >= inRangeB ? 1.0 : 0.0) : (value - inRangeA) / divisor;',
      ...(clamped ? ['percent = Math.min(Math.max(percent, 0), 1);'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA);'
    ].join('\n'),
    go: [
      'divisor := inRangeB - inRangeA',
      'percent := 0.0',
      'if divisor == 0 {',
      '\tif value >= inRangeB {',
      '\t\tpercent = 1',
      '\t}',
      '} else {',
      '\tpercent = (value - inRangeA) / divisor',
      '}',
      ...(clamped ? ['percent = math.Min(math.Max(percent, 0), 1)'] : []),
      'return outRangeA + percent*(outRangeB-outRangeA)'
    ].join('\n'),
    lua: [
      'local divisor = inRangeB - inRangeA',
      'local percent',
      'if divisor == 0 then percent = value >= inRangeB and 1 or 0 else percent = (value - inRangeA) / divisor end',
      ...(clamped ? ['percent = math.min(math.max(percent, 0), 1)'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA)'
    ].join('\n'),
    gdscript: [
      'var divisor = inRangeB - inRangeA',
      'var percent := 0.0',
      'if divisor == 0:',
      '\tpercent = 1.0 if value >= inRangeB else 0.0',
      'else:',
      '\tpercent = float(value - inRangeA) / divisor',
      ...(clamped ? ['percent = clampf(percent, 0.0, 1.0)'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA)'
    ].join('\n'),
    ruby: [
      'divisor = inRangeB - inRangeA',
      'percent = divisor.zero? ? (value >= inRangeB ? 1.0 : 0.0) : (value - inRangeA).fdiv(divisor)',
      ...(clamped ? ['percent = percent.clamp(0.0, 1.0)'] : []),
      'return outRangeA + percent * (outRangeB - outRangeA)'
    ].join('\n'),
    php: [
      '$divisor = $inRangeB - $inRangeA;',
      '$percent = $divisor == 0 ? ($value >= $inRangeB ? 1.0 : 0.0) : ($value - $inRangeA) / $divisor;',
      ...(clamped ? ['$percent = min(max($percent, 0.0), 1.0);'] : []),
      'return $outRangeA + $percent * ($outRangeB - $outRangeA);'
    ].join('\n')
  };
}

// A function of A in every language's math library: Math.sin, math.sin, sin(...).
function unary(js: string, own: Snippets = {}): Snippets {
  const lower = js.toLowerCase();
  const title = js[0].toUpperCase() + js.slice(1);
  return returns('', {
    javascript: `Math.${js}(value)`, python: `math.${js}(value)`, csharp: `Math.${title}(value)`, cpp: `std::${js}(value)`, rust: `value.${js}()`,
    java: `Math.${js}(value)`, go: `math.${title}(value)`, lua: `math.${js}(value)`, gdscript: `${lower}(value)`, ruby: `Math.${js}(value)`, php: `${lower}($value)`,
    ...own
  });
}
const withMath = (snippets: Snippets): Snippets => ({ ...snippets, python: `import math\n${snippets.python}` });

// Asin and Acos take values outside -1 to 1 as the nearest end, as Unreal does (and Godot).
function arc(name: string): Snippets {
  const title = name[0].toUpperCase() + name.slice(1);
  return withMath(returns('', {
    javascript: `Math.${name}(Math.min(Math.max(value, -1), 1))`,
    python: `math.${name}(min(max(value, -1.0), 1.0))`,
    csharp: `Math.${title}(Math.Clamp(value, -1, 1))`,
    cpp: `std::${name}(std::clamp(value, -1.0, 1.0))`,
    rust: `value.max(-1.0).min(1.0).${name}()`,
    java: `Math.${name}(Math.max(-1, Math.min(1, value)))`,
    go: `math.${title}(math.Max(-1, math.Min(1, value)))`,
    lua: `math.${name}(math.min(math.max(value, -1), 1))`,
    gdscript: `${name}(clampf(value, -1.0, 1.0))`,
    ruby: `Math.${name}(value.clamp(-1.0, 1.0))`,
    php: `${name}(max(-1.0, min(1.0, $value)))`
  }));
}

// Logarithms of a value that isn't positive stop the run (languages disagree: -Infinity, NaN, or
// an error of their own).
const POSITIVE: Snippets = {
  javascript: "if (!(value > 0)) throw new Error('Value must be positive');",
  python: 'if not value > 0:\n    raise ValueError("Value must be positive")',
  csharp: 'if (!(value > 0)) throw new ArgumentException("Value must be positive");',
  cpp: 'if (!(value > 0)) throw std::invalid_argument("Value must be positive");',
  rust: 'if !(value > 0.0) { panic!("Value must be positive"); }',
  java: 'if (!(value > 0)) throw new IllegalArgumentException("Value must be positive");',
  go: 'if !(value > 0) {\n\tVgFail("Value must be positive")\n}',
  lua: 'if not (value > 0) then error("Value must be positive", 0) end',
  gdscript: 'if not (value > 0):\n\treturn vg.fail("Value must be positive")',
  ruby: 'raise ArgumentError, "Value must be positive" unless value > 0',
  php: "if (!($value > 0)) {\n    throw new \\InvalidArgumentException('Value must be positive');\n}"
};
// Go's math.Pi is an exact constant, and so is math.Pi / 180: taken as a float64 first, it is
// divided at run time, rounded as the other languages round it.
const GO_PI = 'pi := math.Pi';

const positiveFirst =(snippets: Snippets): Snippets => Object.fromEntries(Object.entries(snippets).map(([language, code]) => [language, `${POSITIVE[language]}\n${code}`]));

export const MATH_UTILITIES: UtilityNode[] = [
  // ---- Blending and ranges ----
  {
    type: 'core:math.lerp', displayName: 'Lerp', category: 'Math', result: FLOAT, keywords: ['interpolate', 'blend', 'mix', 'linear'],
    inputs: [float('a', 'A'), float('b', 'B', 1), float('alpha', 'Alpha', 0.5)],
    description: 'A blended toward B by Alpha: A when Alpha is 0, B when it is 1. Alpha isn\'t clamped, so values beyond 0 to 1 go past A or B.',
    code: returns('a + alpha * (b - a)', { go: 'a + alpha*(b-a)', php: '$a + $alpha * ($b - $a)' })
  },
  {
    type: 'core:math.map-range-clamped', displayName: 'Map Range Clamped', category: 'Math', result: FLOAT, keywords: ['remap', 'scale', 'range', 'normalize', 'clamp'],
    inputs: [float('value', 'Value'), float('inRangeA', 'In Range A'), float('inRangeB', 'In Range B', 10), float('outRangeA', 'Out Range A'), float('outRangeB', 'Out Range B', 1)],
    description: 'Value moved from the in range to the out range, kept inside the out range: Value at In Range A gives Out Range A, at In Range B gives Out Range B.',
    code: mapRange(true)
  },
  {
    type: 'core:math.map-range-unclamped', displayName: 'Map Range Unclamped', category: 'Math', result: FLOAT, keywords: ['remap', 'scale', 'range', 'normalize'],
    inputs: [float('value', 'Value'), float('inRangeA', 'In Range A'), float('inRangeB', 'In Range B', 10), float('outRangeA', 'Out Range A'), float('outRangeB', 'Out Range B', 1)],
    description: 'Value moved from the in range to the out range: Value at In Range A gives Out Range A, at In Range B gives Out Range B, and values outside the in range land outside the out range.',
    code: mapRange(false)
  },

  // ---- Signs, wrapping and parts ----
  {
    type: 'core:math.sign', displayName: 'Sign', category: 'Math', result: FLOAT, keywords: ['sign', 'positive', 'negative', 'direction'],
    inputs: [A],
    description: '1 if A is positive, -1 if it is negative, 0 if it is zero.',
    code: {
      ...returns('value > 0 ? 1 : value < 0 ? -1 : 0', {
        python: '1.0 if value > 0 else -1.0 if value < 0 else 0.0',
        rust: 'if value > 0.0 { 1.0 } else if value < 0.0 { -1.0 } else { 0.0 }',
        lua: 'value > 0 and 1.0 or (value < 0 and -1.0 or 0.0)',
        gdscript: '1.0 if value > 0 else (-1.0 if value < 0 else 0.0)',
        ruby: 'value > 0 ? 1.0 : (value < 0 ? -1.0 : 0.0)',
        php: '$value > 0 ? 1.0 : ($value < 0 ? -1.0 : 0.0)'
      }),
      go: 'if value > 0 {\n\treturn 1\n}\nif value < 0 {\n\treturn -1\n}\nreturn 0'
    }
  },
  {
    type: 'core:math.wrap', displayName: 'Wrap (Integer)', category: 'Math', result: INT, keywords: ['wrap', 'cycle', 'loop', 'around', 'modulo'],
    inputs: [int('value', 'Value'), int('minimum', 'Min'), int('maximum', 'Max', 9)],
    description: 'Value wrapped into Min to Max, both included: one past Max is Min again, and one below Min is Max. Min greater than Max stops the run with an error.',
    code: {
      javascript: "if (minimum > maximum) throw new Error(\"Min can't be greater than Max\");\nconst size = maximum - minimum + 1;\nreturn minimum + (((value - minimum) % size) + size) % size;",
      python: 'if minimum > maximum:\n    raise ValueError("Min can\'t be greater than Max")\nreturn minimum + (value - minimum) % (maximum - minimum + 1)',
      csharp: 'if (minimum > maximum) throw new ArgumentException("Min can\'t be greater than Max");\nvar size = maximum - minimum + 1;\nreturn minimum + ((value - minimum) % size + size) % size;',
      cpp: 'if (minimum > maximum) throw std::invalid_argument("Min can\'t be greater than Max");\nlong long size = maximum - minimum + 1;\nreturn minimum + ((value - minimum) % size + size) % size;',
      rust: 'if minimum > maximum { panic!("Min can\'t be greater than Max"); }\nreturn minimum + (value - minimum).rem_euclid(maximum - minimum + 1);',
      java: 'if (minimum > maximum) throw new IllegalArgumentException("Min can\'t be greater than Max");\nreturn minimum + Math.floorMod(value - minimum, maximum - minimum + 1);',
      go: 'if minimum > maximum {\n\tVgFail("Min can\'t be greater than Max")\n}\nsize := maximum - minimum + 1\nreturn minimum + ((value-minimum)%size+size)%size',
      lua: 'if minimum > maximum then error("Min can\'t be greater than Max", 0) end\nreturn minimum + (value - minimum) % (maximum - minimum + 1)',
      gdscript: 'if minimum > maximum:\n\treturn vg.fail("Min can\'t be greater than Max")\nreturn minimum + posmod(value - minimum, maximum - minimum + 1)',
      ruby: 'raise ArgumentError, "Min can\'t be greater than Max" if minimum > maximum\nreturn minimum + (value - minimum) % (maximum - minimum + 1)',
      php: "if ($minimum > $maximum) {\n    throw new \\InvalidArgumentException(\"Min can't be greater than Max\");\n}\n$size = $maximum - $minimum + 1;\nreturn $minimum + (($value - $minimum) % $size + $size) % $size;"
    }
  },
  {
    type: 'core:math.nearly-equal', displayName: 'Nearly Equal', category: 'Math', result: BOOL, keywords: ['equal', 'approximately', 'tolerance', 'epsilon', 'close'],
    inputs: [float('a', 'A'), float('b', 'B'), float('tolerance', 'Error Tolerance', 0.000001)],
    description: 'True if A and B differ by no more than Error Tolerance. Use it in place of == for numbers that come from arithmetic.',
    code: returns('Math.abs(a - b) <= tolerance', {
      python: 'abs(a - b) <= tolerance', csharp: 'Math.Abs(a - b) <= tolerance', cpp: 'std::fabs(a - b) <= tolerance', rust: '(a - b).abs() <= tolerance',
      go: 'math.Abs(a-b) <= tolerance', lua: 'math.abs(a - b) <= tolerance', gdscript: 'absf(a - b) <= tolerance', ruby: '(a - b).abs <= tolerance', php: 'abs($a - $b) <= $tolerance'
    })
  },
  {
    type: 'core:math.truncate', displayName: 'Truncate', category: 'Math', result: INT, keywords: ['integer', 'whole', 'toward zero', 'drop decimals'],
    inputs: [A],
    description: 'A without its fraction: the whole number toward zero (2.7 gives 2, -2.7 gives -2).',
    code: {
      ...returns('', {
        javascript: 'Math.trunc(value)', csharp: '(int)Math.Truncate(value)', cpp: 'static_cast<long long>(std::trunc(value))', rust: 'value.trunc() as i64',
        java: '(long) value', go: 'int(math.Trunc(value))', lua: 'value >= 0 and math.floor(value) or math.ceil(value)', gdscript: 'int(value)'
      }),
      python: 'import math\nreturn math.trunc(value)',
      ruby: `${RB_NOT_FINITE}\nreturn value.truncate`,
      php: `${PHP_NOT_FINITE}\nreturn (int) $value;`
    }
  },
  {
    type: 'core:math.fraction', displayName: 'Fraction', category: 'Math', result: FLOAT, keywords: ['fractional', 'decimal part', 'frac'],
    inputs: [A],
    description: 'The part of A after the decimal point, with A\'s sign (3.75 gives 0.75, -1.25 gives -0.25).',
    code: withMath(returns('value - Math.trunc(value)', {
      python: 'math.modf(value)[0] if math.isfinite(value) else float("nan")',
      csharp: 'value - Math.Truncate(value)', cpp: 'value - std::trunc(value)', rust: 'value - value.trunc()',
      java: 'value - (value < 0 ? Math.ceil(value) : Math.floor(value))', go: 'value - math.Trunc(value)',
      lua: 'value - (value >= 0 and math.floor(value) or math.ceil(value))', gdscript: 'value - (floorf(value) if value >= 0 else ceilf(value))',
      ruby: 'value.to_f.finite? ? value - value.truncate : Float::NAN', php: '$value - ($value < 0 ? ceil($value) : floor($value))'
    }))
  },

  // ---- Trigonometry (radians) ----
  {
    type: 'core:math.sin', displayName: 'Sin (Radians)', category: 'Math / Trig', result: FLOAT, keywords: ['sine', 'trigonometry', 'angle'],
    inputs: [A], description: 'The sine of A, an angle in radians.', code: withMath(unary('sin'))
  },
  {
    type: 'core:math.cos', displayName: 'Cos (Radians)', category: 'Math / Trig', result: FLOAT, keywords: ['cosine', 'trigonometry', 'angle'],
    inputs: [A], description: 'The cosine of A, an angle in radians.', code: withMath(unary('cos'))
  },
  {
    type: 'core:math.tan', displayName: 'Tan (Radians)', category: 'Math / Trig', result: FLOAT, keywords: ['tangent', 'trigonometry', 'angle'],
    inputs: [A], description: 'The tangent of A, an angle in radians.', code: withMath(unary('tan'))
  },
  {
    type: 'core:math.asin', displayName: 'Asin (Radians)', category: 'Math / Trig', result: FLOAT, keywords: ['arcsine', 'inverse sine', 'trigonometry', 'angle'],
    inputs: [A], description: 'The angle in radians whose sine is A (-π/2 to π/2). A is taken as -1 to 1: values beyond are the nearest end.', code: arc('asin')
  },
  {
    type: 'core:math.acos', displayName: 'Acos (Radians)', category: 'Math / Trig', result: FLOAT, keywords: ['arccosine', 'inverse cosine', 'trigonometry', 'angle'],
    inputs: [A], description: 'The angle in radians whose cosine is A (0 to π). A is taken as -1 to 1: values beyond are the nearest end.', code: arc('acos')
  },
  {
    type: 'core:math.atan', displayName: 'Atan (Radians)', category: 'Math / Trig', result: FLOAT, keywords: ['arctangent', 'inverse tangent', 'trigonometry', 'angle'],
    inputs: [A], description: 'The angle in radians whose tangent is A (-π/2 to π/2).', code: withMath(unary('atan'))
  },
  {
    type: 'core:math.atan2', displayName: 'Atan2 (Radians)', category: 'Math / Trig', result: FLOAT, keywords: ['arctangent', 'angle', 'direction', 'heading', 'trigonometry'],
    inputs: [float('y', 'Y'), float('x', 'X', 1)],
    description: 'The angle in radians from the X axis to the point (X, Y), from -π to π. Unlike Atan of Y / X, it knows which quarter the point is in.',
    code: withMath(returns('', {
      javascript: 'Math.atan2(y, x)', python: 'math.atan2(y, x)', csharp: 'Math.Atan2(y, x)', cpp: 'std::atan2(y, x)', rust: 'y.atan2(x)', java: 'Math.atan2(y, x)',
      go: 'math.Atan2(y, x)', lua: 'math.atan(y, x)', gdscript: 'atan2(y, x)', ruby: 'Math.atan2(y, x)', php: 'atan2($y, $x)'
    }))
  },
  {
    type: 'core:math.degrees-to-radians', displayName: 'Degrees To Radians', category: 'Math / Trig', result: FLOAT, keywords: ['angle', 'convert', 'degrees', 'radians'],
    inputs: [A], description: 'A, an angle in degrees, in radians (180 degrees is π).',
    code: {
      ...withMath(returns('value * (Math.PI / 180)', {
        python: 'value * (math.pi / 180)', cpp: 'value * (3.141592653589793 / 180.0)', rust: 'value * (std::f64::consts::PI / 180.0)',
        lua: 'value * (math.pi / 180)', gdscript: 'value * (PI / 180)', ruby: 'value * (Math::PI / 180)', php: '$value * (M_PI / 180)'
      })),
      go: GO_PI + '\nreturn value * (pi / 180)'
    }
  },
  {
    type: 'core:math.radians-to-degrees', displayName: 'Radians To Degrees', category: 'Math / Trig', result: FLOAT, keywords: ['angle', 'convert', 'degrees', 'radians'],
    inputs: [A], description: 'A, an angle in radians, in degrees (π is 180 degrees).',
    code: {
      ...withMath(returns('value * (180 / Math.PI)', {
        python: 'value * (180 / math.pi)', cpp: 'value * (180.0 / 3.141592653589793)', rust: 'value * (180.0 / std::f64::consts::PI)',
        lua: 'value * (180 / math.pi)', gdscript: 'value * (180 / PI)', ruby: 'value * (180 / Math::PI)', php: '$value * (180 / M_PI)'
      })),
      go: GO_PI + '\nreturn value * (180 / pi)'
    }
  },
  {
    type: 'core:math.pi', displayName: 'Get PI', category: 'Math / Trig', result: FLOAT, keywords: ['pi', 'π', 'constant', 'circle'],
    inputs: [], description: 'π, the ratio of a circle\'s circumference to its diameter (3.141592653589793).',
    code: withMath(returns('Math.PI', {
      python: 'math.pi', cpp: '3.141592653589793', rust: 'std::f64::consts::PI', go: 'math.Pi', lua: 'math.pi', gdscript: 'PI', ruby: 'Math::PI', php: 'M_PI'
    }))
  },

  // ---- Exponents and logarithms ----
  {
    type: 'core:math.exp', displayName: 'Exp', category: 'Math', result: FLOAT, keywords: ['exponential', 'e', 'power'],
    inputs: [A], description: 'e raised to the power A.', code: withMath(unary('exp'))
  },
  {
    type: 'core:math.loge', displayName: 'Loge', category: 'Math', result: FLOAT, keywords: ['ln', 'natural logarithm', 'log'],
    inputs: [A], description: 'The natural logarithm of A (the power e must be raised to, to give A). A must be positive, or the run stops with an error.',
    code: withMath(positiveFirst(unary('log', { rust: 'value.ln()' })))
  },
  {
    type: 'core:math.log', displayName: 'Log', category: 'Math', result: FLOAT, keywords: ['logarithm', 'log10', 'log2', 'base'],
    inputs: [A, float('base', 'Base', 10)],
    description: 'The logarithm of A in Base (the power Base must be raised to, to give A). A must be positive, and Base positive and not 1, or the run stops with an error.',
    code: withMath(positiveFirst({
      javascript: "if (!(base > 0) || base === 1) throw new Error('Base must be positive and not 1');\nreturn Math.log(value) / Math.log(base);",
      python: 'if not base > 0 or base == 1:\n    raise ValueError("Base must be positive and not 1")\nreturn math.log(value) / math.log(base)',
      // `base` is a C# keyword, so the snippet names the pin.
      csharp: 'if (!(${base} > 0) || ${base} == 1) throw new ArgumentException("Base must be positive and not 1");\nreturn Math.Log(value) / Math.Log(${base});',
      cpp: 'if (!(base > 0) || base == 1) throw std::invalid_argument("Base must be positive and not 1");\nreturn std::log(value) / std::log(base);',
      rust: 'if !(base > 0.0) || base == 1.0 { panic!("Base must be positive and not 1"); }\nreturn value.ln() / base.ln();',
      java: 'if (!(base > 0) || base == 1) throw new IllegalArgumentException("Base must be positive and not 1");\nreturn Math.log(value) / Math.log(base);',
      go: 'if !(base > 0) || base == 1 {\n\tVgFail("Base must be positive and not 1")\n}\nreturn math.Log(value) / math.Log(base)',
      lua: 'if not (base > 0) or base == 1 then error("Base must be positive and not 1", 0) end\nreturn math.log(value) / math.log(base)',
      gdscript: 'if not (base > 0) or base == 1:\n\treturn vg.fail("Base must be positive and not 1")\nreturn log(value) / log(base)',
      ruby: 'raise ArgumentError, "Base must be positive and not 1" if !(base > 0) || base == 1\nreturn Math.log(value) / Math.log(base)',
      php: "if (!($base > 0) || $base == 1) {\n    throw new \\InvalidArgumentException('Base must be positive and not 1');\n}\nreturn log($value) / log($base);"
    }))
  },

  // ---- Boolean ----
  {
    type: 'core:math.xor', displayName: 'XOR', category: 'Math / Boolean', result: BOOL, keywords: ['xor', 'exclusive or', '^'], compact: true,
    inputs: [bool('a', 'A'), bool('b', 'B')], description: 'True if exactly one of A and B is true.',
    code: returns('a != b', { javascript: 'a !== b', lua: 'a ~= b', php: '$a !== $b' })
  },
  {
    type: 'core:math.nand', displayName: 'NAND', category: 'Math / Boolean', result: BOOL, keywords: ['nand', 'not and'], compact: true,
    inputs: [bool('a', 'A'), bool('b', 'B')], description: 'True unless both A and B are true.',
    code: returns('!(a && b)', { python: 'not (a and b)', lua: 'not (a and b)', gdscript: 'not (a and b)', php: '!($a && $b)' })
  },
  {
    type: 'core:math.nor', displayName: 'NOR', category: 'Math / Boolean', result: BOOL, keywords: ['nor', 'not or'], compact: true,
    inputs: [bool('a', 'A'), bool('b', 'B')], description: 'True if neither A nor B is true.',
    code: returns('!(a || b)', { python: 'not (a or b)', lua: 'not (a or b)', gdscript: 'not (a or b)', php: '!($a || $b)' })
  },

  // ---- Random ----
  {
    type: 'core:math.random-bool', displayName: 'Random Bool', category: 'Math / Random', result: BOOL, keywords: ['random', 'coin', 'flip', 'chance'],
    inputs: [], description: 'True or false, each half the time. A new one each time it is read.',
    code: {
      ...returns('Math.random() < 0.5', {
        csharp: 'Random.Shared.Next(2) == 0', rust: 'vgraph::random() < 0.5', go: 'rand.Float64() < 0.5', lua: 'math.random() < 0.5', gdscript: 'randf() < 0.5',
        ruby: 'rand < 0.5', php: 'mt_rand(0, 1) === 1'
      }),
      python: 'import random\nreturn random.random() < 0.5',
      cpp: 'static std::mt19937_64 engine{std::random_device{}()};\nreturn std::uniform_int_distribution<int>(0, 1)(engine) == 1;'
    }
  }
];
