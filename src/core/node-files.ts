// Snippet nodes written by hand (docs/node-authoring.md, gap 8): what New Node writes, and the
// problems a *.node.json file shows while it's edited, before any graph uses the node.
import { NodeDefinition } from './model';

// A language the workspace's graphs use, and the snippet keys its generator reads.
export interface SnippetLanguage {
  id: string;
  displayName: string;
  snippetLanguages: string[];
  // Its pack's own implementations of library nodes (CodeGenerator.snippets).
  snippets?: Record<string, string>;
}

export interface NodeFileProblem {
  severity: 'error' | 'warning' | 'information';
  message: string;
  // Text of the file the problem is at (its first occurrence); absent: the top of the file.
  at?: string;
}

export function nodeFileProblems(def: NodeDefinition, languages: readonly SnippetLanguage[]): NodeFileProblem[] {
  const implementation = def.implementation;
  if (implementation?.kind !== 'code') return [];
  const problems: NodeFileProblem[] = [];
  const inputs = new Set(def.inputs.filter((p) => p.kind === 'data').map((p) => p.id));
  for (const [language, code] of Object.entries(implementation.languages)) {
    for (const match of code.matchAll(/\$\{([^}]+)\}/g)) {
      if (!inputs.has(match[1])) problems.push({ severity: 'warning', message: `The ${language} snippet uses \${${match[1]}}, but "${def.displayName}" has no data input "${match[1]}".`, at: match[0] });
    }
  }
  for (const language of languages) {
    if (language.snippetLanguages.some((key) => implementation.languages[key] !== undefined) || language.snippets?.[def.type] !== undefined) continue;
    const keys = language.snippetLanguages.map((key) => `"${key}"`).join(' or ');
    problems.push({ severity: 'information', message: `No ${language.displayName} snippet: ${language.displayName} graphs in this workspace can't use "${def.displayName}". Add a ${keys} entry to its languages.`, at: '"languages"' });
  }
  return problems;
}

// New Node: a node with an input, an output, and a snippet returning the input for each language.
export function newNodeDefinition(name: string, category: string, languages: readonly SnippetLanguage[]): NodeDefinition {
  const slug = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node';
  const snippets = Object.fromEntries(languages.map((l) => {
    const key = l.snippetLanguages[0] ?? l.id;
    // Languages whose statements end without a semicolon.
    const bare = ['python', 'lua', 'gdscript', 'ruby', 'go'].includes(key);
    return [key, `return \${value}${bare ? '' : ';'}`];
  }));
  return {
    type: `user.${category.split('|').map(slug).join('.')}.${slug(name)}`,
    version: 1,
    displayName: name.trim(),
    category: category.trim(),
    description: `What ${name.trim()} does.`,
    inputs: [
      { id: 'execIn', name: '', kind: 'exec', direction: 'input' },
      { id: 'value', name: 'Value', kind: 'data', direction: 'input', type: { id: 'float' }, defaultValue: 0 }
    ],
    outputs: [
      { id: 'execOut', name: '', kind: 'exec', direction: 'output' },
      { id: 'result', name: 'Result', kind: 'data', direction: 'output', type: { id: 'float' } }
    ],
    implementation: { kind: 'code', languages: Object.keys(snippets).length ? snippets : { typescript: 'return ${value};' } }
  };
}
