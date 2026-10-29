// Language-only nodes (docs/language-context.md, part 4): standard-library features the universal
// library leaves out because not every language has them. Each has snippets only for the languages
// that do, so the palette offers it only there, under the language's own category ("Python /
// Regex": LANGUAGE_CATEGORY is replaced by the graph language's name). Their examples are their
// tests: the node audit runs them in each of their languages.
import { BOOL, STRING, STRINGS, UtilityNode, input, text } from './utility-kit';

// A category's first part, standing for the graph language's name (src/core/terms.ts).
export const LANGUAGE_CATEGORY = 'Language';

const pattern = () => input('pattern', 'Pattern', STRING, '');
const replacement = () => input('replacement', 'Replacement', STRING, '');

// PHP's patterns need delimiters: ~, escaped inside.
const PHP_PATTERN = String.raw`'~' . str_replace('~', '\~', $pattern) . '~u'`;

// A digest of the text's UTF-8 bytes, as lowercase hex, in each language that has it in its standard
// library (not C++, Rust or Lua). TypeScript and JavaScript use Node's crypto module.
interface Digest {
  type: string;
  displayName: string;
  // Each library's name for it.
  node: string;
  python: string;
  dotnet: string;
  java: string;
  go: { package: string; sum: string };
  godot: string;
  ruby: string;
  php: string;
  digits: number;
  examples: [string, string][];
  note?: string;
}

const DIGESTS: Digest[] = [
  {
    type: 'core:hash.md5', displayName: 'MD5', node: 'md5', python: 'md5', dotnet: 'MD5', java: 'MD5', go: { package: 'md5', sum: 'Sum' }, godot: 'md5_text', ruby: 'MD5', php: 'md5', digits: 32,
    examples: [['hello', '5d41402abc4b2a76b9719d911017c592'], ['', 'd41d8cd98f00b204e9800998ecf8427e'], ['héllo', 'be50e8478cf24ff3595bc7307fb91b50']],
    note: ' MD5 is broken for security: use it for checksums and cache keys, not passwords or signatures.'
  },
  {
    type: 'core:hash.sha1', displayName: 'SHA-1', node: 'sha1', python: 'sha1', dotnet: 'SHA1', java: 'SHA-1', go: { package: 'sha1', sum: 'Sum' }, godot: 'sha1_text', ruby: 'SHA1', php: 'sha1', digits: 40,
    examples: [['hello', 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d'], ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'], ['héllo', '35b5ea45c5e41f78b46a937cc74d41dfea920890']],
    note: ' SHA-1 is broken for security: use it for checksums, not passwords or signatures.'
  },
  {
    type: 'core:hash.sha256', displayName: 'SHA-256', node: 'sha256', python: 'sha256', dotnet: 'SHA256', java: 'SHA-256', go: { package: 'sha256', sum: 'Sum256' }, godot: 'sha256_text', ruby: 'SHA256', php: 'sha256', digits: 64,
    examples: [['hello', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'], ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'], ['héllo', '3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179']]
  }
];

const digestNode = (d: Digest): UtilityNode => ({
  type: d.type, displayName: d.displayName, category: `${LANGUAGE_CATEGORY} / Hash`, result: STRING, keywords: ['hash', 'digest', 'checksum', d.displayName.toLowerCase(), d.node],
  inputs: [text()],
  description: `The text's ${d.displayName} digest (of its UTF-8 bytes), as ${d.digits} lowercase hex digits.${d.note ?? ''}`,
  examples: d.examples.map(([input, digest]) => ({ inputs: { text: input }, outputs: { returnValue: digest } })),
  code: {
    javascript: `return globalThis.process.getBuiltinModule('node:crypto').createHash('${d.node}').update(text, 'utf8').digest('hex');`,
    python: `import hashlib\nreturn hashlib.${d.python}(text.encode("utf-8")).hexdigest()`,
    csharp: `return System.Convert.ToHexString(System.Security.Cryptography.${d.dotnet}.HashData(System.Text.Encoding.UTF8.GetBytes(text))).ToLowerInvariant();`,
    java: [
      'try {',
      `    return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("${d.java}").digest(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)));`,
      '} catch (java.security.NoSuchAlgorithmException e) {',
      '    throw new IllegalStateException(e);',
      '}'
    ].join('\n'),
    go: `sum := ${d.go.package}.${d.go.sum}([]byte(text))\nreturn hex.EncodeToString(sum[:])`,
    gdscript: `return text.${d.godot}()`,
    ruby: `require "digest"\nreturn Digest::${d.ruby}.hexdigest(text)`,
    php: `return hash('${d.php}', $text);`
  }
});

export const LANGUAGE_UTILITIES: UtilityNode[] = [
  {
    type: 'core:regex.matches', displayName: 'Regex Matches', category: `${LANGUAGE_CATEGORY} / Regex`, result: BOOL, keywords: ['regex', 'regular expression', 'match', 'test', 'search', 'pattern'],
    inputs: [text(), pattern()],
    description: "True if the pattern matches somewhere in the text. The pattern is a regular expression in the language's own syntax.",
    examples: [
      { inputs: { text: 'order 66', pattern: '[0-9]+' }, outputs: { returnValue: true } },
      { inputs: { text: 'no digits', pattern: '[0-9]+' }, outputs: { returnValue: false } },
      { description: 'anchored', inputs: { text: 'Hello, World', pattern: '^World' }, outputs: { returnValue: false } }
    ],
    code: {
      javascript: 'return new RegExp(pattern).test(text);',
      python: 'import re\nreturn re.search(pattern, text) is not None',
      csharp: 'return System.Text.RegularExpressions.Regex.IsMatch(text, pattern);',
      cpp: 'return std::regex_search(text, std::regex(pattern));',
      java: 'return java.util.regex.Pattern.compile(pattern).matcher(text).find();',
      go: 'return regexp.MustCompile(pattern).MatchString(text)',
      gdscript: 'return RegEx.create_from_string(pattern).search(text) != null',
      ruby: 'return Regexp.new(pattern).match?(text)',
      php: `return preg_match(${PHP_PATTERN}, $text) === 1;`
    }
  },
  {
    type: 'core:regex.replace', displayName: 'Regex Replace', category: `${LANGUAGE_CATEGORY} / Regex`, result: STRING, keywords: ['regex', 'regular expression', 'replace', 'substitute', 'sub', 'gsub', 'pattern'],
    inputs: [text(), pattern(), replacement()],
    description: "The text with every match of the pattern replaced. The pattern is a regular expression in the language's own syntax; the replacement is put in as written (no group references).",
    examples: [
      { inputs: { text: 'a1b22c333', pattern: '[0-9]+', replacement: '#' }, outputs: { returnValue: 'a#b#c#' } },
      { description: 'the replacement as written', inputs: { text: 'cost: 5', pattern: '[0-9]', replacement: '$1\\' }, outputs: { returnValue: 'cost: $1\\' } }
    ],
    code: {
      javascript: "return text.replace(new RegExp(pattern, 'g'), () => replacement);",
      python: 'import re\nreturn re.sub(pattern, lambda _match: replacement, text)',
      csharp: 'return System.Text.RegularExpressions.Regex.Replace(text, pattern, _ => replacement);',
      cpp: String.raw`return std::regex_replace(text, std::regex(pattern), std::regex_replace(replacement, std::regex(R"(\$)"), "$$$$"));`,
      java: 'return java.util.regex.Pattern.compile(pattern).matcher(text).replaceAll(java.util.regex.Matcher.quoteReplacement(replacement));',
      go: 'return regexp.MustCompile(pattern).ReplaceAllLiteralString(text, replacement)',
      gdscript: 'var result := ""\nvar at := 0\nfor found in RegEx.create_from_string(pattern).search_all(text):\n\tresult += text.substr(at, found.get_start() - at) + replacement\n\tat = found.get_end()\nreturn result + text.substr(at)',
      ruby: 'return text.gsub(Regexp.new(pattern)) { replacement }',
      php: `return preg_replace_callback(${PHP_PATTERN}, fn ($match) => $replacement, $text);`
    }
  },
  {
    type: 'core:regex.find-all', displayName: 'Regex Find All', category: `${LANGUAGE_CATEGORY} / Regex`, result: STRINGS, keywords: ['regex', 'regular expression', 'find all', 'scan', 'matches', 'extract', 'pattern'],
    inputs: [text(), pattern()],
    description: "Every match of the pattern in the text, in order, each the whole match. The pattern is a regular expression in the language's own syntax.",
    examples: [
      { inputs: { text: 'a1b22c333', pattern: '[0-9]+' }, outputs: { returnValue: ['1', '22', '333'] } },
      { description: 'groups give the whole match', inputs: { text: 'x=1, y=2', pattern: '([a-z])=([0-9])' }, outputs: { returnValue: ['x=1', 'y=2'] } },
      { inputs: { text: 'none here', pattern: '[0-9]' }, outputs: { returnValue: [] } }
    ],
    code: {
      javascript: "return [...text.matchAll(new RegExp(pattern, 'g'))].map((found) => found[0]);",
      python: 'import re\nreturn [found.group(0) for found in re.finditer(pattern, text)]',
      csharp: 'return System.Text.RegularExpressions.Regex.Matches(text, pattern).Select((found) => found.Value).ToList();',
      cpp: 'std::vector<std::string> found;\nstd::regex regex(pattern);\nfor (auto it = std::sregex_iterator(text.begin(), text.end(), regex); it != std::sregex_iterator(); ++it) found.push_back(it->str());\nreturn found;',
      java: 'var found = new java.util.ArrayList<String>();\nvar matcher = java.util.regex.Pattern.compile(pattern).matcher(text);\nwhile (matcher.find()) found.add(matcher.group());\nreturn found;',
      go: 'found := regexp.MustCompile(pattern).FindAllString(text, -1)\nif found == nil {\n\tfound = []string{}\n}\nreturn &found',
      gdscript: 'var found := []\nfor each in RegEx.create_from_string(pattern).search_all(text):\n\tfound.append(each.get_string())\nreturn found',
      ruby: 'return text.to_enum(:scan, Regexp.new(pattern)).map { Regexp.last_match[0] }',
      php: `preg_match_all(${PHP_PATTERN}, $text, $found);\nreturn new VgList($found[0]);`
    }
  },
  // Lua has no regular expressions: its own patterns (%d, %a, ...) do the same jobs.
  {
    type: 'core:lua.pattern-matches', displayName: 'Pattern Matches', category: `${LANGUAGE_CATEGORY} / Patterns`, result: BOOL, keywords: ['pattern', 'match', 'find', 'regex', 'string.find'],
    inputs: [text(), pattern()],
    description: "True if the Lua pattern (%d for a digit, %a for a letter, ...) matches somewhere in the text, as string.find does.",
    examples: [
      { inputs: { text: 'order 66', pattern: '%d+' }, outputs: { returnValue: true } },
      { inputs: { text: 'no digits', pattern: '%d+' }, outputs: { returnValue: false } }
    ],
    code: { lua: 'return string.find(text, pattern) ~= nil' }
  },
  {
    type: 'core:lua.pattern-replace', displayName: 'Pattern Replace', category: `${LANGUAGE_CATEGORY} / Patterns`, result: STRING, keywords: ['pattern', 'replace', 'gsub', 'substitute', 'regex'],
    inputs: [text(), pattern(), replacement()],
    description: 'The text with every match of the Lua pattern replaced, as string.gsub does; the replacement is put in as written (no %1 captures).',
    examples: [{ inputs: { text: 'a1b22c333', pattern: '%d+', replacement: '%1#' }, outputs: { returnValue: 'a%1#b%1#c%1#' } }],
    code: { lua: 'return (string.gsub(text, pattern, function() return replacement end))' }
  },
  {
    type: 'core:lua.pattern-find-all', displayName: 'Pattern Find All', category: `${LANGUAGE_CATEGORY} / Patterns`, result: STRINGS, keywords: ['pattern', 'find all', 'gmatch', 'scan', 'extract', 'regex'],
    inputs: [text(), pattern()],
    description: "Every match of the Lua pattern in the text, in order, as string.gmatch gives them: the whole match, or the first capture when the pattern has captures.",
    examples: [{ inputs: { text: 'a1b22c333', pattern: '%d+' }, outputs: { returnValue: ['1', '22', '333'] } }],
    code: { lua: 'local found = {}\nfor each in string.gmatch(text, pattern) do found[#found + 1] = each end\nreturn vg.array_of(found)' }
  },
  ...DIGESTS.map(digestNode)
];
