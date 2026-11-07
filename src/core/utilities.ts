// More utility nodes for the standard library (docs/code-as-nodes.md, "Standard library nodes"):
// text, numbers, parsing, arrays, maps and the system. Each is implemented in every graph language,
// with one contract, so a graph prints the same wherever it runs: text is counted in code points, as
// the standard library counts it, and a rule broken (a negative length, an unknown word) stops the
// run with the message, as Divide by zero does. Adapted from Common Utility Snippets v0.1.0 (MIT;
// its notice is in THIRD_PARTY_NOTICES.md).
import { NodeDefinition } from './model';
import { ARRAY_UTILITIES, MAP_UTILITIES, SET_UTILITIES } from './utilities-containers';
import { MATH_UTILITIES } from './utilities-math';
import { LANGUAGE_UTILITIES } from './utilities-language';
import { STRING_UTILITIES, TEXT_UTILITIES } from './utilities-strings';
import { ENCODING_UTILITIES, SYSTEM_UTILITIES } from './utilities-system';
import { ARRAY, BOOL, FLOAT, FLOATS, INT, input, MAP, output, Snippets, STRING, text, UtilityNode } from './utility-kit';

// ---- Shared code -------------------------------------------------------------------------------

// A string's code points, for languages whose strings aren't sequences of them.
const CPP_CODE_POINTS = String.raw`auto codePoints = [](const std::string& s) {
    std::vector<std::string> out;
    for (std::size_t i = 0; i < s.size();) {
        std::size_t n = 1;
        while (i + n < s.size() && (static_cast<unsigned char>(s[i + n]) & 0xC0) == 0x80) n++;
        out.push_back(s.substr(i, n));
        i += n;
    }
    return out;
};`;

// The words of an identifier or phrase, lower case: runs of ASCII letters and digits, split where a
// lower-case letter or digit meets an upper-case one ("userID" → user, id) and before the last
// capital of a run that starts a word ("HTTPServer" → http, server).
const WORDS: Snippets = {
  javascript: String.raw`const chars = [...text];
const isUpper = (/** @type {string} */ c) => c >= 'A' && c <= 'Z';
const isLower = (/** @type {string} */ c) => c >= 'a' && c <= 'z';
const isDigit = (/** @type {string} */ c) => c >= '0' && c <= '9';
const words = [];
let word = '';
for (let i = 0; i < chars.length; i++) {
  const c = chars[i];
  if (!isUpper(c) && !isLower(c) && !isDigit(c)) {
    if (word) words.push(word.toLowerCase());
    word = '';
    continue;
  }
  const prev = word ? word[word.length - 1] : '';
  const next = chars[i + 1] ?? '';
  if (word && isUpper(c) && (isLower(prev) || isDigit(prev) || (isUpper(prev) && isLower(next)))) {
    words.push(word.toLowerCase());
    word = '';
  }
  word += c;
}
if (word) words.push(word.toLowerCase());`,
  typescript: String.raw`const chars = [...text];
const isUpper = (c: string) => c >= 'A' && c <= 'Z';
const isLower = (c: string) => c >= 'a' && c <= 'z';
const isDigit = (c: string) => c >= '0' && c <= '9';
const words: string[] = [];
let word = '';
for (let i = 0; i < chars.length; i++) {
  const c = chars[i]!;
  if (!isUpper(c) && !isLower(c) && !isDigit(c)) {
    if (word) words.push(word.toLowerCase());
    word = '';
    continue;
  }
  const prev = word ? word[word.length - 1]! : '';
  const next = chars[i + 1] ?? '';
  if (word && isUpper(c) && (isLower(prev) || isDigit(prev) || (isUpper(prev) && isLower(next)))) {
    words.push(word.toLowerCase());
    word = '';
  }
  word += c;
}
if (word) words.push(word.toLowerCase());`,
  python: String.raw`def is_upper(c: str) -> bool:
    return "A" <= c <= "Z"
def is_lower(c: str) -> bool:
    return "a" <= c <= "z"
def is_digit(c: str) -> bool:
    return "0" <= c <= "9"
words: list[str] = []
word = ""
for i, c in enumerate(text):
    if not (is_upper(c) or is_lower(c) or is_digit(c)):
        if word:
            words.append(word.lower())
        word = ""
        continue
    prev = word[-1] if word else ""
    nxt = text[i + 1] if i + 1 < len(text) else ""
    if word and is_upper(c) and (is_lower(prev) or is_digit(prev) or (is_upper(prev) and is_lower(nxt))):
        words.append(word.lower())
        word = ""
    word += c
if word:
    words.append(word.lower())`,
  csharp: String.raw`static bool IsUpper(char c) => c >= 'A' && c <= 'Z';
static bool IsLower(char c) => c >= 'a' && c <= 'z';
static bool IsDigit(char c) => c >= '0' && c <= '9';
var words = new List<string>();
var word = new System.Text.StringBuilder();
for (var i = 0; i < text.Length; i++)
{
    var c = text[i];
    if (!IsUpper(c) && !IsLower(c) && !IsDigit(c))
    {
        if (word.Length > 0) words.Add(word.ToString().ToLowerInvariant());
        word.Clear();
        continue;
    }
    if (word.Length > 0 && IsUpper(c))
    {
        var prev = word[word.Length - 1];
        var next = i + 1 < text.Length ? text[i + 1] : '\0';
        if (IsLower(prev) || IsDigit(prev) || (IsUpper(prev) && IsLower(next)))
        {
            words.Add(word.ToString().ToLowerInvariant());
            word.Clear();
        }
    }
    word.Append(c);
}
if (word.Length > 0) words.Add(word.ToString().ToLowerInvariant());`,
  cpp: String.raw`auto isUpper = [](char c) { return c >= 'A' && c <= 'Z'; };
auto isLower = [](char c) { return c >= 'a' && c <= 'z'; };
auto isDigit = [](char c) { return c >= '0' && c <= '9'; };
std::vector<std::string> words;
std::string word;
for (std::size_t i = 0; i < text.size(); i++) {
    char c = text[i];
    if (!isUpper(c) && !isLower(c) && !isDigit(c)) {
        if (!word.empty()) words.push_back(word);
        word.clear();
        continue;
    }
    if (!word.empty() && isUpper(c)) {
        char prev = word.back();
        char next = i + 1 < text.size() ? text[i + 1] : '\0';
        if (isLower(prev) || isDigit(prev) || (isUpper(prev) && isLower(next))) {
            words.push_back(word);
            word.clear();
        }
    }
    word += c;
}
if (!word.empty()) words.push_back(word);
for (auto& w : words) for (auto& c : w) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));`,
  rust: String.raw`let chars: Vec<char> = text.chars().collect();
let mut words: Vec<String> = Vec::new();
let mut word = String::new();
for i in 0..chars.len() {
    let c = chars[i];
    if !c.is_ascii_alphanumeric() {
        if !word.is_empty() { words.push(word.to_ascii_lowercase()); }
        word.clear();
        continue;
    }
    if let Some(prev) = word.chars().last() {
        let next = chars.get(i + 1).copied().unwrap_or('\0');
        if c.is_ascii_uppercase() && (prev.is_ascii_lowercase() || prev.is_ascii_digit() || (prev.is_ascii_uppercase() && next.is_ascii_lowercase())) {
            words.push(word.to_ascii_lowercase());
            word.clear();
        }
    }
    word.push(c);
}
if !word.is_empty() { words.push(word.to_ascii_lowercase()); }`,
  java: String.raw`var words = new java.util.ArrayList<String>();
var word = new StringBuilder();
for (int i = 0; i < text.length(); i++) {
    char c = text.charAt(i);
    boolean upper = c >= 'A' && c <= 'Z';
    if (!upper && !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9')) {
        if (word.length() > 0) words.add(word.toString().toLowerCase(java.util.Locale.ROOT));
        word.setLength(0);
        continue;
    }
    if (word.length() > 0 && upper) {
        char prev = word.charAt(word.length() - 1);
        char next = i + 1 < text.length() ? text.charAt(i + 1) : '\0';
        if ((prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9') || (prev >= 'A' && prev <= 'Z' && next >= 'a' && next <= 'z')) {
            words.add(word.toString().toLowerCase(java.util.Locale.ROOT));
            word.setLength(0);
        }
    }
    word.append(c);
}
if (word.length() > 0) words.add(word.toString().toLowerCase(java.util.Locale.ROOT));`,
  go: String.raw`isUpper := func(c byte) bool { return c >= 'A' && c <= 'Z' }
isLower := func(c byte) bool { return c >= 'a' && c <= 'z' }
isDigit := func(c byte) bool { return c >= '0' && c <= '9' }
words := []string{}
word := []byte{}
for i := 0; i < len(text); i++ {
	c := text[i]
	if !isUpper(c) && !isLower(c) && !isDigit(c) {
		if len(word) > 0 {
			words = append(words, strings.ToLower(string(word)))
		}
		word = word[:0]
		continue
	}
	if len(word) > 0 && isUpper(c) {
		prev := word[len(word)-1]
		var next byte
		if i+1 < len(text) {
			next = text[i+1]
		}
		if isLower(prev) || isDigit(prev) || (isUpper(prev) && isLower(next)) {
			words = append(words, strings.ToLower(string(word)))
			word = word[:0]
		}
	}
	word = append(word, c)
}
if len(word) > 0 {
	words = append(words, strings.ToLower(string(word)))
}`
};

// The words joined: snake_case, kebab-case (and slugs), camelCase.
function joined(separator: string): Snippets {
  return {
    javascript: `${WORDS.javascript}\nreturn words.join('${separator}');`,
    typescript: `${WORDS.typescript}\nreturn words.join('${separator}');`,
    python: `${WORDS.python}\nreturn "${separator}".join(words)`,
    csharp: `${WORDS.csharp}\nreturn string.Join("${separator}", words);`,
    cpp: `${WORDS.cpp}\nstd::string result;\nfor (std::size_t i = 0; i < words.size(); i++) result += (i ? "${separator}" : "") + words[i];\nreturn result;`,
    rust: `${WORDS.rust}\nreturn words.join("${separator}");`,
    java: `${WORDS.java}\nreturn String.join("${separator}", words);`,
    go: `${WORDS.go}\nreturn strings.Join(words, "${separator}")`
  };
}

const CAMEL: Snippets = {
  javascript: `${WORDS.javascript}\nreturn words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');`,
  typescript: `${WORDS.typescript}\nreturn words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1) : w)).join('');`,
  python: `${WORDS.python}\nreturn "".join(w if i == 0 else w[:1].upper() + w[1:] for i, w in enumerate(words))`,
  csharp: `${WORDS.csharp}\nreturn string.Concat(words.Select((w, i) => i == 0 ? w : char.ToUpperInvariant(w[0]) + w.Substring(1)));`,
  cpp: `${WORDS.cpp}\nstd::string result;\nfor (std::size_t i = 0; i < words.size(); i++) {\n    std::string w = words[i];\n    if (i) w[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(w[0])));\n    result += w;\n}\nreturn result;`,
  rust: `${WORDS.rust}\nreturn words.iter().enumerate().map(|(i, w)| if i == 0 { w.clone() } else { w[..1].to_ascii_uppercase() + &w[1..] }).collect::<Vec<_>>().concat();`,
  java: `${WORDS.java}\nvar result = new StringBuilder();\nfor (int i = 0; i < words.size(); i++) {\n    String w = words.get(i);\n    result.append(i == 0 ? w : Character.toUpperCase(w.charAt(0)) + w.substring(1));\n}\nreturn result.toString();`,
  go: `${WORDS.go}\nresult := ""\nfor i, w := range words {\n\tif i > 0 {\n\t\tw = strings.ToUpper(w[:1]) + w[1:]\n\t}\n\tresult += w\n}\nreturn result`
};

// Pad Left and Pad Right: the fill repeated before or after the text, up to the width.
function pad(left: boolean): Snippets {
  const join = (fill: string, textValue: string) => (left ? `${fill} + ${textValue}` : `${textValue} + ${fill}`);
  return {
    javascript: `if ([...fill].length !== 1) throw new Error('Fill must be one character');\nconst missing = width - [...text].length;\nreturn ${join("(missing > 0 ? fill.repeat(missing) : '')", 'text')};`,
    python: `if len(fill) != 1:\n    raise ValueError("Fill must be one character")\nreturn ${join('fill * max(0, width - len(text))', 'text')}`,
    csharp: `var units = 0;\nforeach (var _ in fill.EnumerateRunes()) units++;\nif (units != 1) throw new ArgumentException("Fill must be one character");\nvar length = 0;\nforeach (var _ in text.EnumerateRunes()) length++;\nreturn ${join('string.Concat(Enumerable.Repeat(fill, Math.Max(0, width - length)))', 'text')};`,
    cpp: `auto count = [](const std::string& s) { long long n = 0; for (unsigned char c : s) if ((c & 0xC0) != 0x80) n++; return n; };\nif (count(fill) != 1) throw std::invalid_argument("Fill must be one character");\nstd::string padding;\nfor (long long i = count(text); i < width; i++) padding += fill;\nreturn ${join('padding', 'text')};`,
    rust: `if fill.chars().count() != 1 { panic!("Fill must be one character"); }\nlet missing = (width - text.chars().count() as i64).max(0) as usize;\nreturn ${left ? 'fill.repeat(missing) + &text' : 'text + &fill.repeat(missing)'};`,
    java: `if (fill.codePointCount(0, fill.length()) != 1) throw new IllegalArgumentException("Fill must be one character");\nlong missing = width - text.codePointCount(0, text.length());\nreturn ${join('(missing > 0 ? fill.repeat((int) missing) : "")', 'text')};`,
    go: `if utf8.RuneCountInString(fill) != 1 {\n\tVgFail("Fill must be one character")\n}\nreturn ${join('strings.Repeat(fill, max(0, width-utf8.RuneCountInString(text)))', 'text')}`
  };
}

// Difference and Intersection: the left array's items that are (or aren't) in the right one, each once.
function compare(keep: boolean): Snippets {
  const not = keep ? '' : '!';
  return {
    javascript: `const other = new Set(right);\nreturn [...new Set(left.filter((item) => ${not}other.has(item)))];`,
    python: `return list(dict.fromkeys(item for item in left if item ${keep ? 'in' : 'not in'} right))`,
    csharp: `return left.Where(item => ${not}right.Contains(item)).Distinct().ToList();`,
    cpp: `std::decay_t<decltype(left)> result;\nfor (const auto& item : left) {\n    bool inRight = std::find(right.begin(), right.end(), item) != right.end();\n    if (inRight == ${keep} && std::find(result.begin(), result.end(), item) == result.end()) result.push_back(item);\n}\nreturn result;`,
    rust: `let mut result = Vec::new();\nfor item in left.iter() {\n    if right.contains(item) == ${keep} && !result.contains(item) { result.push(item.clone()); }\n}\nreturn result;`,
    java: `var result = new java.util.ArrayList<>(new java.util.LinkedHashSet<>(left));\nresult.${keep ? 'retainAll' : 'removeAll'}(right);\nreturn result;`,
    go: `result := (*left)[:0:0]\nfor _, item := range *left {\n\tif slices.Contains(*right, item) == ${keep} && !slices.Contains(result, item) {\n\t\tresult = append(result, item)\n\t}\n}\nreturn &result`
  };
}

// ---- The nodes -----------------------------------------------------------------------------------

const NODES: UtilityNode[] = [
  // ---- Text ----
  {
    type: 'core:string.is-empty', displayName: 'Is Empty', category: 'String', inputs: [text()], result: BOOL, keywords: ['empty', 'length'],
    description: 'True if the text has no characters. Whitespace counts as characters.',
    code: {
      javascript: 'return text.length === 0;', python: 'return len(text) == 0', csharp: 'return text.Length == 0;', cpp: 'return text.empty();',
      rust: 'return text.is_empty();', java: 'return text.isEmpty();', go: 'return text == ""'
    }
  },
  {
    type: 'core:string.is-blank', displayName: 'Is Blank', category: 'String', inputs: [text()], result: BOOL, keywords: ['empty', 'whitespace', 'blank'],
    description: 'True if the text is empty or only whitespace.',
    code: {
      javascript: "return text.trim() === '';", python: 'return text.strip() == ""', csharp: 'return string.IsNullOrWhiteSpace(text);',
      cpp: 'for (unsigned char c : text) if (!std::isspace(c)) return false;\nreturn true;', rust: 'return text.trim().is_empty();',
      java: 'return text.isBlank();', go: 'return strings.TrimSpace(text) == ""'
    }
  },
  {
    type: 'core:string.normalize-whitespace', displayName: 'Normalize Whitespace', category: 'String', inputs: [text()], result: STRING, keywords: ['whitespace', 'spaces', 'collapse', 'trim'],
    description: 'The text trimmed, with each run of whitespace inside it replaced by one space.',
    code: {
      javascript: String.raw`const trimmed = text.trim();
return trimmed ? trimmed.split(/\s+/u).join(' ') : '';`,
      python: 'return " ".join(text.split())',
      csharp: 'return string.Join(" ", text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));',
      cpp: String.raw`std::string result;
std::string word;
for (unsigned char c : text) {
    if (std::isspace(c)) {
        if (!word.empty()) result += (result.empty() ? "" : " ") + word;
        word.clear();
    } else {
        word += static_cast<char>(c);
    }
}
if (!word.empty()) result += (result.empty() ? "" : " ") + word;
return result;`,
      rust: 'return text.split_whitespace().collect::<Vec<_>>().join(" ");',
      java: String.raw`String trimmed = text.strip();
return trimmed.isEmpty() ? "" : String.join(" ", trimmed.split("(?U)\\s+"));`,
      go: 'return strings.Join(strings.Fields(text), " ")'
    }
  },
  {
    type: 'core:string.truncate', displayName: 'Truncate', category: 'String', result: STRING, keywords: ['shorten', 'ellipsis', 'limit'],
    inputs: [text(), input('maxLength', 'Max Length', INT, 10), input('suffix', 'Suffix', STRING, '…')],
    description: 'The text cut to at most Max Length characters, the suffix included: text that is too long ends with the suffix.',
    code: {
      javascript: `if (maxLength < 0) throw new Error("Max Length can't be negative");
const chars = [...text];
if (chars.length <= maxLength) return text;
const end = [...suffix];
return chars.slice(0, Math.max(0, maxLength - end.length)).join('') + end.slice(0, maxLength).join('');`,
      python: `if maxLength < 0:
    raise ValueError("Max Length can't be negative")
if len(text) <= maxLength:
    return text
return text[:max(0, maxLength - len(suffix))] + suffix[:maxLength]`,
      csharp: `if (maxLength < 0) throw new ArgumentException("Max Length can't be negative");
var chars = new List<string>();
foreach (var rune in text.EnumerateRunes()) chars.Add(rune.ToString());
if (chars.Count <= maxLength) return text;
var end = new List<string>();
foreach (var rune in suffix.EnumerateRunes()) end.Add(rune.ToString());
return string.Concat(chars.Take(Math.Max(0, maxLength - end.Count))) + string.Concat(end.Take(maxLength));`,
      cpp: `${CPP_CODE_POINTS}
if (maxLength < 0) throw std::invalid_argument("Max Length can't be negative");
auto chars = codePoints(text);
if (static_cast<long long>(chars.size()) <= maxLength) return text;
auto end = codePoints(suffix);
std::string result;
for (long long i = 0; i < std::max(0LL, maxLength - static_cast<long long>(end.size())); i++) result += chars[i];
for (long long i = 0; i < std::min(maxLength, static_cast<long long>(end.size())); i++) result += end[i];
return result;`,
      rust: `if maxLength < 0 { panic!("Max Length can't be negative"); }
let chars: Vec<char> = text.chars().collect();
if chars.len() as i64 <= maxLength { return text; }
let end: Vec<char> = suffix.chars().collect();
let keep = (maxLength - end.len() as i64).max(0) as usize;
return chars[..keep].iter().collect::<String>() + &end.iter().take(maxLength as usize).collect::<String>();`,
      java: `if (maxLength < 0) throw new IllegalArgumentException("Max Length can't be negative");
int[] chars = text.codePoints().toArray();
if (chars.length <= maxLength) return text;
int[] end = suffix.codePoints().toArray();
int keep = (int) Math.max(0, maxLength - end.length);
return new String(chars, 0, keep) + new String(end, 0, (int) Math.min(maxLength, end.length));`,
      go: `if maxLength < 0 {
\tVgFail("Max Length can't be negative")
}
chars := []rune(text)
if len(chars) <= maxLength {
\treturn text
}
end := []rune(suffix)
return string(chars[:max(0, maxLength-len(end))]) + string(end[:min(maxLength, len(end))])`
    }
  },
  {
    type: 'core:string.capitalize', displayName: 'Capitalize', category: 'String', inputs: [text()], result: STRING, keywords: ['uppercase', 'first letter'],
    description: 'The text with its first character in upper case; the rest is unchanged.',
    code: {
      javascript: "const chars = [...text];\nreturn chars.length ? chars[0].toUpperCase() + chars.slice(1).join('') : text;",
      typescript: "const chars = [...text];\nreturn chars.length ? chars[0]!.toUpperCase() + chars.slice(1).join('') : text;",
      python: 'return text[:1].upper() + text[1:]',
      csharp: 'if (text.Length == 0) return text;\nvar first = text.EnumerateRunes().First();\nreturn first.ToString().ToUpperInvariant() + text.Substring(first.Utf16SequenceLength);',
      cpp: 'if (!text.empty()) text[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(text[0])));\nreturn text;',
      rust: 'if text.is_empty() { return text; }\nlet mut chars = text.chars();\nlet first = chars.next().unwrap();\nreturn first.to_uppercase().collect::<String>() + chars.as_str();',
      java: 'if (text.isEmpty()) return text;\nint size = Character.charCount(text.codePointAt(0));\nreturn text.substring(0, size).toUpperCase(java.util.Locale.ROOT) + text.substring(size);',
      go: 'if text == "" {\n\treturn text\n}\nchars := []rune(text)\nreturn strings.ToUpper(string(chars[0])) + string(chars[1:])'
    }
  },
  {
    type: 'core:string.to-camel-case', displayName: 'To Camel Case', category: 'String', inputs: [text()], result: STRING, keywords: ['case', 'identifier', 'camelCase'],
    description: 'The words of the text as camelCase: "HTTP server name" becomes httpServerName.', code: CAMEL
  },
  {
    type: 'core:string.to-snake-case', displayName: 'To Snake Case', category: 'String', inputs: [text()], result: STRING, keywords: ['case', 'identifier', 'snake_case', 'underscore'],
    description: 'The words of the text as snake_case: "HTTPServerName" becomes http_server_name.', code: joined('_')
  },
  {
    type: 'core:string.to-kebab-case', displayName: 'To Kebab Case', category: 'String', inputs: [text()], result: STRING, keywords: ['case', 'identifier', 'kebab-case', 'dash'],
    description: 'The words of the text as kebab-case: "HTTPServerName" becomes http-server-name.', code: joined('-')
  },
  {
    type: 'core:string.slugify', displayName: 'Slugify', category: 'String', inputs: [text()], result: STRING, keywords: ['slug', 'url', 'permalink'],
    description: 'A URL slug of the text: its ASCII words in lower case, joined with dashes. Other characters are dropped.', code: joined('-')
  },
  {
    type: 'core:string.pad-left', displayName: 'Pad Left', category: 'String', result: STRING, keywords: ['pad', 'align', 'width'],
    inputs: [text(), input('width', 'Width', INT, 8), input('fill', 'Fill', STRING, ' ')],
    description: 'The text with Fill (one character) repeated before it, up to Width characters.', code: pad(true)
  },
  {
    type: 'core:string.pad-right', displayName: 'Pad Right', category: 'String', result: STRING, keywords: ['pad', 'align', 'width'],
    inputs: [text(), input('width', 'Width', INT, 8), input('fill', 'Fill', STRING, ' ')],
    description: 'The text with Fill (one character) repeated after it, up to Width characters.', code: pad(false)
  },
  {
    type: 'core:string.word-count', displayName: 'Word Count', category: 'String', inputs: [text()], result: INT, keywords: ['words', 'count'],
    description: 'How many whitespace-separated words the text has.',
    code: {
      javascript: String.raw`const trimmed = text.trim();
return trimmed ? trimmed.split(/\s+/u).length : 0;`,
      python: 'return len(text.split())',
      csharp: 'return text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;',
      cpp: 'long long count = 0;\nbool inWord = false;\nfor (unsigned char c : text) {\n    if (std::isspace(c)) inWord = false;\n    else if (!inWord) {\n        inWord = true;\n        count++;\n    }\n}\nreturn count;',
      rust: 'return text.split_whitespace().count() as i64;',
      java: String.raw`String trimmed = text.strip();
return trimmed.isEmpty() ? 0 : trimmed.split("(?U)\\s+").length;`,
      go: 'return len(strings.Fields(text))'
    }
  },
  {
    type: 'core:string.mask', displayName: 'Mask', category: 'String', result: STRING, keywords: ['hide', 'redact', 'secret', 'password'],
    inputs: [text(), input('visibleStart', 'Visible Start', INT, 0), input('visibleEnd', 'Visible End', INT, 4), input('mask', 'Mask', STRING, '*')],
    description: 'The text with every character replaced by Mask (one character), except the first Visible Start and the last Visible End.',
    code: {
      javascript: `if (visibleStart < 0 || visibleEnd < 0) throw new Error("Visible counts can't be negative");
if ([...mask].length !== 1) throw new Error('Mask must be one character');
const chars = [...text];
const start = Math.min(visibleStart, chars.length);
const end = Math.min(visibleEnd, chars.length - start);
return chars.slice(0, start).join('') + mask.repeat(chars.length - start - end) + chars.slice(chars.length - end).join('');`,
      python: `if visibleStart < 0 or visibleEnd < 0:
    raise ValueError("Visible counts can't be negative")
if len(mask) != 1:
    raise ValueError("Mask must be one character")
start = min(visibleStart, len(text))
end = min(visibleEnd, len(text) - start)
return text[:start] + mask * (len(text) - start - end) + text[len(text) - end:]`,
      csharp: `if (visibleStart < 0 || visibleEnd < 0) throw new ArgumentException("Visible counts can't be negative");
var units = 0;
foreach (var _ in mask.EnumerateRunes()) units++;
if (units != 1) throw new ArgumentException("Mask must be one character");
var chars = new List<string>();
foreach (var rune in text.EnumerateRunes()) chars.Add(rune.ToString());
var start = Math.Min(visibleStart, chars.Count);
var end = Math.Min(visibleEnd, chars.Count - start);
return string.Concat(chars.Take(start)) + string.Concat(Enumerable.Repeat(mask, chars.Count - start - end)) + string.Concat(chars.Skip(chars.Count - end));`,
      cpp: `${CPP_CODE_POINTS}
if (visibleStart < 0 || visibleEnd < 0) throw std::invalid_argument("Visible counts can't be negative");
if (codePoints(mask).size() != 1) throw std::invalid_argument("Mask must be one character");
auto chars = codePoints(text);
long long n = static_cast<long long>(chars.size());
long long start = std::min(visibleStart, n);
long long end = std::min(visibleEnd, n - start);
std::string result;
for (long long i = 0; i < n; i++) result += i < start || i >= n - end ? chars[i] : mask;
return result;`,
      rust: `if visibleStart < 0 || visibleEnd < 0 { panic!("Visible counts can't be negative"); }
if mask.chars().count() != 1 { panic!("Mask must be one character"); }
let chars: Vec<char> = text.chars().collect();
let n = chars.len() as i64;
let start = visibleStart.min(n);
let end = visibleEnd.min(n - start);
let mut result = String::new();
for (i, c) in chars.iter().enumerate() {
    let i = i as i64;
    if i < start || i >= n - end { result.push(*c); } else { result.push_str(&mask); }
}
return result;`,
      java: `if (visibleStart < 0 || visibleEnd < 0) throw new IllegalArgumentException("Visible counts can't be negative");
if (mask.codePointCount(0, mask.length()) != 1) throw new IllegalArgumentException("Mask must be one character");
int[] chars = text.codePoints().toArray();
long start = Math.min(visibleStart, chars.length);
long end = Math.min(visibleEnd, chars.length - start);
var result = new StringBuilder();
for (int i = 0; i < chars.length; i++) {
    if (i < start || i >= chars.length - end) result.appendCodePoint(chars[i]);
    else result.append(mask);
}
return result.toString();`,
      go: `if visibleStart < 0 || visibleEnd < 0 {
\tVgFail("Visible counts can't be negative")
}
if utf8.RuneCountInString(mask) != 1 {
\tVgFail("Mask must be one character")
}
chars := []rune(text)
start := min(visibleStart, len(chars))
end := min(visibleEnd, len(chars)-start)
result := ""
for i, c := range chars {
\tif i < start || i >= len(chars)-end {
\t\tresult += string(c)
\t} else {
\t\tresult += mask
\t}
}
return result`
    }
  },

  // ---- Numbers ----
  {
    type: 'core:math.in-range', displayName: 'In Range', category: 'Math', result: BOOL, keywords: ['range', 'between', 'interval'],
    inputs: [input('value', 'Value', FLOAT, 0), input('start', 'Start', FLOAT, 0), input('end', 'End', FLOAT, 1)],
    description: 'True if Value is at least Start and less than End (End itself is outside the range).',
    code: {
      javascript: `if (start > end) throw new Error("Start can't be greater than End");\nreturn value >= start && value < end;`,
      python: `if start > end:\n    raise ValueError("Start can't be greater than End")\nreturn start <= value < end`,
      csharp: `if (start > end) throw new ArgumentException("Start can't be greater than End");\nreturn value >= start && value < end;`,
      cpp: `if (start > end) throw std::invalid_argument("Start can't be greater than End");\nreturn value >= start && value < end;`,
      rust: `if start > end { panic!("Start can't be greater than End"); }\nreturn value >= start && value < end;`,
      java: `if (start > end) throw new IllegalArgumentException("Start can't be greater than End");\nreturn value >= start && value < end;`,
      go: `if start > end {\n\tVgFail("Start can't be greater than End")\n}\nreturn value >= start && value < end`
    }
  },
  {
    type: 'core:math.round-to', displayName: 'Round To', category: 'Math', result: FLOAT, keywords: ['round', 'decimal', 'precision', 'places'],
    inputs: [input('value', 'Value', FLOAT, 0), input('digits', 'Digits', INT, 2)],
    description: 'Value rounded to Digits decimal places (0 to 15); halves round away from zero.',
    code: {
      javascript: `if (!Number.isFinite(value)) throw new Error('Value must be a finite number');
if (digits < 0 || digits > 15) throw new Error('Digits must be from 0 to 15');
const factor = 10 ** digits;
const sign = value > 0 ? 1 : value < 0 ? -1 : 0;
return sign * Math.floor((Math.abs(value) + 2.220446049250313e-16) * factor + 0.5) / factor;`,
      python: `import math
if not math.isfinite(value):
    raise ValueError("Value must be a finite number")
if digits < 0 or digits > 15:
    raise ValueError("Digits must be from 0 to 15")
factor = 10.0 ** digits
sign = 1 if value > 0 else -1 if value < 0 else 0
return sign * math.floor((abs(value) + 2.220446049250313e-16) * factor + 0.5) / factor`,
      csharp: `if (!double.IsFinite(value)) throw new ArgumentException("Value must be a finite number");
if (digits < 0 || digits > 15) throw new ArgumentException("Digits must be from 0 to 15");
var factor = Math.Pow(10, digits);
var sign = value > 0 ? 1 : value < 0 ? -1 : 0;
return sign * Math.Floor((Math.Abs(value) + 2.220446049250313e-16) * factor + 0.5) / factor;`,
      cpp: `if (!std::isfinite(value)) throw std::invalid_argument("Value must be a finite number");
if (digits < 0 || digits > 15) throw std::invalid_argument("Digits must be from 0 to 15");
double factor = std::pow(10.0, static_cast<double>(digits));
double sign = value > 0 ? 1 : value < 0 ? -1 : 0;
return sign * std::floor((std::fabs(value) + 2.220446049250313e-16) * factor + 0.5) / factor;`,
      rust: `if !value.is_finite() { panic!("Value must be a finite number"); }
if digits < 0 || digits > 15 { panic!("Digits must be from 0 to 15"); }
let factor = 10f64.powi(digits as i32);
let sign = if value > 0.0 { 1.0 } else if value < 0.0 { -1.0 } else { 0.0 };
return sign * ((value.abs() + 2.220446049250313e-16) * factor + 0.5).floor() / factor;`,
      java: `if (!Double.isFinite(value)) throw new IllegalArgumentException("Value must be a finite number");
if (digits < 0 || digits > 15) throw new IllegalArgumentException("Digits must be from 0 to 15");
double factor = Math.pow(10, digits);
double sign = value > 0 ? 1 : value < 0 ? -1 : 0;
return sign * Math.floor((Math.abs(value) + 2.220446049250313e-16) * factor + 0.5) / factor;`,
      go: `if math.IsNaN(value) || math.IsInf(value, 0) {
\tVgFail("Value must be a finite number")
}
if digits < 0 || digits > 15 {
\tVgFail("Digits must be from 0 to 15")
}
factor := math.Pow(10, float64(digits))
sign := 0.0
if value > 0 {
\tsign = 1
} else if value < 0 {
\tsign = -1
}
return sign * math.Floor((math.Abs(value)+2.220446049250313e-16)*factor+0.5) / factor`
    }
  },
  {
    type: 'core:string.format-bytes', displayName: 'Format Bytes', category: 'String', result: STRING, keywords: ['bytes', 'size', 'KiB', 'MiB', 'file size'],
    inputs: [input('size', 'Size', FLOAT, 0), input('decimals', 'Decimals', INT, 2)],
    description: 'A size in bytes as text, scaled by 1024 with KiB, MiB, GiB, TiB or PiB and Decimals decimal places (0 to 10): 1536 becomes 1.50 KiB. Below 1024 it is whole bytes: 512 B.',
    code: {
      javascript: `if (!Number.isFinite(size) || size < 0 || size > 9007199254740992) throw new Error('Size must be from 0 to 2^53');
if (decimals < 0 || decimals > 10) throw new Error('Decimals must be from 0 to 10');
if (size < 1024) return Math.trunc(size) + ' B';
const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
let value = size;
let index = -1;
do {
  value /= 1024;
  index++;
} while (value >= 1024 && index < units.length - 1);
const scale = 10 ** decimals;
const scaled = Math.floor(value * scale + 0.5);
const whole = Math.floor(scaled / scale);
const fraction = String(scaled - whole * scale).padStart(decimals, '0');
return whole + (decimals ? '.' + fraction : '') + ' ' + units[index];`,
      python: `import math
if not math.isfinite(size) or size < 0 or size > 9007199254740992:
    raise ValueError("Size must be from 0 to 2^53")
if decimals < 0 or decimals > 10:
    raise ValueError("Decimals must be from 0 to 10")
if size < 1024:
    return str(math.trunc(size)) + " B"
units = ["KiB", "MiB", "GiB", "TiB", "PiB"]
value = size
index = -1
while True:
    value /= 1024
    index += 1
    if not (value >= 1024 and index < len(units) - 1):
        break
scale = 10 ** decimals
scaled = math.floor(value * scale + 0.5)
whole = scaled // scale
fraction = str(scaled - whole * scale).rjust(decimals, "0")
return str(whole) + ("." + fraction if decimals else "") + " " + units[index]`,
      csharp: `if (!double.IsFinite(size) || size < 0 || size > 9007199254740992) throw new ArgumentException("Size must be from 0 to 2^53");
if (decimals < 0 || decimals > 10) throw new ArgumentException("Decimals must be from 0 to 10");
if (size < 1024) return ((long)Math.Truncate(size)).ToString(CultureInfo.InvariantCulture) + " B";
string[] units = { "KiB", "MiB", "GiB", "TiB", "PiB" };
var value = size;
var index = -1;
do
{
    value /= 1024;
    index++;
} while (value >= 1024 && index < units.Length - 1);
var scale = (long)Math.Pow(10, decimals);
var scaled = (long)Math.Floor(value * scale + 0.5);
var whole = scaled / scale;
var fraction = (scaled - whole * scale).ToString(CultureInfo.InvariantCulture).PadLeft(decimals, '0');
return whole.ToString(CultureInfo.InvariantCulture) + (decimals > 0 ? "." + fraction : "") + " " + units[index];`,
      cpp: `if (!std::isfinite(size) || size < 0 || size > 9007199254740992.0) throw std::invalid_argument("Size must be from 0 to 2^53");
if (decimals < 0 || decimals > 10) throw std::invalid_argument("Decimals must be from 0 to 10");
if (size < 1024) return std::to_string(static_cast<long long>(size)) + " B";
const char* units[] = { "KiB", "MiB", "GiB", "TiB", "PiB" };
double value = size;
int index = -1;
do {
    value /= 1024;
    index++;
} while (value >= 1024 && index < 4);
long long scale = 1;
for (long long i = 0; i < decimals; i++) scale *= 10;
long long scaled = static_cast<long long>(std::floor(value * static_cast<double>(scale) + 0.5));
long long whole = scaled / scale;
std::string fraction = std::to_string(scaled - whole * scale);
while (static_cast<long long>(fraction.size()) < decimals) fraction = "0" + fraction;
return std::to_string(whole) + (decimals > 0 ? "." + fraction : "") + " " + units[index];`,
      rust: `if !size.is_finite() || size < 0.0 || size > 9007199254740992.0 { panic!("Size must be from 0 to 2^53"); }
if decimals < 0 || decimals > 10 { panic!("Decimals must be from 0 to 10"); }
if size < 1024.0 { return format!("{} B", size.trunc() as i64); }
let units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
let mut value = size;
let mut index = 0;
value /= 1024.0;
while value >= 1024.0 && index < units.len() - 1 {
    value /= 1024.0;
    index += 1;
}
let scale = 10i64.pow(decimals as u32);
let scaled = (value * scale as f64 + 0.5).floor() as i64;
let whole = scaled / scale;
let fraction = format!("{:0>width$}", scaled - whole * scale, width = decimals as usize);
return if decimals > 0 { format!("{}.{} {}", whole, fraction, units[index]) } else { format!("{} {}", whole, units[index]) };`,
      java: `if (!Double.isFinite(size) || size < 0 || size > 9007199254740992.0) throw new IllegalArgumentException("Size must be from 0 to 2^53");
if (decimals < 0 || decimals > 10) throw new IllegalArgumentException("Decimals must be from 0 to 10");
if (size < 1024) return (long) size + " B";
String[] units = { "KiB", "MiB", "GiB", "TiB", "PiB" };
double value = size;
int index = -1;
do {
    value /= 1024;
    index++;
} while (value >= 1024 && index < units.length - 1);
long scale = (long) Math.pow(10, decimals);
long scaled = (long) Math.floor(value * scale + 0.5);
long whole = scaled / scale;
String fraction = String.valueOf(scaled - whole * scale);
while (fraction.length() < decimals) fraction = "0" + fraction;
return whole + (decimals > 0 ? "." + fraction : "") + " " + units[index];`,
      go: `if math.IsNaN(size) || math.IsInf(size, 0) || size < 0 || size > 9007199254740992 {
\tVgFail("Size must be from 0 to 2^53")
}
if decimals < 0 || decimals > 10 {
\tVgFail("Decimals must be from 0 to 10")
}
if size < 1024 {
\treturn strconv.FormatInt(int64(size), 10) + " B"
}
units := []string{"KiB", "MiB", "GiB", "TiB", "PiB"}
value := size
index := -1
for {
\tvalue /= 1024
\tindex++
\tif !(value >= 1024 && index < len(units)-1) {
\t\tbreak
\t}
}
scale := int64(math.Pow(10, float64(decimals)))
scaled := int64(math.Floor(value*float64(scale) + 0.5))
whole := scaled / scale
fraction := strconv.FormatInt(scaled-whole*scale, 10)
for len(fraction) < decimals {
\tfraction = "0" + fraction
}
if decimals > 0 {
\treturn strconv.FormatInt(whole, 10) + "." + fraction + " " + units[index]
}
return strconv.FormatInt(whole, 10) + " " + units[index]`
    }
  },

  // ---- Parsing ----
  {
    type: 'core:string.parse-boolean', displayName: 'Parse Boolean', category: 'String', inputs: [text()], result: BOOL, keywords: ['parse', 'bool', 'yes', 'no', 'on', 'off'],
    description: 'True for true, 1, yes, y or on; false for false, 0, no, n or off (any case, spaces around ignored). Anything else stops the run with an error.',
    code: {
      javascript: `const value = text.trim().toLowerCase();
if (['true', '1', 'yes', 'y', 'on'].includes(value)) return true;
if (['false', '0', 'no', 'n', 'off'].includes(value)) return false;
throw new Error('Not a boolean: "' + text + '"');`,
      python: `value = text.strip().lower()
if value in ("true", "1", "yes", "y", "on"):
    return True
if value in ("false", "0", "no", "n", "off"):
    return False
raise ValueError('Not a boolean: "' + text + '"')`,
      csharp: `var value = text.Trim().ToLowerInvariant();
if (value is "true" or "1" or "yes" or "y" or "on") return true;
if (value is "false" or "0" or "no" or "n" or "off") return false;
throw new ArgumentException("Not a boolean: \\"" + text + "\\"");`,
      cpp: `std::string value;
for (unsigned char c : text) value += static_cast<char>(std::tolower(c));
auto first = value.find_first_not_of(" \\t\\n\\r\\f\\v");
value = first == std::string::npos ? "" : value.substr(first, value.find_last_not_of(" \\t\\n\\r\\f\\v") - first + 1);
if (value == "true" || value == "1" || value == "yes" || value == "y" || value == "on") return true;
if (value == "false" || value == "0" || value == "no" || value == "n" || value == "off") return false;
throw std::invalid_argument("Not a boolean: \\"" + text + "\\"");`,
      rust: `return match text.trim().to_lowercase().as_str() {
    "true" | "1" | "yes" | "y" | "on" => true,
    "false" | "0" | "no" | "n" | "off" => false,
    _ => panic!("Not a boolean: \\"{}\\"", text),
};`,
      java: `String value = text.strip().toLowerCase(java.util.Locale.ROOT);
if (java.util.List.of("true", "1", "yes", "y", "on").contains(value)) return true;
if (java.util.List.of("false", "0", "no", "n", "off").contains(value)) return false;
throw new IllegalArgumentException("Not a boolean: \\"" + text + "\\"");`,
      go: `switch strings.ToLower(strings.TrimSpace(text)) {
case "true", "1", "yes", "y", "on":
\treturn true
case "false", "0", "no", "n", "off":
\treturn false
}
VgFail("Not a boolean: \\"" + text + "\\"")
return false`
    }
  },
  {
    type: 'core:string.parse-integer-strict', displayName: 'Parse Integer Strict', category: 'String', inputs: [text()], result: INT, keywords: ['parse', 'int', 'number', 'strict'],
    description: 'The whole number the text spells: an optional sign and digits, with spaces around ignored. Anything else, such as 12.0 or 12abc, stops the run with an error, as does a number beyond 2^53.',
    code: {
      javascript: `const value = text.trim();
if (!/^[+-]?[0-9]+$/.test(value)) throw new Error('Not an integer: "' + text + '"');
const result = Number(value);
if (!Number.isSafeInteger(result)) throw new Error('Integer out of range: "' + text + '"');
return result;`,
      python: `import re
value = text.strip()
if not re.fullmatch(r"[+-]?[0-9]+", value):
    raise ValueError('Not an integer: "' + text + '"')
result = int(value)
if abs(result) > 9007199254740991:
    raise ValueError('Integer out of range: "' + text + '"')
return result`,
      csharp: `var value = text.Trim();
if (!System.Text.RegularExpressions.Regex.IsMatch(value, "^[+-]?[0-9]+\\\\z")) throw new ArgumentException("Not an integer: \\"" + text + "\\"");
if (!long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var result) || Math.Abs(result) > 9007199254740991) throw new ArgumentException("Integer out of range: \\"" + text + "\\"");
return checked((int)result);`,
      cpp: `auto first = text.find_first_not_of(" \\t\\n\\r\\f\\v");
std::string value = first == std::string::npos ? "" : text.substr(first, text.find_last_not_of(" \\t\\n\\r\\f\\v") - first + 1);
std::size_t digits = value.empty() || (value[0] != '+' && value[0] != '-') ? 0 : 1;
if (digits == value.size()) throw std::invalid_argument("Not an integer: \\"" + text + "\\"");
for (std::size_t i = digits; i < value.size(); i++) if (value[i] < '0' || value[i] > '9') throw std::invalid_argument("Not an integer: \\"" + text + "\\"");
if (value.size() - digits > 16) throw std::out_of_range("Integer out of range: \\"" + text + "\\"");
long long result = std::stoll(value);
if (result > 9007199254740991LL || result < -9007199254740991LL) throw std::out_of_range("Integer out of range: \\"" + text + "\\"");
return result;`,
      rust: `let value = text.trim();
let digits = value.strip_prefix(|c| c == '+' || c == '-').unwrap_or(value);
if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) { panic!("Not an integer: \\"{}\\"", text); }
match value.parse::<i64>() {
    Ok(result) if result.abs() <= 9007199254740991 => return result,
    _ => panic!("Integer out of range: \\"{}\\"", text),
}`,
      java: `String value = text.strip();
if (!value.matches("[+-]?[0-9]+")) throw new IllegalArgumentException("Not an integer: \\"" + text + "\\"");
try {
    long result = Long.parseLong(value);
    if (Math.abs(result) > 9007199254740991L) throw new NumberFormatException();
    return result;
} catch (NumberFormatException error) {
    throw new IllegalArgumentException("Integer out of range: \\"" + text + "\\"");
}`,
      go: `value := strings.TrimSpace(text)
if !regexp.MustCompile("^[+-]?[0-9]+$").MatchString(value) {
\tVgFail("Not an integer: \\"" + text + "\\"")
}
result, err := strconv.ParseInt(value, 10, 64)
if err != nil || result > 9007199254740991 || result < -9007199254740991 {
\tVgFail("Integer out of range: \\"" + text + "\\"")
}
return int(result)`
    }
  },

  // ---- Arrays ----
  {
    type: 'core:array.unique', displayName: 'Unique', category: 'Utilities / Array', result: ARRAY, keywords: ['distinct', 'deduplicate', 'unique'],
    inputs: [input('items', 'Items', ARRAY)],
    description: 'The array\'s items, each once, in the order they first appear.',
    code: {
      javascript: 'return [...new Set(items)];',
      python: 'return list(dict.fromkeys(items))',
      csharp: 'return items.Distinct().ToList();',
      cpp: 'std::decay_t<decltype(items)> result;\nfor (const auto& item : items) if (std::find(result.begin(), result.end(), item) == result.end()) result.push_back(item);\nreturn result;',
      rust: 'let mut result = Vec::new();\nfor item in items.iter() {\n    if !result.contains(item) { result.push(item.clone()); }\n}\nreturn result;',
      java: 'return new java.util.ArrayList<>(new java.util.LinkedHashSet<>(items));',
      go: 'result := (*items)[:0:0]\nfor _, item := range *items {\n\tif !slices.Contains(result, item) {\n\t\tresult = append(result, item)\n\t}\n}\nreturn &result'
    }
  },
  {
    type: 'core:array.difference', displayName: 'Difference', category: 'Utilities / Array', result: ARRAY, keywords: ['except', 'minus', 'subtract', 'without'],
    inputs: [input('left', 'Left', ARRAY), input('right', 'Right', ARRAY)],
    description: 'The items of Left that aren\'t in Right, each once, in Left\'s order.', code: compare(false)
  },
  {
    type: 'core:array.intersection', displayName: 'Intersection', category: 'Utilities / Array', result: ARRAY, keywords: ['common', 'both', 'intersect'],
    inputs: [input('left', 'Left', ARRAY), input('right', 'Right', ARRAY)],
    description: 'The items of Left that are also in Right, each once, in Left\'s order.', code: compare(true)
  },
  {
    type: 'core:array.average', displayName: 'Average', category: 'Utilities / Array', result: FLOAT, keywords: ['mean', 'average', 'statistics'],
    inputs: [input('values', 'Values', FLOATS)],
    description: 'The mean of the values. An empty array stops the run with an error.',
    code: {
      javascript: "if (!values.length) throw new Error('Average needs at least one value');\nlet total = 0;\nfor (const value of values) total += value;\nreturn total / values.length;",
      python: 'if not values:\n    raise ValueError("Average needs at least one value")\ntotal = 0.0\nfor value in values:\n    total += value\nreturn total / len(values)',
      csharp: 'if (values.Count == 0) throw new InvalidOperationException("Average needs at least one value");\nvar total = 0.0;\nforeach (var value in values) total += value;\nreturn total / values.Count;',
      cpp: 'if (values.empty()) throw std::invalid_argument("Average needs at least one value");\ndouble total = 0;\nfor (double value : values) total += value;\nreturn total / static_cast<double>(values.size());',
      rust: 'if values.is_empty() { panic!("Average needs at least one value"); }\nlet mut total = 0.0;\nfor value in values.iter() { total += *value; }\nreturn total / values.len() as f64;',
      java: 'if (values.isEmpty()) throw new IllegalArgumentException("Average needs at least one value");\ndouble total = 0;\nfor (double value : values) total += value;\nreturn total / values.size();',
      go: 'if len(*values) == 0 {\n\tVgFail("Average needs at least one value")\n}\ntotal := 0.0\nfor _, value := range *values {\n\ttotal += value\n}\nreturn total / float64(len(*values))'
    }
  },
  {
    type: 'core:array.median', displayName: 'Median', category: 'Utilities / Array', result: FLOAT, keywords: ['median', 'middle', 'statistics'],
    inputs: [input('values', 'Values', FLOATS)],
    description: 'The middle value once the values are sorted, or the mean of the two middle ones. An empty array stops the run with an error.',
    code: {
      javascript: "if (!values.length) throw new Error('Median needs at least one value');\nconst sorted = [...values].sort((a, b) => a - b);\nconst middle = Math.floor(sorted.length / 2);\nreturn sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;",
      typescript: "if (!values.length) throw new Error('Median needs at least one value');\nconst sorted = [...values].sort((a, b) => a - b);\nconst middle = Math.floor(sorted.length / 2);\nreturn sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;",
      python: 'if not values:\n    raise ValueError("Median needs at least one value")\nordered = sorted(values)\nmiddle = len(ordered) // 2\nreturn ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2',
      csharp: 'if (values.Count == 0) throw new InvalidOperationException("Median needs at least one value");\nvar sorted = new List<double>(values);\nsorted.Sort();\nvar middle = sorted.Count / 2;\nreturn sorted.Count % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;',
      cpp: 'if (values.empty()) throw std::invalid_argument("Median needs at least one value");\nstd::vector<double> sorted(values.begin(), values.end());\nstd::sort(sorted.begin(), sorted.end());\nstd::size_t middle = sorted.size() / 2;\nreturn sorted.size() % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;',
      rust: 'if values.is_empty() { panic!("Median needs at least one value"); }\nlet mut sorted = values.clone();\nsorted.sort_by(|a, b| a.partial_cmp(b).unwrap());\nlet middle = sorted.len() / 2;\nreturn if sorted.len() % 2 == 1 { sorted[middle] } else { (sorted[middle - 1] + sorted[middle]) / 2.0 };',
      java: 'if (values.isEmpty()) throw new IllegalArgumentException("Median needs at least one value");\nvar sorted = new java.util.ArrayList<>(values);\nsorted.sort(null);\nint middle = sorted.size() / 2;\nreturn sorted.size() % 2 == 1 ? sorted.get(middle) : (sorted.get(middle - 1) + sorted.get(middle)) / 2;',
      go: 'if len(*values) == 0 {\n\tVgFail("Median needs at least one value")\n}\nsorted := append([]float64{}, *values...)\nsort.Float64s(sorted)\nmiddle := len(sorted) / 2\nif len(sorted)%2 == 1 {\n\treturn sorted[middle]\n}\nreturn (sorted[middle-1] + sorted[middle]) / 2'
    }
  },

  // ---- Maps ----
  {
    type: 'core:map.pick', displayName: 'Pick', category: 'Utilities / Map', result: MAP, keywords: ['select', 'keys', 'subset'],
    inputs: [input('source', 'Map', MAP), input('keys', 'Keys', ARRAY)],
    description: 'A map of the entries whose keys are in Keys, in Keys\' order. Keys the map doesn\'t have are left out.',
    code: {
      javascript: 'const result = new Map();\nfor (const key of keys) if (source.has(key) && !result.has(key)) result.set(key, source.get(key));\nreturn result;',
      python: 'return {key: source[key] for key in keys if key in source}',
      csharp: 'return keys.Where(source.ContainsKey).Distinct().ToDictionary(key => key, key => source[key]);',
      cpp: 'std::decay_t<decltype(source)> result;\nfor (const auto& key : keys) if (source.contains(key) && !result.contains(key)) result[key] = source.at(key);\nreturn result;',
      rust: 'let mut result = vgraph::Map::new();\nfor key in keys.iter() {\n    if let Some(value) = source.get(key) {\n        if !result.contains(key) { result.insert(key.clone(), value); }\n    }\n}\nreturn result;',
      java: 'var result = new java.util.LinkedHashMap<>(source);\nresult.clear();\nfor (var key : keys) if (source.containsKey(key) && !result.containsKey(key)) result.put(key, source.get(key));\nreturn result;',
      go: 'result := source.Empty()\nfor _, key := range *keys {\n\tif value, ok := source.Get(key); ok {\n\t\tif _, done := result.Get(key); !done {\n\t\t\tresult.Put(key, value)\n\t\t}\n\t}\n}\nreturn result'
    }
  },
  {
    type: 'core:map.omit', displayName: 'Omit', category: 'Utilities / Map', result: MAP, keywords: ['remove', 'exclude', 'without', 'keys'],
    inputs: [input('source', 'Map', MAP), input('keys', 'Keys', ARRAY)],
    description: 'A copy of the map without the entries whose keys are in Keys, in the map\'s order.',
    code: {
      javascript: 'const excluded = new Set(keys);\nreturn new Map([...source].filter(([key]) => !excluded.has(key)));',
      python: 'return {key: value for key, value in source.items() if key not in keys}',
      csharp: 'return source.Where(entry => !keys.Contains(entry.Key)).ToDictionary(entry => entry.Key, entry => entry.Value);',
      cpp: 'std::decay_t<decltype(source)> result;\nfor (const auto& entry : source) if (std::find(keys.begin(), keys.end(), entry.first) == keys.end()) result[entry.first] = entry.second;\nreturn result;',
      rust: 'let mut result = vgraph::Map::new();\nfor key in source.keys() {\n    if !keys.contains(&key) {\n        if let Some(value) = source.get(&key) { result.insert(key, value); }\n    }\n}\nreturn result;',
      java: 'var result = new java.util.LinkedHashMap<>(source);\nresult.keySet().removeAll(keys);\nreturn result;',
      go: 'result := source.Empty()\nfor _, key := range *source.Keys() {\n\tif !slices.Contains(*keys, key) {\n\t\tvalue, _ := source.Get(key)\n\t\tresult.Put(key, value)\n\t}\n}\nreturn result'
    }
  },

  // ---- System ----
  {
    type: 'core:utilities.get-env', displayName: 'Get Environment Variable', category: 'Utilities', result: STRING, keywords: ['env', 'environment', 'variable', 'config'],
    inputs: [input('name', 'Name', STRING, ''), input('fallback', 'Fallback', STRING, '')],
    description: 'The value of the environment variable called Name, or Fallback when it isn\'t set.',
    code: {
      javascript: 'const value = /** @type {any} */ (globalThis).process.env[name];\nreturn value === undefined ? fallback : value;',
      typescript: 'const value = (globalThis as any).process.env[name];\nreturn value === undefined ? fallback : (value as string);',
      python: 'import os\nreturn os.environ.get(name, fallback)',
      csharp: 'return Environment.GetEnvironmentVariable(name) ?? fallback;',
      cpp: 'const char* value = std::getenv(name.c_str());\nreturn value ? std::string(value) : fallback;',
      rust: 'return std::env::var(&name).unwrap_or(fallback);',
      java: 'String value = System.getenv(name);\nreturn value != null ? value : fallback;',
      go: 'if value, ok := os.LookupEnv(name); ok {\n\treturn value\n}\nreturn fallback'
    }
  },
  {
    type: 'core:file.normalize-path', displayName: 'Normalize Path', category: 'File', result: STRING, keywords: ['path', 'normalize', 'clean', 'file'],
    inputs: [input('path', 'Path', STRING, '')],
    description: 'The path tidied without looking at the disk, the same on every system: / and \\ both separate folders, "." and empty parts are dropped, ".." removes the folder before it, and the result uses /. A drive letter (C:) is kept.',
    code: {
      javascript: String.raw`let rest = path.replace(/\\/g, '/');
let drive = '';
if (/^[A-Za-z]:/.test(rest)) {
  drive = rest.slice(0, 2);
  rest = rest.slice(2);
}
const absolute = rest.startsWith('/');
const parts = [];
for (const part of rest.split('/')) {
  if (part === '' || part === '.') continue;
  if (part === '..') {
    if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (!absolute) parts.push('..');
  } else parts.push(part);
}
const joined = (absolute ? '/' : '') + parts.join('/');
return drive + (joined || '.');`,
      typescript: String.raw`let rest = path.replace(/\\/g, '/');
let drive = '';
if (/^[A-Za-z]:/.test(rest)) {
  drive = rest.slice(0, 2);
  rest = rest.slice(2);
}
const absolute = rest.startsWith('/');
const parts: string[] = [];
for (const part of rest.split('/')) {
  if (part === '' || part === '.') continue;
  if (part === '..') {
    if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (!absolute) parts.push('..');
  } else parts.push(part);
}
const joined = (absolute ? '/' : '') + parts.join('/');
return drive + (joined || '.');`,
      python: String.raw`rest = path.replace("\\", "/")
drive = ""
if len(rest) >= 2 and rest[1] == ":" and ("A" <= rest[0] <= "Z" or "a" <= rest[0] <= "z"):
    drive = rest[:2]
    rest = rest[2:]
absolute = rest.startswith("/")
parts: list[str] = []
for part in rest.split("/"):
    if part in ("", "."):
        continue
    if part == "..":
        if parts and parts[-1] != "..":
            parts.pop()
        elif not absolute:
            parts.append("..")
    else:
        parts.append(part)
joined = ("/" if absolute else "") + "/".join(parts)
return drive + (joined or ".")`,
      csharp: String.raw`var rest = path.Replace('\\', '/');
var drive = "";
if (rest.Length >= 2 && rest[1] == ':' && ((rest[0] >= 'A' && rest[0] <= 'Z') || (rest[0] >= 'a' && rest[0] <= 'z')))
{
    drive = rest.Substring(0, 2);
    rest = rest.Substring(2);
}
var absolute = rest.StartsWith('/');
var parts = new List<string>();
foreach (var part in rest.Split('/'))
{
    if (part == "" || part == ".") continue;
    if (part == "..")
    {
        if (parts.Count > 0 && parts[parts.Count - 1] != "..") parts.RemoveAt(parts.Count - 1);
        else if (!absolute) parts.Add("..");
    }
    else parts.Add(part);
}
var joined = (absolute ? "/" : "") + string.Join("/", parts);
return drive + (joined.Length > 0 ? joined : ".");`,
      cpp: String.raw`std::string rest = path;
std::replace(rest.begin(), rest.end(), '\\', '/');
std::string drive;
if (rest.size() >= 2 && rest[1] == ':' && std::isalpha(static_cast<unsigned char>(rest[0]))) {
    drive = rest.substr(0, 2);
    rest = rest.substr(2);
}
bool absolute = !rest.empty() && rest[0] == '/';
std::vector<std::string> parts;
std::size_t at = 0;
while (at <= rest.size()) {
    std::size_t next = rest.find('/', at);
    if (next == std::string::npos) next = rest.size();
    std::string part = rest.substr(at, next - at);
    at = next + 1;
    if (part.empty() || part == ".") continue;
    if (part == "..") {
        if (!parts.empty() && parts.back() != "..") parts.pop_back();
        else if (!absolute) parts.push_back("..");
    } else {
        parts.push_back(part);
    }
}
std::string joined = absolute ? "/" : "";
for (std::size_t i = 0; i < parts.size(); i++) joined += (i ? "/" : "") + parts[i];
return drive + (joined.empty() ? "." : joined);`,
      rust: String.raw`let mut rest = path.replace('\\', "/");
let mut drive = String::new();
let bytes = rest.as_bytes();
if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
    drive = rest[..2].to_string();
    rest = rest[2..].to_string();
}
let absolute = rest.starts_with('/');
let mut parts: Vec<&str> = Vec::new();
for part in rest.split('/') {
    if part.is_empty() || part == "." { continue; }
    if part == ".." {
        if !parts.is_empty() && *parts.last().unwrap() != ".." { parts.pop(); } else if !absolute { parts.push(".."); }
    } else {
        parts.push(part);
    }
}
let joined = format!("{}{}", if absolute { "/" } else { "" }, parts.join("/"));
return drive + if joined.is_empty() { "." } else { &joined };`,
      java: String.raw`String rest = path.replace('\\', '/');
String drive = "";
if (rest.length() >= 2 && rest.charAt(1) == ':' && ((rest.charAt(0) >= 'A' && rest.charAt(0) <= 'Z') || (rest.charAt(0) >= 'a' && rest.charAt(0) <= 'z'))) {
    drive = rest.substring(0, 2);
    rest = rest.substring(2);
}
boolean absolute = rest.startsWith("/");
var parts = new java.util.ArrayList<String>();
for (String part : rest.split("/", -1)) {
    if (part.isEmpty() || part.equals(".")) continue;
    if (part.equals("..")) {
        if (!parts.isEmpty() && !parts.get(parts.size() - 1).equals("..")) parts.remove(parts.size() - 1);
        else if (!absolute) parts.add("..");
    } else {
        parts.add(part);
    }
}
String joined = (absolute ? "/" : "") + String.join("/", parts);
return drive + (joined.isEmpty() ? "." : joined);`,
      go: String.raw`rest := strings.ReplaceAll(path, "\\", "/")
drive := ""
if len(rest) >= 2 && rest[1] == ':' && ((rest[0] >= 'A' && rest[0] <= 'Z') || (rest[0] >= 'a' && rest[0] <= 'z')) {
	drive = rest[:2]
	rest = rest[2:]
}
absolute := strings.HasPrefix(rest, "/")
parts := []string{}
for _, part := range strings.Split(rest, "/") {
	if part == "" || part == "." {
		continue
	}
	if part == ".." {
		if len(parts) > 0 && parts[len(parts)-1] != ".." {
			parts = parts[:len(parts)-1]
		} else if !absolute {
			parts = append(parts, "..")
		}
	} else {
		parts = append(parts, part)
	}
}
joined := strings.Join(parts, "/")
if absolute {
	joined = "/" + joined
}
if joined == "" {
	joined = "."
}
return drive + joined`
    }
  }
];

// ---- Lua ----------------------------------------------------------------------------------------
//
// The Lua versions, by node type (docs/more-languages.md, "Lua"): text through the utf8 library,
// containers the runtime's (lua-runtime.ts). Lua's patterns are ASCII, so whitespace and upper case
// are ASCII here, as in C++. `end` is a Lua keyword, so In Range names that pin as ${end}.

const LUA_WORDS = String.raw`local chars = vg.chars(text)
local function kind(c)
  if c:match("^%u$") then return "upper" end
  if c:match("^%l$") then return "lower" end
  if c:match("^%d$") then return "digit" end
  return nil
end
local words, word = {}, ""
for i, c in ipairs(chars) do
  local k = kind(c)
  if not k then
    if word ~= "" then words[#words + 1] = word:lower() end
    word = ""
  else
    local prev = kind(word:sub(-1))
    local following = kind(chars[i + 1] or "")
    if word ~= "" and k == "upper" and (prev == "lower" or prev == "digit" or (prev == "upper" and following == "lower")) then
      words[#words + 1] = word:lower()
      word = ""
    end
    word = word .. c
  end
end
if word ~= "" then words[#words + 1] = word:lower() end`;

const luaPad = (left: boolean) => String.raw`if utf8.len(fill) ~= 1 then error("Fill must be one character", 0) end
local missing = width - (utf8.len(text) or #text)
local padding = missing > 0 and string.rep(fill, missing) or ""
return ${left ? 'padding .. text' : 'text .. padding'}`;

// Unique items of a list, in order (nil items are skipped: they can't be table keys).
const luaUnique = (keep: string) => String.raw`local seen, result = {}, vg.array()
for i = 1, left.n do
  local item = left[i]
  if item ~= nil and ${keep} and not seen[item] then
    seen[item] = true
    result.n = result.n + 1
    result[result.n] = item
  end
end
return result`;

const LUA: Record<string, string> = {
  'core:string.is-empty': 'return text == ""',
  'core:string.is-blank': 'return text:match("^%s*$") ~= nil',
  'core:string.normalize-whitespace': 'local words = {}\nfor word in text:gmatch("%S+") do words[#words + 1] = word end\nreturn table.concat(words, " ")',
  'core:string.truncate': String.raw`if maxLength < 0 then error("Max Length can't be negative", 0) end
local chars = vg.chars(text)
if #chars <= maxLength then return text end
local ending = vg.chars(suffix)
return table.concat(chars, "", 1, math.max(0, maxLength - #ending)) .. table.concat(ending, "", 1, math.min(#ending, maxLength))`,
  'core:string.capitalize': 'return (text:gsub("^%l", string.upper))',
  'core:string.to-camel-case': `${LUA_WORDS}\nfor i = 2, #words do words[i] = words[i]:sub(1, 1):upper() .. words[i]:sub(2) end\nreturn table.concat(words)`,
  'core:string.to-snake-case': `${LUA_WORDS}\nreturn table.concat(words, "_")`,
  'core:string.to-kebab-case': `${LUA_WORDS}\nreturn table.concat(words, "-")`,
  'core:string.slugify': `${LUA_WORDS}\nreturn table.concat(words, "-")`,
  'core:string.pad-left': luaPad(true),
  'core:string.pad-right': luaPad(false),
  'core:string.word-count': 'local count = 0\nfor _ in text:gmatch("%S+") do count = count + 1 end\nreturn count',
  'core:string.mask': String.raw`if visibleStart < 0 or visibleEnd < 0 then error("Visible counts can't be negative", 0) end
if utf8.len(mask) ~= 1 then error("Mask must be one character", 0) end
local chars = vg.chars(text)
local first = math.min(visibleStart, #chars)
local last = math.min(visibleEnd, #chars - first)
return table.concat(chars, "", 1, first) .. string.rep(mask, #chars - first - last) .. table.concat(chars, "", #chars - last + 1, #chars)`,
  'core:math.in-range': 'if start > ${end} then error("Start can\'t be greater than End", 0) end\nreturn value >= start and value < ${end}',
  'core:math.round-to': String.raw`if value ~= value or value == math.huge or value == -math.huge then error("Value must be a finite number", 0) end
if digits < 0 or digits > 15 then error("Digits must be from 0 to 15", 0) end
local factor = 10.0 ^ digits
local sign = value > 0 and 1 or (value < 0 and -1 or 0)
return sign * math.floor((math.abs(value) + 2.220446049250313e-16) * factor + 0.5) / factor`,
  'core:string.format-bytes': String.raw`if size ~= size or size < 0 or size > 9007199254740992 then error("Size must be from 0 to 2^53", 0) end
if decimals < 0 or decimals > 10 then error("Decimals must be from 0 to 10", 0) end
if size < 1024 then return string.format("%d", math.floor(size)) .. " B" end
local units = { "KiB", "MiB", "GiB", "TiB", "PiB" }
local value, index = size, 0
repeat
  value = value / 1024
  index = index + 1
until not (value >= 1024 and index < #units)
local scale = 10 ^ decimals
local scaled = math.floor(value * scale + 0.5)
local whole = math.floor(scaled / scale)
local fraction = decimals > 0 and ("." .. string.format("%0" .. decimals .. "d", math.floor(scaled - whole * scale))) or ""
return string.format("%d", whole) .. fraction .. " " .. units[index]`,
  'core:string.parse-boolean': String.raw`local value = text:match("^%s*(.-)%s*$"):lower()
if value == "true" or value == "1" or value == "yes" or value == "y" or value == "on" then return true end
if value == "false" or value == "0" or value == "no" or value == "n" or value == "off" then return false end
error('Not a boolean: "' .. text .. '"', 0)`,
  'core:string.parse-integer-strict': String.raw`local value = text:match("^%s*(.-)%s*$")
if not value:match("^[+-]?%d+$") then error('Not an integer: "' .. text .. '"', 0) end
local digits = value:gsub("^[+-]", "")
local result = tonumber(value)
if #digits > 16 or math.type(result) ~= "integer" or result > 9007199254740991 or result < -9007199254740991 then error('Integer out of range: "' .. text .. '"', 0) end
return result`,
  'core:array.unique': luaUnique('true').replace(/left/g, 'items'),
  'core:array.difference': `local other = {}\nfor i = 1, right.n do if right[i] ~= nil then other[right[i]] = true end end\n${luaUnique('not other[item]')}`,
  'core:array.intersection': `local other = {}\nfor i = 1, right.n do if right[i] ~= nil then other[right[i]] = true end end\n${luaUnique('other[item]')}`,
  'core:array.average': 'if values.n == 0 then error("Average needs at least one value", 0) end\nlocal total = 0\nfor i = 1, values.n do total = total + values[i] end\nreturn total / values.n',
  'core:array.median': String.raw`if values.n == 0 then error("Median needs at least one value", 0) end
local sorted = {}
for i = 1, values.n do sorted[i] = values[i] end
table.sort(sorted)
local middle = values.n // 2
if values.n % 2 == 1 then return sorted[middle + 1] end
return (sorted[middle] + sorted[middle + 1]) / 2`,
  'core:map.pick': 'local result = vg.map()\nfor i = 1, keys.n do\n  local key = keys[i]\n  if source:contains(key) and not result:contains(key) then result:put(key, source:get(key)) end\nend\nreturn result',
  'core:map.omit': 'local excluded = {}\nfor i = 1, keys.n do if keys[i] ~= nil then excluded[keys[i]] = true end end\nlocal result = vg.map()\nfor i = 1, source.n do\n  local key = source.keys[i]\n  if not excluded[key] then result:put(key, source:get(key)) end\nend\nreturn result',
  'core:utilities.get-env': 'return os.getenv(name) or fallback',
  'core:file.normalize-path': String.raw`local rest = path:gsub("\\", "/")
local drive = ""
if rest:match("^%a:") then
  drive = rest:sub(1, 2)
  rest = rest:sub(3)
end
local absolute = rest:sub(1, 1) == "/"
local parts = {}
for part in rest:gmatch("[^/]+") do
  if part == ".." then
    if #parts > 0 and parts[#parts] ~= ".." then
      parts[#parts] = nil
    elseif not absolute then
      parts[#parts + 1] = ".."
    end
  elseif part ~= "." then
    parts[#parts + 1] = part
  end
end
local joined = (absolute and "/" or "") .. table.concat(parts, "/")
return drive .. (joined ~= "" and joined or ".")`
};

// ---- GDScript -----------------------------------------------------------------------------------
//
// The GDScript versions, by node type (docs/more-languages.md, "GDScript"): Godot's strings are
// code points already; a broken rule is vg.fail, which returns null for the snippet to return.

const GD_WORDS = [
  'var words := PackedStringArray()',
  'var word := ""',
  'for i in text.length():',
  '\tvar c := text[i]',
  '\tvar upper := c >= "A" and c <= "Z"',
  '\tif not (upper or (c >= "a" and c <= "z") or (c >= "0" and c <= "9")):',
  '\t\tif word != "":',
  '\t\t\twords.append(word.to_lower())',
  '\t\tword = ""',
  '\t\tcontinue',
  '\tvar prev := word[word.length() - 1] if word != "" else ""',
  '\tvar following := text[i + 1] if i + 1 < text.length() else ""',
  '\tvar split := (prev >= "a" and prev <= "z") or (prev >= "0" and prev <= "9") or (prev >= "A" and prev <= "Z" and following >= "a" and following <= "z")',
  '\tif word != "" and upper and split:',
  '\t\twords.append(word.to_lower())',
  '\t\tword = ""',
  '\tword += c',
  'if word != "":',
  '\twords.append(word.to_lower())'
].join('\n');

const gdPad = (left: boolean) => `if fill.length() != 1:\n\treturn vg.fail("Fill must be one character")\nvar missing := width - text.length()\nvar padding := fill.repeat(missing) if missing > 0 else ""\nreturn ${left ? 'padding + text' : 'text + padding'}`;

// Unique items of `left` that pass `keep`, in order.
const gdUnique = (keep: string) => `var seen := {}\nvar result := []\nfor item in left:\n\tif ${keep} and not seen.has(item):\n\t\tseen[item] = true\n\t\tresult.append(item)\nreturn result`;
const GD_OTHER = 'var other := {}\nfor item in right:\n\tother[item] = true';

const GDSCRIPT: Record<string, string> = {
  'core:string.is-empty': 'return text.is_empty()',
  'core:string.is-blank': 'return text.strip_edges().is_empty()',
  'core:string.normalize-whitespace': 'var words := PackedStringArray()\nfor found in RegEx.create_from_string(r"\\S+").search_all(text):\n\twords.append(found.get_string())\nreturn " ".join(words)',
  'core:string.truncate': 'if maxLength < 0:\n\treturn vg.fail("Max Length can\'t be negative")\nif text.length() <= maxLength:\n\treturn text\nreturn text.substr(0, maxi(0, maxLength - suffix.length())) + suffix.substr(0, maxLength)',
  'core:string.capitalize': 'if text.is_empty():\n\treturn text\nreturn text.substr(0, 1).to_upper() + text.substr(1)',
  'core:string.to-camel-case': `${GD_WORDS}\nfor i in range(1, words.size()):\n\twords[i] = words[i].substr(0, 1).to_upper() + words[i].substr(1)\nreturn "".join(words)`,
  'core:string.to-snake-case': `${GD_WORDS}\nreturn "_".join(words)`,
  'core:string.to-kebab-case': `${GD_WORDS}\nreturn "-".join(words)`,
  'core:string.slugify': `${GD_WORDS}\nreturn "-".join(words)`,
  'core:string.pad-left': gdPad(true),
  'core:string.pad-right': gdPad(false),
  'core:string.word-count': 'return RegEx.create_from_string(r"\\S+").search_all(text).size()',
  'core:string.mask': [
    'if visibleStart < 0 or visibleEnd < 0:',
    '\treturn vg.fail("Visible counts can\'t be negative")',
    'if mask.length() != 1:',
    '\treturn vg.fail("Mask must be one character")',
    'var length := text.length()',
    'var first := mini(visibleStart, length)',
    'var last := mini(visibleEnd, length - first)',
    'return text.substr(0, first) + mask.repeat(length - first - last) + text.substr(length - last)'
  ].join('\n'),
  // `start` is the class's Start method in GDScript, so the pins are named through ${...}.
  'core:math.in-range': 'if ${start} > ${end}:\n\treturn vg.fail("Start can\'t be greater than End")\nreturn value >= ${start} and value < ${end}',
  'core:math.round-to': [
    'if is_nan(value) or is_inf(value):',
    '\treturn vg.fail("Value must be a finite number")',
    'if digits < 0 or digits > 15:',
    '\treturn vg.fail("Digits must be from 0 to 15")',
    'var factor := pow(10.0, digits)',
    'var direction := 1.0 if value > 0 else (-1.0 if value < 0 else 0.0)',
    'return direction * floorf((absf(value) + 2.220446049250313e-16) * factor + 0.5) / factor'
  ].join('\n'),
  'core:string.format-bytes': [
    'if is_nan(size) or size < 0 or size > 9007199254740992.0:',
    '\treturn vg.fail("Size must be from 0 to 2^53")',
    'if decimals < 0 or decimals > 10:',
    '\treturn vg.fail("Decimals must be from 0 to 10")',
    'if size < 1024:',
    '\treturn str(int(size)) + " B"',
    'var units := ["KiB", "MiB", "GiB", "TiB", "PiB"]',
    'var value := size',
    'var index := -1',
    'while true:',
    '\tvalue /= 1024.0',
    '\tindex += 1',
    '\tif not (value >= 1024 and index < units.size() - 1):',
    '\t\tbreak',
    'var scale := pow(10.0, decimals)',
    'var scaled := floorf(value * scale + 0.5)',
    'var whole := floorf(scaled / scale)',
    'var fraction := str(int(scaled - whole * scale)).pad_zeros(decimals)',
    'return str(int(whole)) + ("." + fraction if decimals > 0 else "") + " " + units[index]'
  ].join('\n'),
  'core:string.parse-boolean': [
    'var value := text.strip_edges().to_lower()',
    'if value in ["true", "1", "yes", "y", "on"]:',
    '\treturn true',
    'if value in ["false", "0", "no", "n", "off"]:',
    '\treturn false',
    'return vg.fail(\'Not a boolean: "\' + text + \'"\')'
  ].join('\n'),
  'core:string.parse-integer-strict': [
    'var value := text.strip_edges()',
    'if RegEx.create_from_string(r"^[+-]?[0-9]+$").search(value) == null:',
    '\treturn vg.fail(\'Not an integer: "\' + text + \'"\')',
    'var digits := value.trim_prefix("+").trim_prefix("-")',
    'if digits.length() > 16:',
    '\treturn vg.fail(\'Integer out of range: "\' + text + \'"\')',
    'var result := digits.to_int()',
    'if result > 9007199254740991:',
    '\treturn vg.fail(\'Integer out of range: "\' + text + \'"\')',
    'return -result if value.begins_with("-") else result'
  ].join('\n'),
  'core:array.unique': gdUnique('true').replace(/left/g, 'items'),
  'core:array.difference': `${GD_OTHER}\n${gdUnique('not other.has(item)')}`,
  'core:array.intersection': `${GD_OTHER}\n${gdUnique('other.has(item)')}`,
  'core:array.average': 'if values.is_empty():\n\treturn vg.fail("Average needs at least one value")\nvar total := 0.0\nfor value in values:\n\ttotal += value\nreturn total / values.size()',
  'core:array.median': 'if values.is_empty():\n\treturn vg.fail("Median needs at least one value")\nvar sorted = values.duplicate()\nsorted.sort()\nvar middle = sorted.size() / 2\nreturn sorted[middle] if sorted.size() % 2 == 1 else (sorted[middle - 1] + sorted[middle]) / 2.0',
  'core:map.pick': 'var result := {}\nfor key in keys:\n\tif source.has(key) and not result.has(key):\n\t\tresult[key] = source[key]\nreturn result',
  'core:map.omit': 'var excluded := {}\nfor key in keys:\n\texcluded[key] = true\nvar result := {}\nfor key in source:\n\tif not excluded.has(key):\n\t\tresult[key] = source[key]\nreturn result',
  'core:utilities.get-env': 'return OS.get_environment(name) if OS.has_environment(name) else fallback',
  'core:file.normalize-path': [
    'var rest := path.replace("\\\\", "/")',
    'var drive := ""',
    'if rest.length() >= 2 and rest[1] == ":" and ((rest[0] >= "A" and rest[0] <= "Z") or (rest[0] >= "a" and rest[0] <= "z")):',
    '\tdrive = rest.substr(0, 2)',
    '\trest = rest.substr(2)',
    'var absolute := rest.begins_with("/")',
    'var parts := PackedStringArray()',
    'for part in rest.split("/"):',
    '\tif part == "" or part == ".":',
    '\t\tcontinue',
    '\tif part == "..":',
    '\t\tif parts.size() > 0 and parts[parts.size() - 1] != "..":',
    '\t\t\tparts.remove_at(parts.size() - 1)',
    '\t\telif not absolute:',
    '\t\t\tparts.append("..")',
    '\telse:',
    '\t\tparts.append(part)',
    'var joined := ("/" if absolute else "") + "/".join(parts)',
    'return drive + (joined if joined != "" else ".")'
  ].join('\n')
};

// ---- Ruby ---------------------------------------------------------------------------------------
//
// The Ruby versions, by node type (docs/more-languages.md, "Ruby"): Ruby's strings count characters
// already; a broken rule raises. `end` is a Ruby keyword, so In Range names that pin as ${end}.

const RB_WORDS = [
  'chars = text.chars',
  'kind = lambda do |c|',
  '  next :upper if c&.match?(/\\A[A-Z]\\z/)',
  '  next :lower if c&.match?(/\\A[a-z]\\z/)',
  '  next :digit if c&.match?(/\\A[0-9]\\z/)',
  '  nil',
  'end',
  'words = []',
  'word = String.new',
  'chars.each_with_index do |c, i|',
  '  k = kind.call(c)',
  '  unless k',
  '    words << word.downcase unless word.empty?',
  '    word = String.new',
  '    next',
  '  end',
  '  prev = kind.call(word[-1])',
  '  following = kind.call(chars[i + 1])',
  '  if !word.empty? && k == :upper && (prev == :lower || prev == :digit || (prev == :upper && following == :lower))',
  '    words << word.downcase',
  '    word = String.new',
  '  end',
  '  word << c',
  'end',
  'words << word.downcase unless word.empty?'
].join('\n');

const rbPad = (left: boolean) => `raise ArgumentError, "Fill must be one character" unless fill.length == 1\nmissing = width - text.length\npadding = missing > 0 ? fill * missing : ""\nreturn ${left ? 'padding + text' : 'text + padding'}`;

const RUBY: Record<string, string> = {
  'core:string.is-empty': 'return text.empty?',
  'core:string.is-blank': 'return text.strip.empty?',
  'core:string.normalize-whitespace': 'return text.split.join(" ")',
  'core:string.truncate': 'raise ArgumentError, "Max Length can\'t be negative" if maxLength < 0\nreturn text if text.length <= maxLength\nreturn text[0, [0, maxLength - suffix.length].max] + suffix[0, maxLength]',
  'core:string.capitalize': 'return text.empty? ? text : text[0].upcase + text[1..]',
  'core:string.to-camel-case': `${RB_WORDS}\nreturn words.each_with_index.map { |w, i| i.zero? ? w : w[0].upcase + w[1..] }.join`,
  'core:string.to-snake-case': `${RB_WORDS}\nreturn words.join("_")`,
  'core:string.to-kebab-case': `${RB_WORDS}\nreturn words.join("-")`,
  'core:string.slugify': `${RB_WORDS}\nreturn words.join("-")`,
  'core:string.pad-left': rbPad(true),
  'core:string.pad-right': rbPad(false),
  'core:string.word-count': 'return text.split.length',
  'core:string.mask': [
    'raise ArgumentError, "Visible counts can\'t be negative" if visibleStart < 0 || visibleEnd < 0',
    'raise ArgumentError, "Mask must be one character" unless mask.length == 1',
    'length = text.length',
    'first = [visibleStart, length].min',
    'last = [visibleEnd, length - first].min',
    'return text[0, first] + mask * (length - first - last) + text[length - last, last]'
  ].join('\n'),
  'core:math.in-range': 'raise ArgumentError, "Start can\'t be greater than End" if start > ${end}\nreturn value >= start && value < ${end}',
  'core:math.round-to': [
    'raise ArgumentError, "Value must be a finite number" unless value.to_f.finite?',
    'raise ArgumentError, "Digits must be from 0 to 15" if digits < 0 || digits > 15',
    'factor = 10.0**digits',
    'direction = value > 0 ? 1 : (value < 0 ? -1 : 0)',
    'return direction * ((value.abs + 2.220446049250313e-16) * factor + 0.5).floor / factor'
  ].join('\n'),
  'core:string.format-bytes': [
    'raise ArgumentError, "Size must be from 0 to 2^53" if !size.to_f.finite? || size < 0 || size > 9007199254740992',
    'raise ArgumentError, "Decimals must be from 0 to 10" if decimals < 0 || decimals > 10',
    'return "#{size.to_i} B" if size < 1024',
    'units = %w[KiB MiB GiB TiB PiB]',
    'value = size.to_f',
    'index = -1',
    'loop do',
    '  value /= 1024',
    '  index += 1',
    '  break unless value >= 1024 && index < units.length - 1',
    'end',
    'scale = 10**decimals',
    'scaled = (value * scale + 0.5).floor',
    'whole = scaled / scale',
    'fraction = (scaled - whole * scale).to_s.rjust(decimals, "0")',
    'return "#{whole}#{decimals > 0 ? ".#{fraction}" : ""} #{units[index]}"'
  ].join('\n'),
  'core:string.parse-boolean': [
    'value = text.strip.downcase',
    'return true if %w[true 1 yes y on].include?(value)',
    'return false if %w[false 0 no n off].include?(value)',
    'raise ArgumentError, "Not a boolean: \\"#{text}\\""'
  ].join('\n'),
  'core:string.parse-integer-strict': [
    'value = text.strip',
    'raise ArgumentError, "Not an integer: \\"#{text}\\"" unless value.match?(/\\A[+-]?[0-9]+\\z/)',
    'result = value.to_i',
    'raise ArgumentError, "Integer out of range: \\"#{text}\\"" if result.abs > 9007199254740991',
    'return result'
  ].join('\n'),
  'core:array.unique': 'return items.uniq',
  'core:array.difference': 'return (left - right).uniq',
  'core:array.intersection': 'return left & right',
  // Added in order, as JavaScript adds (Array#sum compensates for rounding).
  'core:array.average': 'raise ArgumentError, "Average needs at least one value" if values.empty?\nreturn values.inject(0.0) { |total, value| total + value } / values.length',
  'core:array.median': 'raise ArgumentError, "Median needs at least one value" if values.empty?\nsorted = values.sort\nmiddle = sorted.length / 2\nreturn sorted.length.odd? ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2.0',
  'core:map.pick': 'result = {}\nkeys.each { |key| result[key] = source[key] if source.key?(key) && !result.key?(key) }\nreturn result',
  'core:map.omit': 'return source.reject { |key, _| keys.include?(key) }',
  'core:utilities.get-env': 'return ENV.fetch(name, fallback)',
  'core:file.normalize-path': [
    'rest = path.tr("\\\\", "/")',
    'drive = ""',
    'if rest.match?(/\\A[A-Za-z]:/)',
    '  drive = rest[0, 2]',
    '  rest = rest[2..]',
    'end',
    'absolute = rest.start_with?("/")',
    'parts = []',
    'rest.split("/").each do |part|',
    '  next if part.empty? || part == "."',
    '  if part == ".."',
    '    if !parts.empty? && parts.last != ".."',
    '      parts.pop',
    '    elsif !absolute',
    '      parts << ".."',
    '    end',
    '  else',
    '    parts << part',
    '  end',
    'end',
    'joined = (absolute ? "/" : "") + parts.join("/")',
    'return drive + (joined.empty? ? "." : joined)'
  ].join('\n')
};

// ---- PHP ----------------------------------------------------------------------------------------
//
// The PHP versions, by node type (docs/more-languages.md, "PHP"): text through mbstring (code points),
// containers the support file's VgList and VgMap, and items compared as the semantics do (Vg::equal).

const PHP_WORDS = String.raw`$chars = mb_str_split($text);
$kind = function (?string $c): ?string {
    if ($c === null || strlen($c) !== 1) {
        return null;
    }
    if ($c >= 'A' && $c <= 'Z') {
        return 'upper';
    }
    if ($c >= 'a' && $c <= 'z') {
        return 'lower';
    }
    return ctype_digit($c) ? 'digit' : null;
};
$words = [];
$word = '';
foreach ($chars as $i => $c) {
    $k = $kind($c);
    if ($k === null) {
        if ($word !== '') {
            $words[] = strtolower($word);
        }
        $word = '';
        continue;
    }
    $prev = $word === '' ? null : $kind(substr($word, -1));
    $following = $kind($chars[$i + 1] ?? null);
    if ($word !== '' && $k === 'upper' && ($prev === 'lower' || $prev === 'digit' || ($prev === 'upper' && $following === 'lower'))) {
        $words[] = strtolower($word);
        $word = '';
    }
    $word .= $c;
}
if ($word !== '') {
    $words[] = strtolower($word);
}`;

const phpPad = (left: boolean) => String.raw`if (mb_strlen($fill) !== 1) {
    throw new \InvalidArgumentException('Fill must be one character');
}
$missing = $width - mb_strlen($text);
$padding = $missing > 0 ? str_repeat($fill, $missing) : '';
return ` + (left ? '$padding . $text;' : '$text . $padding;');

// Items of $left that pass `keep`, each once, in order.
const phpUnique = (keep: string) => String.raw`$result = [];
foreach ($left->items as $item) {
    if (!(` + keep + String.raw`)) {
        continue;
    }
    foreach ($result as $x) {
        if (Vg::equal($x, $item)) {
            continue 2;
        }
    }
    $result[] = $item;
}
return new VgList($result);`;
const phpIn = (list: string) => `array_filter(${list}->items, fn ($x) => Vg::equal($x, $item)) !== []`;

const PHP: Record<string, string> = {
  'core:string.is-empty': "return $text === '';",
  'core:string.is-blank': "return trim($text) === '';",
  'core:string.normalize-whitespace': "return implode(' ', preg_split('/\\s+/', trim($text), -1, PREG_SPLIT_NO_EMPTY));",
  'core:string.truncate': String.raw`if ($maxLength < 0) {
    throw new \InvalidArgumentException("Max Length can't be negative");
}
if (mb_strlen($text) <= $maxLength) {
    return $text;
}
return mb_substr($text, 0, max(0, $maxLength - mb_strlen($suffix))) . mb_substr($suffix, 0, $maxLength);`,
  'core:string.capitalize': "return $text === '' ? $text : mb_strtoupper(mb_substr($text, 0, 1)) . mb_substr($text, 1);",
  'core:string.to-camel-case': `${PHP_WORDS}\nforeach ($words as $i => $w) {\n    if ($i > 0) {\n        $words[$i] = ucfirst($w);\n    }\n}\nreturn implode('', $words);`,
  'core:string.to-snake-case': `${PHP_WORDS}\nreturn implode('_', $words);`,
  'core:string.to-kebab-case': `${PHP_WORDS}\nreturn implode('-', $words);`,
  'core:string.slugify': `${PHP_WORDS}\nreturn implode('-', $words);`,
  'core:string.pad-left': phpPad(true),
  'core:string.pad-right': phpPad(false),
  'core:string.word-count': "return count(preg_split('/\\s+/', trim($text), -1, PREG_SPLIT_NO_EMPTY));",
  'core:string.mask': String.raw`if ($visibleStart < 0 || $visibleEnd < 0) {
    throw new \InvalidArgumentException("Visible counts can't be negative");
}
if (mb_strlen($mask) !== 1) {
    throw new \InvalidArgumentException('Mask must be one character');
}
$length = mb_strlen($text);
$first = min($visibleStart, $length);
$last = min($visibleEnd, $length - $first);
return mb_substr($text, 0, $first) . str_repeat($mask, $length - $first - $last) . mb_substr($text, $length - $last);`,
  'core:math.in-range': String.raw`if ($start > $end) {
    throw new \InvalidArgumentException("Start can't be greater than End");
}
return $value >= $start && $value < $end;`,
  'core:math.round-to': String.raw`if (!is_finite((float) $value)) {
    throw new \InvalidArgumentException('Value must be a finite number');
}
if ($digits < 0 || $digits > 15) {
    throw new \InvalidArgumentException('Digits must be from 0 to 15');
}
$factor = 10 ** $digits;
return ($value <=> 0) * floor((abs($value) + 2.220446049250313e-16) * $factor + 0.5) / $factor;`,
  'core:string.format-bytes': String.raw`if (!is_finite((float) $size) || $size < 0 || $size > 9007199254740992) {
    throw new \InvalidArgumentException('Size must be from 0 to 2^53');
}
if ($decimals < 0 || $decimals > 10) {
    throw new \InvalidArgumentException('Decimals must be from 0 to 10');
}
if ($size < 1024) {
    return (int) $size . ' B';
}
$units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
$value = (float) $size;
$index = -1;
do {
    $value /= 1024;
    $index++;
} while ($value >= 1024 && $index < count($units) - 1);
$scale = 10 ** $decimals;
$scaled = floor($value * $scale + 0.5);
$whole = floor($scaled / $scale);
$fraction = str_pad((string) (int) ($scaled - $whole * $scale), $decimals, '0', STR_PAD_LEFT);
return (int) $whole . ($decimals > 0 ? '.' . $fraction : '') . ' ' . $units[$index];`,
  'core:string.parse-boolean': String.raw`$value = mb_strtolower(trim($text));
if (in_array($value, ['true', '1', 'yes', 'y', 'on'], true)) {
    return true;
}
if (in_array($value, ['false', '0', 'no', 'n', 'off'], true)) {
    return false;
}
throw new \InvalidArgumentException('Not a boolean: "' . $text . '"');`,
  'core:string.parse-integer-strict': String.raw`$value = trim($text);
if (!preg_match('/^[+-]?[0-9]+$/D', $value)) {
    throw new \InvalidArgumentException('Not an integer: "' . $text . '"');
}
if (strlen(ltrim($value, '+-')) > 16 || abs((int) $value) > 9007199254740991) {
    throw new \InvalidArgumentException('Integer out of range: "' . $text . '"');
}
return (int) $value;`,
  'core:array.unique': phpUnique('true').replace(/\$left/g, '$items'),
  'core:array.difference': phpUnique(`!(${phpIn('$right')})`),
  'core:array.intersection': phpUnique(phpIn('$right')),
  'core:array.average': String.raw`if (count($values->items) === 0) {
    throw new \InvalidArgumentException('Average needs at least one value');
}
$total = 0.0;
foreach ($values->items as $value) {
    $total += $value;
}
return $total / count($values->items);`,
  'core:array.median': String.raw`if (count($values->items) === 0) {
    throw new \InvalidArgumentException('Median needs at least one value');
}
$sorted = $values->items;
sort($sorted);
$middle = intdiv(count($sorted), 2);
return count($sorted) % 2 === 1 ? $sorted[$middle] : ($sorted[$middle - 1] + $sorted[$middle]) / 2;`,
  'core:map.pick': String.raw`$result = new VgMap();
foreach ($keys->items as $key) {
    if ($source->has($key) && !$result->has($key)) {
        $result->put($key, $source->get($key));
    }
}
return $result;`,
  'core:map.omit': String.raw`$result = new VgMap();
foreach ($source->keys as $i => $key) {
    foreach ($keys->items as $excluded) {
        if (Vg::equal($excluded, $key)) {
            continue 2;
        }
    }
    $result->put($key, $source->values[$i]);
}
return $result;`,
  'core:utilities.get-env': 'return getenv($name) === false ? $fallback : getenv($name);',
  'core:file.normalize-path': String.raw`$rest = str_replace('\\', '/', $path);
$drive = '';
if (preg_match('/^[A-Za-z]:/', $rest)) {
    $drive = substr($rest, 0, 2);
    $rest = substr($rest, 2);
}
$absolute = str_starts_with($rest, '/');
$parts = [];
foreach (explode('/', $rest) as $part) {
    if ($part === '' || $part === '.') {
        continue;
    }
    if ($part === '..') {
        if ($parts && end($parts) !== '..') {
            array_pop($parts);
        } elseif (!$absolute) {
            $parts[] = '..';
        }
    } else {
        $parts[] = $part;
    }
}
$joined = ($absolute ? '/' : '') . implode('/', $parts);
return $drive . ($joined === '' ? '.' : $joined);`
};

export function utilityDefinitions(): NodeDefinition[] {
  return [...NODES, ...MATH_UTILITIES, ...STRING_UTILITIES, ...TEXT_UTILITIES, ...SET_UTILITIES, ...ARRAY_UTILITIES, ...MAP_UTILITIES, ...SYSTEM_UTILITIES, ...ENCODING_UTILITIES, ...LANGUAGE_UTILITIES].map((node) => ({
    type: node.type,
    version: 1,
    displayName: node.displayName,
    category: node.category,
    description: node.description,
    keywords: node.keywords,
    inputs: node.inputs,
    outputs: [output(node.result)],
    implementation: { kind: 'code', languages: { ...node.code, ...(LUA[node.type] ? { lua: LUA[node.type] } : {}), ...(GDSCRIPT[node.type] ? { gdscript: GDSCRIPT[node.type] } : {}), ...(RUBY[node.type] ? { ruby: RUBY[node.type] } : {}), ...(PHP[node.type] ? { php: PHP[node.type] } : {}) } },
    ...(node.compact ? { compact: true } : {}),
    ...(node.examples ? { examples: node.examples } : {})
  }));
}
