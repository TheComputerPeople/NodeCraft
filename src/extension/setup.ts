// Set Up in This Project (docs/project-integration.md, part 5): a report on an existing codebase,
// one section per project found (src/extension/projects.ts), of what's there, what generated code
// needs before it builds, what can't be done and what may be. Each change it offers is a set of
// files' new text, shown as a diff and applied (by the webview, setup-view.ts) only when asked. Free
// of the vscode API, so the tests run it on the corpus.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LanguagePack, LanguagePackRegistry } from '../core/language-pack';
import { OutputPlan, hasBlock, withBlock } from '../core/output-plan';
import { versionWarning } from '../core/versions';
import { gitAttributes, helloGraph } from './new-project';
import { graphOutputFor } from './placement';
import { Project, findProjects } from './projects';

export type SetupKind = 'found' | 'needs' | 'cant' | 'optional';

export interface SetupChange {
  // Unique in the report, for the webview's buttons.
  id: string;
  // Each file's new text, relative to the report's folder ("/" separators).
  files: { path: string; text: string }[];
  // A graph to open (and so compile) once the change is made.
  open?: string;
}

export interface SetupItem {
  kind: SetupKind;
  title: string;
  detail?: string;
  change?: SetupChange;
}

export interface ProjectSetup {
  // The project's folder, relative to the report's ("" for the folder itself).
  root: string;
  languages: string[];
  items: SetupItem[];
}

// Folders that hold no graphs of the user's own (as the project model skips them).
const SKIP = new Set(['node_modules', '.git', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.venv', 'venv', '__pycache__', '.godot', '.gradle', 'blueprint-packages']);

interface GraphFile {
  // Relative to the report's folder.
  file: string;
  language: string;
}

const posix = (p: string) => p.split(path.sep).join('/');
const read = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

// The report for `root` (a workspace folder, or a folder in it).
export function setupReport(root: string, languages: LanguagePackRegistry): ProjectSetup[] {
  const graphs = graphFiles(root);
  const plans = new Map<string, OutputPlan>();
  for (const pack of languages.all()) {
    const generated = graphs.filter((g) => g.language === pack.id).map((g) => posix(path.join(path.dirname(g.file), pack.generator!.outputFileName(path.basename(g.file)))));
    if (!generated.length || !pack.generator?.placement) continue;
    plans.set(pack.id, pack.generator.placement({ generatedFiles: generated.sort(), readFile: (f) => read(path.join(root, f)), exists: (f) => fs.existsSync(path.join(root, f)) }));
  }
  const projects = findProjects(root);
  // A hook goes to the innermost project holding its file.
  const owner = (file: string): Project | undefined => projects.filter((p) => isInside(path.join(root, file), p.root)).sort((a, b) => b.root.length - a.root.length)[0];
  return projects.map((project) => {
    const items: SetupItem[] = [];
    const own = graphs.filter((g) => owner(g.file) === project);
    const id = (name: string) => `${posix(path.relative(root, project.root)) || '.'}:${name}`;
    for (const language of project.languages) {
      const pack = languages.get(language);
      if (!pack?.generator) continue;
      items.push(...versionItems(project, pack));
      items.push(placementItem(project, pack, root, own.filter((g) => g.language === language)));
      const plan = plans.get(language);
      for (const hook of plan?.hooks ?? []) {
        if (owner(hook.file) !== project) continue;
        const text = read(path.join(root, hook.file));
        if (text === undefined) {
          items.push({ kind: 'cant', title: `${hook.file} doesn't exist`, detail: `Generated code isn't registered with the build: ${hook.description}.` });
          continue;
        }
        if (hasBlock(text, hook.block)) continue;
        // The files the extension keeps beside the block (vgraph.cmake, Rust's support module).
        const owned = (plan?.ownedFiles ?? []).filter((f) => f.text && read(path.join(root, f.path)) !== f.text && owner(f.path) === project);
        items.push({
          kind: 'needs', title: hook.description,
          detail: `Before generated ${pack.displayName} builds, ${hook.file} needs a block the extension keeps up to date as graphs are added and removed.`,
          change: { id: id(hook.id), files: [{ path: hook.file, text: withBlock(text, hook.block) }, ...owned.map((f) => ({ path: f.path, text: f.text }))] }
        });
      }
      if (own.some((g) => g.language === language)) {
        for (const d of plan?.diagnostics ?? []) items.push({ kind: 'cant', title: `${pack.displayName}: generated files aren't registered with the build`, detail: d.message });
      }
    }
    items.push(...buildSystemItems(project));
    items.push(...checkerItems(project, root, own, languages, id));
    items.push(...optionalItems(project, root, own, languages, id));
    return { root: posix(path.relative(root, project.root)), languages: project.languages, items };
  });
}

// ---- Found, and what can't be done ------------------------------------------------------------

// The language version the project declares, against what generated code needs.
function versionItems(project: Project, pack: LanguagePack): SetupItem[] {
  const requires = pack.requires;
  if (!requires) return [];
  const declared = project.versions[pack.id];
  if (!declared) return [{ kind: 'found', title: `${pack.displayName}: no version declared`, detail: `Generated code needs ${requires.label} or newer.` }];
  const warning = versionWarning(pack.displayName, requires, declared);
  if (warning) return [{ kind: 'cant', title: `${pack.displayName}: ${declared.declared} declared in ${declared.source}, older than generated code needs`, detail: `${warning} Raise it in ${declared.source}, or keep graphs out of this project.` }];
  return [{ kind: 'found', title: `${pack.displayName}: ${declared.declared} (${declared.source})`, detail: `Generated code needs ${requires.label} or newer.` }];
}

// Where a graph generates, in the folders the project's graphs are in, else where a first one would go.
function placementItem(project: Project, pack: LanguagePack, root: string, graphs: GraphFile[]): SetupItem {
  const folders = graphs.length ? [...new Set(graphs.map((g) => path.dirname(path.join(root, g.file))))] : [firstGraphFolder(project, pack.id)];
  const lines = folders.slice(0, 4).map((folder) => {
    const out = graphOutputFor(pack.id, path.join(folder, 'Example.vgraph'), root, pack.generator!);
    return `${posix(path.relative(root, path.join(folder, 'Example.vgraph')))} generates ${out.generatedPath}${out.module ? `, which other code imports as ${out.module}` : ''}`;
  });
  const more = folders.length > lines.length ? `; and graphs in ${folders.length - lines.length} more folders` : '';
  return { kind: 'found', title: `${pack.displayName} graphs: ${graphs.length ? `${graphs.length} in the project` : 'none yet'}`, detail: `${lines.join('; ')}${more}.` };
}

// Build systems the extension can't hook into.
function buildSystemItems(project: Project): SetupItem[] {
  const has = (name: string) => fs.existsSync(path.join(project.root, name));
  const names = fs.readdirSync(project.root);
  const items: SetupItem[] = [{ kind: 'found', title: `Build: ${project.buildSystems.join(', ')}`, detail: `From ${project.files.join(', ')}.` }];
  if (has('meson.build')) items.push({ kind: 'cant', title: "Meson can't be registered automatically", detail: "Meson has no globs: add each generated C++ file to the target's sources in meson.build." });
  if (has('BUILD') || has('BUILD.bazel') || has('WORKSPACE') || has('MODULE.bazel')) items.push({ kind: 'cant', title: "Bazel can't be registered automatically", detail: 'Add the generated files to the srcs of the target that uses them.' });
  if (names.some((n) => n.endsWith('.uproject'))) items.push({ kind: 'cant', title: "Unreal's build isn't hooked", detail: "Unreal compiles every file under a module's Source folder: keep graphs there, and the generated files build with the module." });
  return items;
}

// The project's checkers, and what generated code needs of them.
function checkerItems(project: Project, root: string, graphs: GraphFile[], languages: LanguagePackRegistry, id: (name: string) => string): SetupItem[] {
  const items: SetupItem[] = [];
  if (project.checkers.length) items.push({ kind: 'found', title: `Checkers: ${project.checkers.join(', ')}`, detail: 'Generated code passes compilers and type checkers at their strictest; style linters skip it by its marker.' });
  const rel = (file: string) => posix(path.relative(root, path.join(project.root, file)));
  // ESLint (9 and later) warns about a directive that suppressed nothing: with --max-warnings 0, a
  // clean generated file fails. Its ignores take them out (a flat config is code, so it's shown).
  if (project.checkers.includes('ESLint') && project.languages.some((l) => l === 'typescript' || l === 'javascript')) {
    items.push({ kind: 'optional', title: "Add the generated files to ESLint's ignores", detail: "ESLint warns that a generated file's /* eslint-disable */ suppressed nothing; with --max-warnings 0 that fails. Add { ignores: ['**/*.vgraph.*', '**/vgraph_runtime.*'] } to the start of eslint.config's array." });
  }
  // Ruff rejects a blanket noqa with select = ["ALL"] (PGH004); its extend-exclude leaves the files out.
  const pyproject = read(path.join(project.root, 'pyproject.toml'));
  const ruffToml = ['ruff.toml', '.ruff.toml'].find((f) => fs.existsSync(path.join(project.root, f)));
  const EXCLUDE = 'extend-exclude = ["*_vgraph.py", "test_*_vgraph.py", "vgraph_runtime.py"]';
  if (ruffToml) {
    const text = read(path.join(project.root, ruffToml)) ?? '';
    if (!/^\s*extend-exclude\s*=/m.test(text)) items.push({ kind: 'optional', title: "Leave the generated files out of Ruff", detail: `Ruff's PGH004 rejects their blanket noqa; ${ruffToml} gets ${EXCLUDE}.`, change: { id: id('ruff'), files: [{ path: rel(ruffToml), text: `${EXCLUDE}\n${text}` }] } });
  } else if (pyproject && /^\[tool\.ruff\]\s*$/m.test(pyproject)) {
    const section = /^\[tool\.ruff\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(pyproject)?.[1] ?? '';
    if (!/^\s*extend-exclude\s*=/m.test(section)) {
      items.push({ kind: 'optional', title: 'Leave the generated files out of Ruff', detail: `Ruff's PGH004 rejects their blanket noqa; [tool.ruff] gets ${EXCLUDE}.`, change: { id: id('ruff'), files: [{ path: rel('pyproject.toml'), text: pyproject.replace(/^\[tool\.ruff\]\s*$/m, `[tool.ruff]\n${EXCLUDE}`) }] } });
    }
  }
  // Prettier formats what it's given: its ignore file leaves the generated files as generated.
  const packageJson = read(path.join(project.root, 'package.json'));
  if (fs.readdirSync(project.root).some((n) => /^\.prettierrc/.test(n) || /^prettier\.config\./.test(n)) || /"prettier"\s*:/.test(packageJson ?? '')) {
    const ignore = read(path.join(project.root, '.prettierignore')) ?? '';
    if (!ignore.includes('*.vgraph.*')) items.push({ kind: 'optional', title: 'Leave the generated files out of Prettier', change: { id: id('prettier'), files: [{ path: rel('.prettierignore'), text: `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}# Generated from graphs.\n*.vgraph.*\nvgraph_runtime.*\n` }] } });
  }
  // TypeScript in a workspace: generated code imports another package's code by a relative path,
  // which a rootDir or project references reject.
  if (project.workspace && project.languages.includes('typescript')) {
    const tsconfig = read(path.join(project.root, 'tsconfig.json')) ?? '';
    if (/"rootDir"\s*:|"references"\s*:|"composite"\s*:\s*true/.test(tsconfig)) {
      items.push({ kind: 'cant', title: "Graphs can't call another package's code here", detail: "Generated TypeScript imports another workspace package's code by a relative path, which this tsconfig's rootDir or project references reject. Graphs that call only this package's code work; keep those calling another package's in an app that's bundled or type-checked without emitting." });
    }
  }
  // PHP: PSR-4 doesn't find a class in Greeting.vgraph.php; a classmap of the graphs' folders does.
  const composer = read(path.join(project.root, 'composer.json'));
  const phpFolders = [...new Set(graphs.filter((g) => g.language === 'php').map((g) => posix(path.relative(project.root, path.dirname(path.join(root, g.file)))) || '.'))];
  if (composer && phpFolders.length) {
    try {
      const config = JSON.parse(composer) as { autoload?: { classmap?: string[] } };
      const classmap = config.autoload?.classmap ?? [];
      const missing = phpFolders.filter((f) => !classmap.some((c) => c.replace(/\/$/, '') === f));
      if (missing.length) {
        const next = { ...config, autoload: { ...config.autoload, classmap: [...classmap, ...missing.map((f) => `${f}/`)] } };
        items.push({ kind: 'optional', title: "Let Composer's autoloader find the generated classes", detail: "PSR-4 doesn't find a class in a file named after its graph (Greeting.vgraph.php); a classmap of the graphs' folders does, after composer dump-autoload. Without it, code requires the generated files.", change: { id: id('classmap'), files: [{ path: rel('composer.json'), text: `${JSON.stringify(next, null, 4)}\n` }] } });
      }
    } catch {
      // Not JSON: nothing to offer.
    }
  }
  return items;
}

// ---- Optional ---------------------------------------------------------------------------------

function optionalItems(project: Project, root: string, graphs: GraphFile[], languages: LanguagePackRegistry, id: (name: string) => string): SetupItem[] {
  const items: SetupItem[] = [];
  const rel = (file: string) => posix(path.relative(root, path.join(project.root, file)));
  // .gitattributes: generated files marked as generated, for diffs and statistics.
  const attributes = read(path.join(project.root, '.gitattributes')) ?? '';
  const wanted = [...new Set(project.languages.flatMap((l) => gitAttributes(l).split('\n').filter((line) => line && !line.startsWith('#'))))];
  const missing = wanted.filter((line) => !attributes.split(/\r?\n/).includes(line));
  if (missing.length) {
    items.push({
      kind: 'optional', title: 'Mark generated files in .gitattributes', detail: 'Diffs and statistics then treat them as generated.',
      change: { id: id('gitattributes'), files: [{ path: rel('.gitattributes'), text: `${attributes}${attributes && !attributes.endsWith('\n') ? '\n' : ''}# Files Blueprint Visual Scripting generates from graphs.\n${missing.join('\n')}\n` }] }
    });
  }
  items.push({ kind: 'optional', title: "Expose the project's functions as nodes", detail: 'On a function, the quick fix (Ctrl+.) "Expose as Blueprint node" marks it @blueprint; graphs then call it.' });
  // A first graph, where a graph of the project's first language goes.
  if (!graphs.length) {
    const language = project.languages.find((l) => languages.get(l)?.generator);
    if (language) {
      const folder = firstGraphFolder(project, language);
      const file = posix(path.relative(root, path.join(folder, 'Hello.vgraph')));
      if (!fs.existsSync(path.join(root, file))) {
        items.push({
          kind: 'optional', title: `Create a first graph: ${file}`, detail: 'A class graph that prints "Hello from Blueprint", in the folder graphs of this project go in.',
          change: { id: id('first-graph'), files: [{ path: file, text: `${JSON.stringify(helloGraph(language, 'Hello'), null, 2)}\n` }], open: file }
        });
      }
    }
  }
  return items;
}

// Where a project's first graph goes, in its language's usual source folder.
function firstGraphFolder(project: Project, language: string): string {
  const at = (...parts: string[]) => path.join(project.root, ...parts);
  const dir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
  const firstDir = (folder: string, test: (p: string) => boolean): string | undefined => {
    if (!dir(folder)) return undefined;
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) if (e.isDirectory() && !SKIP.has(e.name) && test(path.join(folder, e.name))) return path.join(folder, e.name);
    return undefined;
  };
  switch (language) {
    case 'python':
      return firstDir(at('src'), (p) => fs.existsSync(path.join(p, '__init__.py'))) ?? firstDir(project.root, (p) => fs.existsSync(path.join(p, '__init__.py'))) ?? project.root;
    case 'java': {
      // The first package folder with sources, under src/main/java.
      const walk = (folder: string): string | undefined => {
        if (!dir(folder)) return undefined;
        if (fs.readdirSync(folder).some((n) => n.endsWith('.java'))) return folder;
        for (const e of fs.readdirSync(folder, { withFileTypes: true })) if (e.isDirectory()) return walk(path.join(folder, e.name));
        return undefined;
      };
      return walk(at('src', 'main', 'java')) ?? at('src', 'main', 'java');
    }
    case 'php': {
      const psr4 = (JSON.parse(read(at('composer.json')) ?? '{}') as { autoload?: { 'psr-4'?: Record<string, string | string[]> } }).autoload?.['psr-4'];
      const first = psr4 ? Object.values(psr4).flat()[0] : undefined;
      return first ? at(first) : at('src');
    }
    case 'ruby':
      return dir(at('lib')) ? at('lib') : project.root;
    case 'csharp': case 'go': case 'lua': case 'gdscript':
      return project.root;
    default:
      return dir(at('src')) ? at('src') : project.root;
  }
}

// Every graph file under `root`, with its language.
function graphFiles(root: string): GraphFile[] {
  const found: GraphFile[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory() && depth < 12 && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(file, depth + 1);
      else if (e.isFile() && e.name.endsWith('.vgraph')) {
        const language = /"language":\s*"([^"]*)"/.exec(read(file) ?? '')?.[1];
        if (language) found.push({ file: posix(path.relative(root, file)), language });
      }
    }
  };
  walk(root, 0);
  return found;
}

function isInside(file: string, folder: string): boolean {
  const relative = path.relative(folder, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
