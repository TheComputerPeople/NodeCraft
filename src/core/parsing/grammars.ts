// Which tree-sitter grammar parses a file (docs/codebase-map.md, step 2). The grammars are built
// into grammars/ by scripts/build-grammars.js: one per language the extension supports, plus TSX
// and C (C sources in C++ projects).

export type GrammarId = 'typescript' | 'tsx' | 'javascript' | 'python' | 'c_sharp' | 'c' | 'cpp' | 'rust' | 'java' | 'go' | 'lua' | 'gdscript' | 'ruby' | 'php';

export const GRAMMAR_IDS: readonly GrammarId[] = ['typescript', 'tsx', 'javascript', 'python', 'c_sharp', 'c', 'cpp', 'rust', 'java', 'go', 'lua', 'gdscript', 'ruby', 'php'];

// By file extension, lower case. JavaScript's grammar parses JSX too. A `.h` header is parsed as
// C++, whose grammar takes C's declarations as well.
const BY_EXTENSION: Record<string, GrammarId> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.cs': 'c_sharp',
  '.c': 'c',
  '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.ipp': 'cpp', '.inl': 'cpp',
  '.rs': 'rust',
  '.java': 'java',
  '.go': 'go',
  '.lua': 'lua',
  '.gd': 'gdscript',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby',
  '.php': 'php'
};

// The grammar for a file, by its name; undefined for a file no grammar parses.
export function grammarForFile(fileName: string): GrammarId | undefined {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  // Ruby's build files have no extension.
  if (/^(Rakefile|Gemfile)$/.test(base)) return 'ruby';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION[base.slice(dot).toLowerCase()] : undefined;
}

// A script without an extension (bin/greet, artisan): the grammar its `#!` line names, if any.
const BY_INTERPRETER: Record<string, GrammarId> = { node: 'javascript', nodejs: 'javascript', tsx: 'typescript', 'ts-node': 'typescript', deno: 'typescript', bun: 'typescript', python: 'python', ruby: 'ruby', php: 'php', lua: 'lua', luajit: 'lua' };

export function grammarForShebang(firstLine: string): GrammarId | undefined {
  if (!firstLine.startsWith('#!')) return undefined;
  // `#!/usr/bin/env [-S] ruby`, or `#!/usr/bin/python3.12`.
  const words = firstLine.slice(2).trim().split(/\s+/);
  const program = (words[0].endsWith('/env') ? words.slice(1).find((w) => !w.startsWith('-')) : words[0]) ?? '';
  const name = program.split('/').pop()!.replace(/[\d.]+$/, '');
  return BY_INTERPRETER[name];
}

// Whether a file without an extension might be a script to read its `#!` line for: in a bin/,
// exe/ or scripts/ folder, or a framework's command (Laravel's artisan).
export function mayBeScript(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  const base = parts.pop()!;
  return !base.includes('.') && (base === 'artisan' || parts.some((p) => p === 'bin' || p === 'exe' || p === 'scripts'));
}

// The grammar for one of the extension's language ids ('csharp', 'cpp', ...).
export function grammarForLanguage(language: string): GrammarId | undefined {
  if (language === 'csharp') return 'c_sharp';
  return (GRAMMAR_IDS as readonly string[]).includes(language) ? language as GrammarId : undefined;
}

export function grammarFileName(id: GrammarId): string {
  return `tree-sitter-${id}.wasm`;
}
