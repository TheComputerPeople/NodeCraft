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
  const cpp = CPP[type];
  const rust = RUST[type];
  const java = JAVA[type];
  const go = GO[type];
  const lua = LUA[type];
  const gdscript = GDSCRIPT[type];
  const ruby = RUBY[type];
  const php = PHP[type];
  return {
    type, version: 1, displayName, category, description: options.description,
    inputs: [...(options.impure ? [execIn] : []), ...inputs],
    outputs: [...(options.impure ? [execOut] : []), ...(result ? [result] : [])],
    implementation: { kind: 'code', languages: { ...rest, ...(typescript ? { typescript } : {}), ...(cpp ? { cpp } : {}), ...(rust ? { rust } : {}), ...(java ? { java } : {}), ...(go ? { go } : {}), ...(lua ? { lua } : {}), ...(gdscript ? { gdscript } : {}), ...(ruby ? { ruby } : {}), ...(php ? { php } : {}) } },
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

// The C++ snippets (docs/language-breadth.md, "C++"), by node type: the same rules as the others.
// Text is UTF-8, so lengths and positions count code points; To Upper and To Lower change only
// ASCII letters.
const CPP_DIVIDE_BY_ZERO = 'if (b == 0) throw std::runtime_error("Divide by zero");';
const CPP_RANDOM = 'static std::mt19937_64 engine{std::random_device{}()};';
const CPP_CODE_POINTS = 'std::vector<std::string> characters;\nfor (std::size_t i = 0; i < text.size();) {\n    std::size_t length = 1;\n    while (i + length < text.size() && (static_cast<unsigned char>(text[i + length]) & 0xC0) == 0x80) length++;\n    characters.push_back(text.substr(i, length));\n    i += length;\n}';
const CPP: Record<string, string> = {
  'core:math.subtract': 'return a - b;',
  'core:math.multiply': 'return a * b;',
  'core:math.divide': `${CPP_DIVIDE_BY_ZERO}\nreturn a / b;`,
  'core:math.modulo': `${CPP_DIVIDE_BY_ZERO}\nreturn std::fmod(a, b);`,
  'core:math.less': 'return a < b;',
  'core:math.less-equal': 'return a <= b;',
  'core:math.greater': 'return a > b;',
  'core:math.greater-equal': 'return a >= b;',
  'core:math.equal': 'return a == b;',
  'core:math.not-equal': 'return a != b;',
  'core:math.and': 'return a && b;',
  'core:math.or': 'return a || b;',
  'core:math.not': 'return !a;',
  'core:math.min': 'return std::isnan(a) || std::isnan(b) ? NAN : std::min(a, b);',
  'core:math.max': 'return std::isnan(a) || std::isnan(b) ? NAN : std::max(a, b);',
  'core:math.clamp': 'return std::min(std::max(value, minimum), maximum);',
  'core:math.abs': 'return std::fabs(value);',
  'core:math.round': 'return static_cast<long long>(std::floor(value + 0.5));',
  'core:math.floor': 'return static_cast<long long>(std::floor(value));',
  'core:math.ceil': 'return static_cast<long long>(std::ceil(value));',
  'core:math.sqrt': 'return std::sqrt(value);',
  'core:math.power': 'return std::pow(base, exponent);',
  'core:math.random-float-in-range': `${CPP_RANDOM}\nreturn minimum + std::uniform_real_distribution<double>(0.0, 1.0)(engine) * (maximum - minimum);`,
  'core:math.random-integer-in-range': `${CPP_RANDOM}\nreturn std::uniform_int_distribution<long long>(minimum, maximum)(engine);`,
  'core:string.append': 'return a + b;',
  'core:string.len': 'long long length = 0;\nfor (unsigned char c : text) if ((c & 0xC0) != 0x80) length++;\nreturn length;',
  'core:string.contains': 'return text.find(part) != std::string::npos;',
  'core:string.to-upper': 'for (auto& c : text) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));\nreturn text;',
  'core:string.to-lower': 'for (auto& c : text) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));\nreturn text;',
  'core:string.trim': 'auto first = text.find_first_not_of(" \\t\\n\\r\\f\\v");\nif (first == std::string::npos) return "";\nreturn text.substr(first, text.find_last_not_of(" \\t\\n\\r\\f\\v") - first + 1);',
  'core:string.replace': 'if (find.empty()) return text;\nstd::string result;\nstd::size_t at = 0;\nfor (std::size_t next; (next = text.find(find, at)) != std::string::npos; at = next + find.size()) result += text.substr(at, next - at) + replacement;\nreturn result + text.substr(at);',
  'core:string.substring': `${CPP_CODE_POINTS}\nlong long begin = std::max(0LL, start);\nstd::string result;\nfor (long long i = begin; i < static_cast<long long>(characters.size()) && i < begin + std::max(0LL, count); i++) result += characters[i];\nreturn result;`,
  'core:string.to-float': `return std::regex_match(text, std::regex(R"re(${DECIMAL})re")) ? std::stod(text) : 0.0;`,
  'core:string.to-int': `return std::regex_match(text, std::regex(R"re(${INTEGER})re")) ? std::stoll(text) : 0LL;`,
  'core:utilities.is-valid': 'return value.has_value();',
  'core:utilities.select': 'return pickA ? a : b;',
  'core:file.load-to-string': 'std::ifstream file(filename, std::ios::binary);\nif (!file) throw std::runtime_error("Can\'t read " + filename);\nstd::stringstream contents;\ncontents << file.rdbuf();\nreturn contents.str();',
  'core:file.save-string': 'std::ofstream file(filename, std::ios::binary);\nif (!file) throw std::runtime_error("Can\'t write " + filename);\nfile << text;'
};

// The Java snippets, by node type: errors are unchecked exceptions, which stop the run (or fail the
// test). Text is UTF-16, so lengths and positions count code points.
const JAVA_DIVIDE_BY_ZERO = 'if (b == 0) throw new ArithmeticException("Divide by zero");';
const JAVA: Record<string, string> = {
  'core:math.subtract': 'return a - b;',
  'core:math.multiply': 'return a * b;',
  'core:math.divide': `${JAVA_DIVIDE_BY_ZERO}\nreturn a / b;`,
  'core:math.modulo': `${JAVA_DIVIDE_BY_ZERO}\nreturn a % b;`,
  'core:math.less': 'return a < b;',
  'core:math.less-equal': 'return a <= b;',
  'core:math.greater': 'return a > b;',
  'core:math.greater-equal': 'return a >= b;',
  'core:math.equal': 'return a == b;',
  'core:math.not-equal': 'return a != b;',
  'core:math.and': 'return a && b;',
  'core:math.or': 'return a || b;',
  'core:math.not': 'return !a;',
  'core:math.min': 'return Math.min(a, b);',
  'core:math.max': 'return Math.max(a, b);',
  'core:math.clamp': 'return Math.min(Math.max(value, minimum), maximum);',
  'core:math.abs': 'return Math.abs(value);',
  'core:math.round': 'return (long) Math.floor(value + 0.5);',
  'core:math.floor': 'return (long) Math.floor(value);',
  'core:math.ceil': 'return (long) Math.ceil(value);',
  'core:math.sqrt': 'return Math.sqrt(value);',
  'core:math.power': 'return Math.pow(base, exponent);',
  'core:math.random-float-in-range': 'return minimum + Math.random() * (maximum - minimum);',
  'core:math.random-integer-in-range': 'return minimum + (long) Math.floor(Math.random() * (maximum - minimum + 1));',
  'core:string.append': 'return a + b;',
  'core:string.len': 'return text.codePointCount(0, text.length());',
  'core:string.contains': 'return text.contains(part);',
  'core:string.to-upper': 'return text.toUpperCase(java.util.Locale.ROOT);',
  'core:string.to-lower': 'return text.toLowerCase(java.util.Locale.ROOT);',
  'core:string.trim': 'return text.strip();',
  'core:string.replace': 'return find.isEmpty() ? text : text.replace(find, replacement);',
  'core:string.substring': 'int[] characters = text.codePoints().toArray();\nint begin = (int) Math.max(0, start);\nif (begin >= characters.length) return "";\nint end = (int) Math.min(characters.length, begin + Math.max(0, count));\nreturn new String(characters, begin, end - begin);',
  'core:string.to-float': `return java.util.regex.Pattern.matches(${JSON.stringify(DECIMAL)}, text) ? Double.parseDouble(text.strip()) : 0;`,
  'core:string.to-int': `return java.util.regex.Pattern.matches(${JSON.stringify(INTEGER)}, text) ? Long.parseLong(text.strip()) : 0;`,
  'core:utilities.is-valid': 'return value != null;',
  'core:utilities.select': 'return pickA ? a : b;',
  'core:file.load-to-string': 'try {\n    return java.nio.file.Files.readString(java.nio.file.Path.of(filename));\n} catch (java.io.IOException error) {\n    throw new java.io.UncheckedIOException("Can\'t read " + filename, error);\n}',
  'core:file.save-string': 'try {\n    java.nio.file.Files.writeString(java.nio.file.Path.of(filename), text);\n} catch (java.io.IOException error) {\n    throw new java.io.UncheckedIOException("Can\'t write " + filename, error);\n}'
};

// The Go snippets, by node type: errors are panics (VgFail), which stop the run (or fail the test).
// Text is UTF-8, so lengths and positions count runes.
const GO_DIVIDE_BY_ZERO = 'if b == 0 {\n\tVgFail("Divide by zero")\n}';
const GO: Record<string, string> = {
  'core:math.subtract': 'return a - b',
  'core:math.multiply': 'return a * b',
  'core:math.divide': `${GO_DIVIDE_BY_ZERO}\nreturn a / b`,
  'core:math.modulo': `${GO_DIVIDE_BY_ZERO}\nreturn math.Mod(a, b)`,
  'core:math.less': 'return a < b',
  'core:math.less-equal': 'return a <= b',
  'core:math.greater': 'return a > b',
  'core:math.greater-equal': 'return a >= b',
  'core:math.equal': 'return a == b',
  'core:math.not-equal': 'return a != b',
  'core:math.and': 'return a && b',
  'core:math.or': 'return a || b',
  'core:math.not': 'return !a',
  'core:math.min': 'return math.Min(a, b)',
  'core:math.max': 'return math.Max(a, b)',
  'core:math.clamp': 'return math.Min(math.Max(value, minimum), maximum)',
  'core:math.abs': 'return math.Abs(value)',
  'core:math.round': 'return int(math.Floor(value + 0.5))',
  'core:math.floor': 'return int(math.Floor(value))',
  'core:math.ceil': 'return int(math.Ceil(value))',
  'core:math.sqrt': 'return math.Sqrt(value)',
  'core:math.power': 'return math.Pow(base, exponent)',
  'core:math.random-float-in-range': 'return minimum + rand.Float64()*(maximum-minimum)',
  'core:math.random-integer-in-range': 'return minimum + rand.Intn(maximum-minimum+1)',
  'core:string.append': 'return a + b',
  'core:string.len': 'return utf8.RuneCountInString(text)',
  'core:string.contains': 'return strings.Contains(text, part)',
  'core:string.to-upper': 'return strings.ToUpper(text)',
  'core:string.to-lower': 'return strings.ToLower(text)',
  'core:string.trim': 'return strings.TrimSpace(text)',
  'core:string.replace': 'if find == "" {\n\treturn text\n}\nreturn strings.ReplaceAll(text, find, replacement)',
  'core:string.substring': 'characters := []rune(text)\nbegin := max(0, start)\nif begin >= len(characters) {\n\treturn ""\n}\nend := min(len(characters), begin+max(0, count))\nreturn string(characters[begin:end])',
  'core:string.to-float': `if !regexp.MustCompile(${JSON.stringify(`${DECIMAL}$`)}).MatchString(text) {\n\treturn 0\n}\nvalue, _ := strconv.ParseFloat(strings.TrimSpace(text), 64)\nreturn value`,
  'core:string.to-int': `if !regexp.MustCompile(${JSON.stringify(`${INTEGER}$`)}).MatchString(text) {\n\treturn 0\n}\nvalue, _ := strconv.Atoi(strings.TrimSpace(text))\nreturn value`,
  'core:utilities.is-valid': 'return value != nil',
  'core:utilities.select': 'if pickA {\n\treturn a\n}\nreturn b',
  'core:file.load-to-string': 'data, err := os.ReadFile(filename)\nif err != nil {\n\tVgFail("Can\'t read " + filename + ": " + err.Error())\n}\nreturn string(data)',
  'core:file.save-string': 'if err := os.WriteFile(filename, []byte(text), 0o644); err != nil {\n\tVgFail("Can\'t write " + filename + ": " + err.Error())\n}'
};

// The Lua snippets (docs/more-languages.md, "Lua"): errors are error() with the message alone (level
// 0, no position). Text is UTF-8, so lengths and positions use the utf8 library; To Upper, To Lower
// and Trim work on ASCII, as in C++.
const LUA_DIVIDE_BY_ZERO = 'if b == 0 then error("Divide by zero", 0) end';
const LUA: Record<string, string> = {
  'core:math.subtract': 'return a - b',
  'core:math.multiply': 'return a * b',
  'core:math.divide': `${LUA_DIVIDE_BY_ZERO}\nreturn a / b`,
  'core:math.modulo': `${LUA_DIVIDE_BY_ZERO}\nreturn math.fmod(a, b)`,
  'core:math.less': 'return a < b',
  'core:math.less-equal': 'return a <= b',
  'core:math.greater': 'return a > b',
  'core:math.greater-equal': 'return a >= b',
  'core:math.equal': 'return a == b',
  'core:math.not-equal': 'return a ~= b',
  'core:math.and': 'return a and b',
  'core:math.or': 'return a or b',
  'core:math.not': 'return not a',
  // math.min and math.max keep their first argument when the other is NaN; JavaScript gives NaN.
  'core:math.min': 'if a ~= a or b ~= b then return 0 / 0 end\nreturn math.min(a, b)',
  'core:math.max': 'if a ~= a or b ~= b then return 0 / 0 end\nreturn math.max(a, b)',
  'core:math.clamp': 'return math.min(math.max(value, minimum), maximum)',
  'core:math.abs': 'return math.abs(value)',
  'core:math.round': 'return math.floor(value + 0.5)',
  'core:math.floor': 'return math.floor(value)',
  'core:math.ceil': 'return math.ceil(value)',
  'core:math.sqrt': 'return math.sqrt(value)',
  'core:math.power': 'return base ^ exponent',
  'core:math.random-float-in-range': 'return minimum + math.random() * (maximum - minimum)',
  'core:math.random-integer-in-range': 'return math.random(minimum, maximum)',
  'core:string.append': 'return a .. b',
  'core:string.len': 'return utf8.len(text) or #text',
  'core:string.contains': 'return string.find(text, part, 1, true) ~= nil',
  'core:string.to-upper': 'return string.upper(text)',
  'core:string.to-lower': 'return string.lower(text)',
  'core:string.trim': 'return (text:match("^%s*(.-)%s*$"))',
  // gsub reads patterns, so From is escaped (and % in To).
  'core:string.replace': 'if find == "" then return text end\nlocal pattern = find:gsub("[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0")\nlocal result = text:gsub(pattern, (replacement:gsub("%%", "%%%%")))\nreturn result',
  'core:string.substring': 'local characters = vg.chars(text)\nlocal begin = math.max(0, start)\nreturn table.concat(characters, "", begin + 1, math.min(#characters, begin + math.max(0, count)))',
  // Lua's patterns have no alternatives, so the plain decimal number is checked in parts.
  'core:string.to-float': [
    'local trimmed = text:match("^%s*(.-)%s*$")',
    'local mantissa = trimmed:match("^[+-]?([%d%.]+)[eE][+-]?%d+$") or trimmed:match("^[+-]?([%d%.]+)$")',
    'if not mantissa or not (mantissa:match("^%d+%.?%d*$") or mantissa:match("^%.%d+$")) then return 0.0 end',
    'return tonumber(trimmed) + 0.0'
  ].join('\n'),
  'core:string.to-int': 'local digits = text:match("^%s*([+-]?%d+)%s*$")\nif not digits then return 0 end\nreturn tonumber(digits)',
  'core:utilities.is-valid': 'return value ~= nil',
  'core:utilities.select': 'if pickA then return a end\nreturn b',
  'core:file.load-to-string': 'local file, problem = io.open(filename, "rb")\nif not file then error("Can\'t read " .. filename .. ": " .. problem, 0) end\nlocal text = file:read("a")\nfile:close()\nreturn text',
  'core:file.save-string': 'local file, problem = io.open(filename, "wb")\nif not file then error("Can\'t write " .. filename .. ": " .. problem, 0) end\nfile:write(text)\nfile:close()'
};

// The GDScript snippets (docs/more-languages.md, "GDScript"): GDScript has no exceptions, so a
// failure is vg.fail (which returns null for a snippet to return), and generated code returns after
// it. Inputs are typed, so an int given for a float input becomes a float, as in Unreal.
const GD_DIVIDE_BY_ZERO = 'if b == 0:\n\treturn vg.fail("Divide by zero")';
const GDSCRIPT: Record<string, string> = {
  'core:math.subtract': 'return a - b',
  'core:math.multiply': 'return a * b',
  'core:math.divide': `${GD_DIVIDE_BY_ZERO}\nreturn a / b`,
  'core:math.modulo': `${GD_DIVIDE_BY_ZERO}\nreturn fmod(a, b)`,
  'core:math.less': 'return a < b',
  'core:math.less-equal': 'return a <= b',
  'core:math.greater': 'return a > b',
  'core:math.greater-equal': 'return a >= b',
  'core:math.equal': 'return a == b',
  'core:math.not-equal': 'return a != b',
  'core:math.and': 'return a and b',
  'core:math.or': 'return a or b',
  'core:math.not': 'return not a',
  'core:math.min': 'if is_nan(a) or is_nan(b):\n\treturn NAN\nreturn minf(a, b)',
  'core:math.max': 'if is_nan(a) or is_nan(b):\n\treturn NAN\nreturn maxf(a, b)',
  'core:math.clamp': 'if is_nan(value):\n\treturn NAN\nreturn minf(maxf(value, minimum), maximum)',
  'core:math.abs': 'return absf(value)',
  'core:math.round': 'return floori(value + 0.5)',
  'core:math.floor': 'return floori(value)',
  'core:math.ceil': 'return ceili(value)',
  'core:math.sqrt': 'return sqrt(value)',
  'core:math.power': 'return pow(base, exponent)',
  'core:math.random-float-in-range': 'return minimum + randf() * (maximum - minimum)',
  'core:math.random-integer-in-range': 'return randi_range(minimum, maximum)',
  'core:string.append': 'return a + b',
  'core:string.len': 'return text.length()',
  'core:string.contains': 'return text.contains(part)',
  'core:string.to-upper': 'return text.to_upper()',
  'core:string.to-lower': 'return text.to_lower()',
  'core:string.trim': 'return text.strip_edges()',
  'core:string.replace': 'if find.is_empty():\n\treturn text\nreturn text.replace(find, replacement)',
  // `start` is the class's Start method in GDScript, so the pin is named through ${start}.
  'core:string.substring': 'var begin := maxi(0, ${start})\nif begin >= text.length():\n\treturn ""\nreturn text.substr(begin, maxi(0, count))',
  'core:string.to-float': `if RegEx.create_from_string(r${JSON.stringify(`${DECIMAL}$`).replace(/\\\\/g, '\\')}).search(text) == null:\n\treturn 0.0\nreturn text.strip_edges().to_float()`,
  'core:string.to-int': `if RegEx.create_from_string(r${JSON.stringify(`${INTEGER}$`).replace(/\\\\/g, '\\')}).search(text) == null:\n\treturn 0\nvar trimmed := text.strip_edges()\nvar digits := trimmed.trim_prefix("+").trim_prefix("-").to_int()\nreturn -digits if trimmed.begins_with("-") else digits`,
  'core:utilities.is-valid': 'return value != null',
  'core:utilities.select': 'return a if pickA else b',
  'core:file.load-to-string': 'var file := FileAccess.open(filename, FileAccess.READ)\nif file == null:\n\treturn vg.fail("Can\'t read " + filename + ": " + error_string(FileAccess.get_open_error()))\nreturn file.get_as_text()',
  'core:file.save-string': 'var file := FileAccess.open(filename, FileAccess.WRITE)\nif file == null:\n\tvg.fail("Can\'t write " + filename + ": " + error_string(FileAccess.get_open_error()))\n\treturn\nfile.store_string(text)'
};

// The Ruby snippets (docs/more-languages.md, "Ruby"): errors are raised. An Integer divided by an
// Integer is a whole number in Ruby, and % follows the divisor's sign, so Divide and % go through
// Float, % with remainder (the sign of A). Floor of NaN or Infinity would raise, so they pass through.
const RB_DIVIDE_BY_ZERO = 'raise ZeroDivisionError, "Divide by zero" if b == 0';
const RB_NOT_FINITE = 'return value unless value.to_f.finite?';
const RUBY: Record<string, string> = {
  'core:math.subtract': 'return a - b',
  'core:math.multiply': 'return a * b',
  'core:math.divide': `${RB_DIVIDE_BY_ZERO}\nreturn a.to_f / b`,
  'core:math.modulo': `${RB_DIVIDE_BY_ZERO}\nreturn a.to_f.remainder(b)`,
  'core:math.less': 'return a < b',
  'core:math.less-equal': 'return a <= b',
  'core:math.greater': 'return a > b',
  'core:math.greater-equal': 'return a >= b',
  'core:math.equal': 'return a == b',
  'core:math.not-equal': 'return a != b',
  'core:math.and': 'return a && b',
  'core:math.or': 'return a || b',
  'core:math.not': 'return !a',
  'core:math.min': 'return Float::NAN if a.to_f.nan? || b.to_f.nan?\nreturn [a, b].min',
  'core:math.max': 'return Float::NAN if a.to_f.nan? || b.to_f.nan?\nreturn [a, b].max',
  'core:math.clamp': 'return Float::NAN if value.to_f.nan?\nreturn [[value, minimum].max, maximum].min',
  'core:math.abs': 'return value.abs',
  'core:math.round': `${RB_NOT_FINITE}\nreturn (value + 0.5).floor`,
  'core:math.floor': `${RB_NOT_FINITE}\nreturn value.floor`,
  'core:math.ceil': `${RB_NOT_FINITE}\nreturn value.ceil`,
  'core:math.sqrt': 'return value < 0 ? Float::NAN : Math.sqrt(value)',
  // A negative base to a fractional power is a Complex in Ruby; JavaScript gives NaN.
  'core:math.power': 'result = base.to_f**exponent\nreturn result.is_a?(Complex) ? Float::NAN : result',
  'core:math.random-float-in-range': 'return minimum + rand * (maximum - minimum)',
  'core:math.random-integer-in-range': 'return rand(minimum..maximum)',
  'core:string.append': 'return a + b',
  'core:string.len': 'return text.length',
  'core:string.contains': 'return text.include?(part)',
  'core:string.to-upper': 'return text.upcase',
  'core:string.to-lower': 'return text.downcase',
  'core:string.trim': 'return text.strip',
  // gsub's replacement text reads \\1 and \\0; a block's result is used as it is.
  'core:string.replace': 'return text if find.empty?\nreturn text.gsub(find) { replacement }',
  'core:string.substring': 'first = [0, start].max\nreturn "" if first >= text.length\nreturn text[first, [0, count].max]',
  'core:string.to-float': `return text.match?(/\\A${DECIMAL.slice(1)}\\z/) ? text.strip.to_f : 0.0`,
  'core:string.to-int': `return text.match?(/\\A${INTEGER.slice(1)}\\z/) ? text.strip.to_i : 0`,
  'core:utilities.is-valid': 'return !value.nil?',
  'core:utilities.select': 'return pickA ? a : b',
  // Binary reads and writes: Ruby's text mode turns \\n into \\r\\n on Windows.
  'core:file.load-to-string': 'return File.binread(filename).force_encoding(Encoding::UTF_8)',
  'core:file.save-string': 'File.binwrite(filename, text)'
};

// The PHP snippets (docs/more-languages.md, "PHP"): errors are exceptions, text goes through mbstring
// (code points), and == compares as the semantics do (Vg::equal: 1 equals 1.0, nothing else converts).
// Floor of NaN or Infinity can't be an int, so they pass through.
const PHP_DIVIDE_BY_ZERO = "if ($b == 0) {\n    throw new \\DivisionByZeroError('Divide by zero');\n}";
const PHP_NOT_FINITE = 'if (!is_finite((float) $value)) {\n    return $value;\n}';
const PHP: Record<string, string> = {
  'core:math.subtract': 'return $a - $b;',
  'core:math.multiply': 'return $a * $b;',
  'core:math.divide': `${PHP_DIVIDE_BY_ZERO}\nreturn $a / $b;`,
  'core:math.modulo': `${PHP_DIVIDE_BY_ZERO}\nreturn fmod($a, $b);`,
  'core:math.less': 'return $a < $b;',
  'core:math.less-equal': 'return $a <= $b;',
  'core:math.greater': 'return $a > $b;',
  'core:math.greater-equal': 'return $a >= $b;',
  'core:math.equal': 'return Vg::equal($a, $b);',
  'core:math.not-equal': 'return !Vg::equal($a, $b);',
  'core:math.and': 'return $a && $b;',
  'core:math.or': 'return $a || $b;',
  'core:math.not': 'return !$a;',
  'core:math.min': 'if (is_nan((float) $a) || is_nan((float) $b)) {\n    return NAN;\n}\nreturn min($a, $b);',
  'core:math.max': 'if (is_nan((float) $a) || is_nan((float) $b)) {\n    return NAN;\n}\nreturn max($a, $b);',
  'core:math.clamp': 'if (is_nan((float) $value)) {\n    return NAN;\n}\nreturn min(max($value, $minimum), $maximum);',
  'core:math.abs': 'return abs($value);',
  'core:math.round': `${PHP_NOT_FINITE}\nreturn (int) floor($value + 0.5);`,
  'core:math.floor': `${PHP_NOT_FINITE}\nreturn (int) floor($value);`,
  'core:math.ceil': `${PHP_NOT_FINITE}\nreturn (int) ceil($value);`,
  'core:math.sqrt': 'return sqrt($value);',
  'core:math.power': 'return $base ** $exponent;',
  'core:math.random-float-in-range': 'return $minimum + mt_rand() / (mt_getrandmax() + 1) * ($maximum - $minimum);',
  'core:math.random-integer-in-range': 'return random_int($minimum, $maximum);',
  'core:string.append': 'return $a . $b;',
  'core:string.len': "return mb_strlen($text, 'UTF-8');",
  'core:string.contains': 'return str_contains($text, $part);',
  'core:string.to-upper': "return mb_strtoupper($text, 'UTF-8');",
  'core:string.to-lower': "return mb_strtolower($text, 'UTF-8');",
  'core:string.trim': 'return trim($text);',
  'core:string.replace': "return $find === '' ? $text : str_replace($find, $replacement, $text);",
  'core:string.substring': "return mb_substr($text, max(0, $start), max(0, $count), 'UTF-8');",
  'core:string.to-float': `return preg_match('/${DECIMAL}$/D', $text) ? (float) trim($text) : 0.0;`,
  'core:string.to-int': `return preg_match('/${INTEGER}$/D', $text) ? (int) trim($text) : 0;`,
  'core:utilities.is-valid': 'return $value !== null;',
  'core:utilities.select': 'return $pickA ? $a : $b;',
  'core:file.load-to-string': 'return file_get_contents($filename);',
  'core:file.save-string': 'file_put_contents($filename, $text);'
};

// The Rust snippets, by node type: errors are panics, which stop the run (or fail the test).
const RUST_DIVIDE_BY_ZERO = 'if b == 0.0 { panic!("Divide by zero"); }';
const RUST: Record<string, string> = {
  'core:math.subtract': 'return a - b;',
  'core:math.multiply': 'return a * b;',
  'core:math.divide': `${RUST_DIVIDE_BY_ZERO}\nreturn a / b;`,
  'core:math.modulo': `${RUST_DIVIDE_BY_ZERO}\nreturn a % b;`,
  'core:math.less': 'return a < b;',
  'core:math.less-equal': 'return a <= b;',
  'core:math.greater': 'return a > b;',
  'core:math.greater-equal': 'return a >= b;',
  'core:math.equal': 'return a == b;',
  'core:math.not-equal': 'return a != b;',
  'core:math.and': 'return a && b;',
  'core:math.or': 'return a || b;',
  'core:math.not': 'return !a;',
  'core:math.min': 'return if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) };',
  'core:math.max': 'return if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) };',
  'core:math.clamp': 'return value.max(minimum).min(maximum);',
  'core:math.abs': 'return value.abs();',
  'core:math.round': 'return (value + 0.5).floor() as i64;',
  'core:math.floor': 'return value.floor() as i64;',
  'core:math.ceil': 'return value.ceil() as i64;',
  'core:math.sqrt': 'return value.sqrt();',
  'core:math.power': 'return base.powf(exponent);',
  'core:math.random-float-in-range': 'return minimum + vgraph::random() * (maximum - minimum);',
  'core:math.random-integer-in-range': 'return minimum + (vgraph::random() * ((maximum - minimum + 1) as f64)).floor() as i64;',
  'core:string.append': 'return a + &b;',
  'core:string.len': 'return text.chars().count() as i64;',
  'core:string.contains': 'return text.contains(part.as_str());',
  'core:string.to-upper': 'return text.to_uppercase();',
  'core:string.to-lower': 'return text.to_lowercase();',
  'core:string.trim': 'return text.trim().to_string();',
  'core:string.replace': 'return if find.is_empty() { text } else { text.replace(find.as_str(), replacement.as_str()) };',
  'core:string.substring': 'return text.chars().skip(start.max(0) as usize).take(count.max(0) as usize).collect();',
  'core:string.to-float': 'return vgraph::parse_decimal(&text).unwrap_or(0.0);',
  'core:string.to-int': 'return vgraph::parse_integer(&text).unwrap_or(0);',
  'core:utilities.is-valid': 'return value != vgraph::Value::None;',
  'core:utilities.select': 'return if pickA { a } else { b };',
  'core:file.load-to-string': 'return std::fs::read_to_string(&filename).unwrap_or_else(|e| panic!("Can\'t read {}: {}", filename, e));',
  'core:file.save-string': 'std::fs::write(&filename, text).unwrap_or_else(|e| panic!("Can\'t write {}: {}", filename, e));'
};

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
