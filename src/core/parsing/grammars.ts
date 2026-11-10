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

// The grammar for one of the extension's language ids ('csharp', 'cpp', ...).
export function grammarForLanguage(language: string): GrammarId | undefined {
  if (language === 'csharp') return 'c_sharp';
  return (GRAMMAR_IDS as readonly string[]).includes(language) ? language as GrammarId : undefined;
}

export function grammarFileName(id: GrammarId): string {
  return `tree-sitter-${id}.wasm`;
}
