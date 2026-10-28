// Unreal's string nodes beyond the standard library's (docs/code-as-nodes.md, "More of Unreal's
// library"): prefixes and suffixes, finding, splitting and joining, repeating, reversing, the ends
// of a string, and checks. Text is counted in code points, as the standard library counts it, and
// comparisons are case-sensitive except Equal, Case Insensitive, which folds ASCII letters only.
import { BOOL, INT, STRING, STRINGS, Snippets, UtilityNode, input, text } from './utility-kit';

// A string's code points, for languages whose strings aren't sequences of them.
const CPP_CHARS = String.raw`std::vector<std::string> chars;
for (std::size_t i = 0; i < text.size();) {
    std::size_t n = 1;
    while (i + n < text.size() && (static_cast<unsigned char>(text[i + n]) & 0xC0) == 0x80) n++;
    chars.push_back(text.substr(i, n));
    i += n;
}`;
const CS_CHARS = 'var chars = text.EnumerateRunes().Select((rune) => rune.ToString()).ToList();';

// Plain decimal numbers: a sign, digits and at most one point, with a digit somewhere.
const NUMERIC = '^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)$';

const EMPTY_DELIMITER: Snippets = {
  javascript: "if (delimiter === '') throw new Error(\"Delimiter can't be empty\");",
  python: 'if delimiter == "":\n    raise ValueError("Delimiter can\'t be empty")',
  csharp: 'if (delimiter.Length == 0) throw new ArgumentException("Delimiter can\'t be empty");',
  cpp: 'if (delimiter.empty()) throw std::invalid_argument("Delimiter can\'t be empty");',
  rust: 'if delimiter.is_empty() { panic!("Delimiter can\'t be empty"); }',
  java: 'if (delimiter.isEmpty()) throw new IllegalArgumentException("Delimiter can\'t be empty");',
  go: 'if delimiter == "" {\n\tVgFail("Delimiter can\'t be empty")\n}',
  lua: 'if delimiter == "" then error("Delimiter can\'t be empty", 0) end',
  gdscript: 'if delimiter.is_empty():\n\treturn vg.fail("Delimiter can\'t be empty")',
  ruby: 'raise ArgumentError, "Delimiter can\'t be empty" if delimiter.empty?',
  php: "if ($delimiter === '') {\n    throw new \\InvalidArgumentException(\"Delimiter can't be empty\");\n}"
};

const NEGATIVE_COUNT: Snippets = {
  javascript: "if (count < 0) throw new Error(\"Count can't be negative\");",
  python: 'if count < 0:\n    raise ValueError("Count can\'t be negative")',
  csharp: 'if (count < 0) throw new ArgumentException("Count can\'t be negative");',
  cpp: 'if (count < 0) throw std::invalid_argument("Count can\'t be negative");',
  rust: 'if count < 0 { panic!("Count can\'t be negative"); }',
  java: 'if (count < 0) throw new IllegalArgumentException("Count can\'t be negative");',
  go: 'if count < 0 {\n\tVgFail("Count can\'t be negative")\n}',
  lua: 'if count < 0 then error("Count can\'t be negative", 0) end',
  gdscript: 'if count < 0:\n\treturn vg.fail("Count can\'t be negative")',
  ruby: 'raise ArgumentError, "Count can\'t be negative" if count < 0',
  php: "if ($count < 0) {\n    throw new \\InvalidArgumentException(\"Count can't be negative\");\n}"
};

const after = (first: Snippets, then: Snippets): Snippets => Object.fromEntries(Object.entries(then).map(([language, code]) => [language, `${first[language]}\n${code}`]));

export const STRING_UTILITIES: UtilityNode[] = [
  {
    type: 'core:string.starts-with', displayName: 'Starts With', category: 'String', result: BOOL, keywords: ['prefix', 'begins', 'starts'],
    inputs: [text(), input('prefix', 'Prefix', STRING, '')], description: 'True if the text begins with Prefix (case-sensitive).',
    code: {
      javascript: 'return text.startsWith(prefix);', python: 'return text.startswith(prefix)', csharp: 'return text.StartsWith(prefix, StringComparison.Ordinal);',
      cpp: 'return text.starts_with(prefix);', rust: 'return text.starts_with(prefix.as_str());', java: 'return text.startsWith(prefix);', go: 'return strings.HasPrefix(text, prefix)',
      lua: 'return text:sub(1, #prefix) == prefix', gdscript: 'return text.begins_with(prefix)', ruby: 'return text.start_with?(prefix)', php: 'return str_starts_with($text, $prefix);'
    }
  },
  {
    type: 'core:string.ends-with', displayName: 'Ends With', category: 'String', result: BOOL, keywords: ['suffix', 'ends', 'extension'],
    inputs: [text(), input('suffix', 'Suffix', STRING, '')], description: 'True if the text ends with Suffix (case-sensitive).',
    code: {
      javascript: 'return text.endsWith(suffix);', python: 'return text.endswith(suffix)', csharp: 'return text.EndsWith(suffix, StringComparison.Ordinal);',
      cpp: 'return text.ends_with(suffix);', rust: 'return text.ends_with(suffix.as_str());', java: 'return text.endsWith(suffix);', go: 'return strings.HasSuffix(text, suffix)',
      lua: 'return suffix == "" or text:sub(-#suffix) == suffix', gdscript: 'return text.ends_with(suffix)', ruby: 'return text.end_with?(suffix)', php: 'return str_ends_with($text, $suffix);'
    }
  },
  {
    type: 'core:string.find-substring', displayName: 'Find Substring', category: 'String', result: INT, keywords: ['index of', 'last index of', 'search', 'position', 'find'],
    inputs: [text('text', 'Search In'), input('part', 'Substring', STRING, ''), input('searchFromEnd', 'Search From End', BOOL, false)],
    description: 'The position (in characters, 0 for the first) where Substring first appears in Search In, or last appears with Search From End; -1 if it doesn\'t. Case-sensitive. An empty Substring is found at the start, or at the end from the end.',
    code: {
      javascript: 'const at = searchFromEnd ? text.lastIndexOf(part) : text.indexOf(part);\nreturn at < 0 ? -1 : [...text.slice(0, at)].length;',
      python: 'return text.rfind(part) if searchFromEnd else text.find(part)',
      csharp: [
        'if (part.Length == 0) return searchFromEnd ? text.EnumerateRunes().Count() : 0;',
        'var at = searchFromEnd ? text.LastIndexOf(part, StringComparison.Ordinal) : text.IndexOf(part, StringComparison.Ordinal);',
        'return at < 0 ? -1 : text.Substring(0, at).EnumerateRunes().Count();'
      ].join('\n'),
      cpp: [
        'auto at = searchFromEnd ? text.rfind(part) : text.find(part);',
        'if (at == std::string::npos) return -1;',
        'long long index = 0;',
        'for (std::size_t i = 0; i < at; i++) if ((static_cast<unsigned char>(text[i]) & 0xC0) != 0x80) index++;',
        'return index;'
      ].join('\n'),
      rust: 'let found = if searchFromEnd { text.rfind(part.as_str()) } else { text.find(part.as_str()) };\nreturn match found { Some(at) => text[..at].chars().count() as i64, None => -1 };',
      java: 'int at = searchFromEnd ? text.lastIndexOf(part) : text.indexOf(part);\nreturn at < 0 ? -1 : text.codePointCount(0, at);',
      go: 'at := strings.Index(text, part)\nif searchFromEnd {\n\tat = strings.LastIndex(text, part)\n}\nif at < 0 {\n\treturn -1\n}\nreturn utf8.RuneCountInString(text[:at])',
      lua: [
        'local at',
        'if searchFromEnd then',
        '  local from = 1',
        '  while true do',
        '    local found = string.find(text, part, from, true)',
        '    if not found then break end',
        '    at = found',
        '    from = found + 1',
        '  end',
        'else',
        '  at = string.find(text, part, 1, true)',
        'end',
        'if not at then return -1 end',
        'return utf8.len(text:sub(1, at - 1))'
      ].join('\n'),
      gdscript: 'if part.is_empty():\n\treturn text.length() if searchFromEnd else 0\nreturn text.rfind(part) if searchFromEnd else text.find(part)',
      ruby: 'return (searchFromEnd ? text.rindex(part) : text.index(part)) || -1',
      php: "if ($part === '') {\n    return $searchFromEnd ? mb_strlen($text) : 0;\n}\n$at = $searchFromEnd ? mb_strrpos($text, $part) : mb_strpos($text, $part);\nreturn $at === false ? -1 : $at;"
    }
  },
  {
    type: 'core:string.parse-into-array', displayName: 'Parse Into Array', category: 'String', result: STRINGS, keywords: ['split', 'explode', 'tokenize', 'separate'],
    inputs: [text('text', 'Source String'), input('delimiter', 'Delimiter', STRING, ' '), input('cullEmpty', 'Cull Empty Strings', BOOL, true)],
    description: 'The parts of the text between each Delimiter, in order. With Cull Empty Strings, empty parts (from delimiters side by side, or at either end) are left out. An empty Delimiter stops the run with an error.',
    code: after(EMPTY_DELIMITER, {
      javascript: "const parts = text.split(delimiter);\nreturn cullEmpty ? parts.filter((part) => part !== '') : parts;",
      python: 'parts = text.split(delimiter)\nreturn [part for part in parts if part != ""] if cullEmpty else parts',
      csharp: 'return text.Split(delimiter, cullEmpty ? StringSplitOptions.RemoveEmptyEntries : StringSplitOptions.None).ToList();',
      cpp: [
        'std::vector<std::string> parts;',
        'std::size_t at = 0;',
        'for (std::size_t next; (next = text.find(delimiter, at)) != std::string::npos; at = next + delimiter.size()) parts.push_back(text.substr(at, next - at));',
        'parts.push_back(text.substr(at));',
        'if (cullEmpty) std::erase(parts, std::string());',
        'return parts;'
      ].join('\n'),
      rust: 'return text.split(delimiter.as_str()).filter(|part| !cullEmpty || !part.is_empty()).map(String::from).collect();',
      java: 'var parts = new java.util.ArrayList<>(java.util.Arrays.asList(text.split(java.util.regex.Pattern.quote(delimiter), -1)));\nif (cullEmpty) parts.removeIf(String::isEmpty);\nreturn parts;',
      go: 'parts := strings.Split(text, delimiter)\nif cullEmpty {\n\tparts = slices.DeleteFunc(parts, func(part string) bool { return part == "" })\n}\nreturn &parts',
      lua: [
        'local parts, at = {}, 1',
        'while true do',
        '  local from, to = string.find(text, delimiter, at, true)',
        '  if not from then break end',
        '  parts[#parts + 1] = text:sub(at, from - 1)',
        '  at = to + 1',
        'end',
        'parts[#parts + 1] = text:sub(at)',
        'local kept = {}',
        'for _, part in ipairs(parts) do',
        '  if not cullEmpty or part ~= "" then kept[#kept + 1] = part end',
        'end',
        'return vg.array_of(kept)'
      ].join('\n'),
      gdscript: 'return Array(text.split(delimiter, not cullEmpty))',
      // Not split(" "), which Ruby takes as runs of whitespace; "" splits into no parts at all.
      ruby: 'parts = text.empty? ? [""] : text.split(Regexp.new(Regexp.escape(delimiter)), -1)\nreturn cullEmpty ? parts.reject(&:empty?) : parts',
      php: "$parts = explode($delimiter, $text);\nreturn new VgList($cullEmpty ? array_values(array_filter($parts, fn ($part) => $part !== '')) : $parts);"
    })
  },
  {
    type: 'core:string.join', displayName: 'Join String Array', category: 'String', result: STRING, keywords: ['join', 'implode', 'combine', 'concatenate'],
    inputs: [input('items', 'Source Array', STRINGS), input('separator', 'Separator', STRING, ' ')],
    description: 'The strings in order, with Separator between each two.',
    code: {
      javascript: 'return items.join(separator);', python: 'return separator.join(items)', csharp: 'return string.Join(separator, items);',
      cpp: 'std::string result;\nfor (std::size_t i = 0; i < items.size(); i++) result += (i ? separator : "") + items[i];\nreturn result;',
      rust: 'return items.join(separator.as_str());', java: 'return String.join(separator, items);', go: 'return strings.Join(*items, separator)',
      lua: 'return table.concat(items, separator, 1, items.n)', gdscript: 'return separator.join(PackedStringArray(items))', ruby: 'return items.join(separator)',
      php: 'return implode($separator, $items->items);'
    }
  },
  {
    type: 'core:string.repeat', displayName: 'Repeat', category: 'String', result: STRING, keywords: ['repeat', 'times', 'duplicate'],
    inputs: [text(), input('count', 'Count', INT, 2)], description: 'The text Count times over. A negative Count stops the run with an error.',
    code: after(NEGATIVE_COUNT, {
      javascript: 'return text.repeat(count);', python: 'return text * count', csharp: 'return string.Concat(Enumerable.Repeat(text, count));',
      cpp: 'std::string result;\nfor (long long i = 0; i < count; i++) result += text;\nreturn result;', rust: 'return text.repeat(count as usize);',
      java: 'return text.repeat((int) count);', go: 'return strings.Repeat(text, count)', lua: 'return string.rep(text, count)', gdscript: 'return text.repeat(count)',
      ruby: 'return text * count', php: 'return str_repeat($text, $count);'
    })
  },
  {
    type: 'core:string.reverse', displayName: 'Reverse', category: 'String', result: STRING, keywords: ['reverse', 'backwards', 'flip'],
    inputs: [text()], description: 'The text\'s characters in reverse order.',
    code: {
      javascript: "return [...text].reverse().join('');", python: 'return text[::-1]', csharp: `${CS_CHARS}\nchars.Reverse();\nreturn string.Concat(chars);`,
      cpp: `${CPP_CHARS}\nstd::string result;\nfor (auto it = chars.rbegin(); it != chars.rend(); ++it) result += *it;\nreturn result;`,
      rust: 'return text.chars().rev().collect();', java: 'return new StringBuilder(text).reverse().toString();',
      go: 'runes := []rune(text)\nslices.Reverse(runes)\nreturn string(runes)',
      lua: 'local chars, reversed = vg.chars(text), {}\nfor i = #chars, 1, -1 do reversed[#reversed + 1] = chars[i] end\nreturn table.concat(reversed)',
      gdscript: 'return text.reverse()', ruby: 'return text.reverse', php: "return implode('', array_reverse(mb_str_split($text)));"
    }
  },
  {
    type: 'core:string.left', displayName: 'Left', category: 'String', result: STRING, keywords: ['first', 'start', 'beginning', 'prefix', 'head'],
    inputs: [text('text', 'Source String'), input('count', 'Count', INT, 1)], description: 'The first Count characters of the text (all of it if it is shorter; none for a negative Count).',
    code: {
      javascript: "return [...text].slice(0, Math.max(0, count)).join('');", python: 'return text[:max(0, count)]',
      csharp: `${CS_CHARS}\nreturn string.Concat(chars.Take(Math.Max(0, count)));`,
      cpp: `${CPP_CHARS}\nstd::string result;\nfor (long long i = 0; i < count && i < static_cast<long long>(chars.size()); i++) result += chars[i];\nreturn result;`,
      rust: 'return text.chars().take(count.max(0) as usize).collect();',
      java: 'int length = text.codePointCount(0, text.length());\nint n = (int) Math.min(Math.max(0, count), length);\nreturn text.substring(0, text.offsetByCodePoints(0, n));',
      go: 'runes := []rune(text)\nreturn string(runes[:min(max(count, 0), len(runes))])',
      lua: 'local chars = vg.chars(text)\nreturn table.concat(chars, "", 1, math.min(math.max(count, 0), #chars))',
      gdscript: 'return text.left(mini(maxi(count, 0), text.length()))', ruby: 'return text[0, [count, 0].max]', php: 'return mb_substr($text, 0, max(0, $count));'
    }
  },
  {
    type: 'core:string.right', displayName: 'Right', category: 'String', result: STRING, keywords: ['last', 'end', 'suffix', 'tail'],
    inputs: [text('text', 'Source String'), input('count', 'Count', INT, 1)], description: 'The last Count characters of the text (all of it if it is shorter; none for a negative Count).',
    code: {
      javascript: "const chars = [...text];\nreturn chars.slice(chars.length - Math.min(Math.max(0, count), chars.length)).join('');",
      python: 'n = min(max(0, count), len(text))\nreturn text[len(text) - n:]',
      csharp: `${CS_CHARS}\nreturn string.Concat(chars.Skip(chars.Count - Math.Min(Math.Max(0, count), chars.Count)));`,
      cpp: `${CPP_CHARS}\nauto n = std::min<std::size_t>(static_cast<std::size_t>(std::max(0LL, count)), chars.size());\nstd::string result;\nfor (std::size_t i = chars.size() - n; i < chars.size(); i++) result += chars[i];\nreturn result;`,
      rust: 'let chars: Vec<char> = text.chars().collect();\nlet n = (count.max(0) as usize).min(chars.len());\nreturn chars[chars.len() - n..].iter().collect();',
      java: 'int length = text.codePointCount(0, text.length());\nint n = (int) Math.min(Math.max(0, count), length);\nreturn text.substring(text.offsetByCodePoints(0, length - n));',
      go: 'runes := []rune(text)\nreturn string(runes[len(runes)-min(max(count, 0), len(runes)):])',
      lua: 'local chars = vg.chars(text)\nlocal n = math.min(math.max(count, 0), #chars)\nreturn table.concat(chars, "", #chars - n + 1, #chars)',
      gdscript: 'var n := mini(maxi(count, 0), text.length())\nreturn text.substr(text.length() - n, n)',
      ruby: 'n = [[count, 0].max, text.length].min\nreturn text[text.length - n, n]',
      php: '$n = min(max(0, $count), mb_strlen($text));\nreturn mb_substr($text, mb_strlen($text) - $n);'
    }
  },
  {
    type: 'core:string.is-numeric', displayName: 'Is Numeric', category: 'String', result: BOOL, keywords: ['number', 'numeric', 'digits', 'validate'],
    inputs: [text()], description: 'True if the text is a plain decimal number: an optional sign, digits, and at most one decimal point (12, -3.5, .5). No spaces or exponents.',
    code: {
      javascript: `return /${NUMERIC}/.test(text);`,
      python: `import re\nreturn re.fullmatch(r"${NUMERIC.slice(1, -1)}", text) is not None`,
      csharp: `return System.Text.RegularExpressions.Regex.IsMatch(text, @"${NUMERIC.slice(0, -1)}\\z");`,
      cpp: `return std::regex_match(text, std::regex(R"re(${NUMERIC.slice(1, -1)})re"));`,
      rust: [
        'let body = text.strip_prefix(|c: char| c == \'+\' || c == \'-\').unwrap_or(text.as_str());',
        'let mut digits = 0;',
        'let mut points = 0;',
        'for c in body.chars() {',
        '    if c.is_ascii_digit() { digits += 1; } else if c == \'.\' { points += 1; } else { return false; }',
        '}',
        'return digits > 0 && points <= 1;'
      ].join('\n'),
      java: `return text.matches("${NUMERIC.slice(1, -1).replace(/\\/g, '\\\\')}");`,
      go: `return regexp.MustCompile(\`${NUMERIC}\`).MatchString(text)`,
      lua: 'local body = text:match("^[+-]?(.*)$")\nreturn body:match("^%d*%.?%d*$") ~= nil and body:match("%d") ~= nil',
      gdscript: `return RegEx.create_from_string(r"${NUMERIC}").search(text) != null`,
      ruby: `return text.match?(/\\A${NUMERIC.slice(1, -1)}\\z/)`,
      php: `return preg_match('/${NUMERIC}/D', $text) === 1;`
    }
  },
  {
    type: 'core:string.equal-ignore-case', displayName: 'Equal, Case Insensitive', category: 'String', result: BOOL, keywords: ['equals ignore case', 'compare', 'same', '=='],
    inputs: [input('a', 'A', STRING, ''), input('b', 'B', STRING, '')],
    description: 'True if A and B are the same text, ignoring the case of ASCII letters (A to Z). Other letters must match exactly, the same in every language.',
    code: {
      javascript: 'const fold = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());\nreturn fold(a) === fold(b);',
      typescript: 'const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());\nreturn fold(a) === fold(b);',
      python: 'return a.encode().lower() == b.encode().lower()',
      csharp: 'static string Fold(string s) => string.Concat(s.Select((c) => c >= \'A\' && c <= \'Z\' ? (char)(c + 32) : c));\nreturn Fold(a) == Fold(b);',
      cpp: 'if (a.size() != b.size()) return false;\nfor (std::size_t i = 0; i < a.size(); i++) {\n    char x = a[i] >= \'A\' && a[i] <= \'Z\' ? static_cast<char>(a[i] + 32) : a[i];\n    char y = b[i] >= \'A\' && b[i] <= \'Z\' ? static_cast<char>(b[i] + 32) : b[i];\n    if (x != y) return false;\n}\nreturn true;',
      rust: 'return a.eq_ignore_ascii_case(&b);',
      java: [
        'java.util.function.UnaryOperator<String> fold = (s) -> {',
        '    var out = new StringBuilder(s);',
        '    for (int i = 0; i < out.length(); i++) if (out.charAt(i) >= \'A\' && out.charAt(i) <= \'Z\') out.setCharAt(i, (char) (out.charAt(i) + 32));',
        '    return out.toString();',
        '};',
        'return fold.apply(a).equals(fold.apply(b));'
      ].join('\n'),
      go: 'fold := func(s string) string {\n\treturn strings.Map(func(r rune) rune {\n\t\tif r >= \'A\' && r <= \'Z\' {\n\t\t\treturn r + 32\n\t\t}\n\t\treturn r\n\t}, s)\n}\nreturn fold(a) == fold(b)',
      lua: 'return a:lower() == b:lower()',
      gdscript: [
        'if a.length() != b.length():',
        '\treturn false',
        'for i in a.length():',
        '\tvar x := a.unicode_at(i)',
        '\tvar y := b.unicode_at(i)',
        '\tif x >= 65 and x <= 90:',
        '\t\tx += 32',
        '\tif y >= 65 and y <= 90:',
        '\t\ty += 32',
        '\tif x != y:',
        '\t\treturn false',
        'return true'
      ].join('\n'),
      ruby: 'return a.downcase(:ascii) == b.downcase(:ascii)',
      php: 'return strtolower($a) === strtolower($b);'
    }
  }
];
