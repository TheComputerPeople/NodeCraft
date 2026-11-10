// Parsing code with tree-sitter (docs/codebase-map.md, step 2): web-tree-sitter and the grammars in
// grammars/, each loaded the first time a file needs it. Free of the vscode API; the extension runs it
// in a worker (parse-service.ts).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Language, Node, Parser, Tree } from 'web-tree-sitter';
import { GrammarId, grammarFileName } from '../core/parsing/grammars';

export interface SyntaxError {
  // 1-based line and column of an error, or of a token the parser had to assume (missing).
  line: number;
  column: number;
  missing: boolean;
}

export interface ParseSummary {
  grammar: GrammarId;
  // Every node of the tree, named or not.
  nodes: number;
  // At most MAX_ERRORS, first in the file first.
  errors: SyntaxError[];
  milliseconds: number;
}

export const MAX_ERRORS = 20;

let initialized: Promise<void> | undefined;

export class CodeParser {
  private readonly languages = new Map<GrammarId, Promise<Language>>();
  private readonly parser: Parser;

  private constructor(private readonly grammarDir: string) {
    this.parser = new Parser();
  }

  // A parser reading grammars from `grammarDir` (the extension's grammars/ folder).
  static async create(grammarDir: string): Promise<CodeParser> {
    initialized ??= Parser.init();
    await initialized;
    return new CodeParser(grammarDir);
  }

  language(grammar: GrammarId): Promise<Language> {
    let loaded = this.languages.get(grammar);
    if (!loaded) {
      const file = path.join(this.grammarDir, grammarFileName(grammar));
      loaded = fs.promises.readFile(file).then((bytes) => Language.load(bytes));
      // A failed load is tried again next time (the file may have been missing).
      loaded.catch(() => this.languages.delete(grammar));
      this.languages.set(grammar, loaded);
    }
    return loaded;
  }

  // The tree of `text`. The caller deletes it (tree.delete()): trees live in WebAssembly memory.
  async parse(grammar: GrammarId, text: string): Promise<Tree> {
    this.parser.setLanguage(await this.language(grammar));
    const tree = this.parser.parse(text);
    if (!tree) throw new Error(`The ${grammar} parser gave no tree.`);
    return tree;
  }

  // What parsing `text` found: its size and syntax errors.
  async summarize(grammar: GrammarId, text: string): Promise<ParseSummary> {
    const started = performance.now();
    const tree = await this.parse(grammar, text);
    try {
      return { grammar, ...countNodes(tree.rootNode), milliseconds: performance.now() - started };
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    this.parser.delete();
  }
}

// Walks the tree once with a cursor (no node objects for the nodes it passes), counting nodes and
// collecting the first errors.
function countNodes(root: Node): { nodes: number; errors: SyntaxError[] } {
  const errors: SyntaxError[] = [];
  let nodes = 0;
  const cursor = root.walk();
  try {
    for (;;) {
      nodes++;
      const node = cursor.currentNode;
      if ((node.isError || node.isMissing) && errors.length < MAX_ERRORS) {
        errors.push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, missing: node.isMissing });
      }
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return { nodes, errors };
      }
    }
  } finally {
    cursor.delete();
  }
}
