// Output placement checks from docs/output-placement.md that need the file system: the project's
// JavaScript module format, whether tsconfig.json covers a generated file, whether Python can
// import it, and recognizing files generated from a given graph. Free of the vscode API so it can
// be unit-tested against fixture folders.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generatedFrom } from '../core/codemap/generated';
import { CompileDiagnostic } from '../core/compiler/diagnostics';
import type { CodeGenerator, GenerateOptions, LanguagePackRegistry } from '../core/language-pack';
import { graphFileDefinitions } from '../core/graph-files';
import type { GraphDocument, NodeDefinition } from '../core/model';
import { generatedLanguages } from '../core/user-types';
import { scanCSharp } from '../core/importing/csharp-scanner';
import { luaModuleIn, luaRequireRoot } from '../core/languages/lua';
import { RUST_BLOCK } from '../core/languages/rust';
import { findBlock } from '../core/output-plan';

// What a language's generator needs to know about where a graph file is: its folder in the
// workspace and the project around it (module format, import extension, namespace or package).
// Compiling uses it, and so does the corpus of project layouts (test/conformance/corpus.test.ts).
export function generateOptionsFor(language: string | undefined, graphFileName: string, graphDir: string, root: string, generator?: CodeGenerator): GenerateOptions {
  const go = language === 'go' ? goPackage(graphDir, root) : undefined;
  const python = language === 'python' && generator ? pythonModule(path.join(graphDir, generator.outputFileName(graphFileName)), root).module : undefined;
  return {
    sourceFileName: graphFileName,
    moduleFormat: detectModuleFormat(graphDir, root),
    outputDir: toPosix(path.relative(root, graphDir)),
    importExtension: detectImportExtension(graphDir, root),
    namespace: language === 'java' ? javaProject(graphDir, root).package : go ? go.name : language === 'php' ? phpNamespace(graphDir, root) : csharpNamespace(graphDir, root),
    ...(go?.path ? { packagePath: go.path } : {}),
    ...(python?.includes('.') ? { module: python } : {}),
    ...(language === 'rust' && rustCrateName(graphDir, root) ? { crate: rustCrateName(graphDir, root) } : {}),
    ...(language === 'lua' ? { requireRoot: luaRoot(path.join(graphDir, graphFileName), root) } : {})
  };
}

// Where a graph file generates in a language, relative to the workspace folder, and the module
// other generated code imports it as (Python's module, C#'s namespace, Java's package, ...).
export function graphOutputFor(language: string, graphFile: string, root: string, generator: CodeGenerator): { generatedPath: string; module?: string } {
  const dir = path.dirname(graphFile);
  const generated = path.join(dir, generator.outputFileName(path.basename(graphFile)));
  const go = language === 'go' ? goPackage(dir, root) : undefined;
  // Rust's generated modules are declared at the crate root (rustPlacement), by their file's name,
  // and named with their crate (GenerateOptions.crate).
  const module = language === 'python' ? pythonModule(generated, root).module : language === 'csharp' ? csharpNamespace(dir, root) : language === 'java' ? javaProject(dir, root).package : go ? go.path ?? go.name : language === 'php' ? phpNamespace(dir, root)
    : language === 'rust' ? withCrate(rustCrateName(dir, root), generator.moduleName?.(path.basename(generated), { sourceFileName: path.basename(graphFile) }) ?? '')
    : language === 'lua' ? luaModuleIn(toPosix(path.relative(root, generated)), luaRoot(generated, root)) : undefined;
  return { generatedPath: toPosix(path.relative(root, generated)), ...(module ? { module } : {}) };
}

// The nodes a graph file gives other graphs (a library's functions, a type's Make and Break, a
// class's members), with where each of its languages generates it: a shared struct, enum or function
// library is generated for its other languages too (docs/multi-language.md, gap 2). What the
// workspace's graphs know of it (graph-libraries.ts), and what the corpus registers.
export function graphFileNodes(doc: GraphDocument, graphFile: string, root: string, languages: LanguagePackRegistry): NodeDefinition[] | undefined {
  const output = (language: string | undefined): { generatedPath: string; module?: string } | undefined => {
    const generator = language ? languages.get(language)?.generator : undefined;
    return language && generator ? graphOutputFor(language, graphFile, root, generator) : undefined;
  };
  const document = toPosix(path.relative(root, graphFile));
  const own = output(doc.language) ?? { generatedPath: document };
  const others = Object.fromEntries(generatedLanguages(doc).slice(1).flatMap((language) => {
    const other = output(language);
    return other ? [[language, other]] : [];
  }));
  const generator = doc.language ? languages.get(doc.language)?.generator : undefined;
  return graphFileDefinitions(doc, { document, ...own, ...(Object.keys(others).length ? { others } : {}) }, generator, (language) => languages.get(language)?.generator);
}

// The module generated code imports a file of the project's code as, for languages that import by
// module (Python's dotted name, Rust's module path, Go's package path).
export function codeModuleFor(language: string, file: string, root: string): string | undefined {
  return language === 'python' ? pythonModule(file, root).module
    : language === 'rust' ? rustCodeModule(file, root)
    : language === 'lua' ? luaModuleIn(toPosix(path.relative(root, file)), luaRoot(file, root))
    : language === 'go' ? goPackage(path.dirname(file), root).path : undefined;
}

// The folder a Lua file's `require` names start from, relative to the workspace folder (luaRequireRoot).
function luaRoot(file: string, root: string): string {
  return luaRequireRoot(toPosix(path.relative(root, file)), (f) => {
    try {
      return fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      return undefined;
    }
  });
}

// A Rust file's module named with its crate ("corpus_core::text"; the crate root is the crate's
// name), so a graph in another crate of the workspace calls it by that name (GenerateOptions.crate).
function rustCodeModule(file: string, root: string): string | undefined {
  const module = rustModule(file, root);
  return module === undefined ? undefined : withCrate(rustCrateName(path.dirname(file), root), module);
}

function withCrate(crate: string | undefined, module: string): string | undefined {
  return crate ? (module ? `${crate}::${module}` : crate) : module || undefined;
}

// The name code calls a Rust crate by: its package's name, with "-" as "_".
export function rustCrateName(dir: string, stopDir: string): string | undefined {
  const manifest = findUp(dir, 'Cargo.toml', stopDir);
  if (!manifest) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(manifest, 'utf8');
  } catch {
    return undefined;
  }
  const pkg = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(pkg)?.[1].replace(/-/g, '_');
}

// The graph a file was generated from, by its header (src/core/codemap/generated.ts).
export { generatedFrom };

// Reads a file's first line and checks it was generated from `graphFileName`.
export function isGeneratedFrom(file: string, graphFileName: string): boolean {
  const head = readHead(file);
  return head !== undefined && generatedFrom(head) === graphFileName;
}

// Whether something is at `file` that the extension didn't generate: a file without the
// "Generated by" header that names a graph, or a folder. Compiles and renames never write over one
// (docs/audit.md, second pass).
export function isUsersFile(file: string): boolean {
  try {
    fs.statSync(file);
  } catch {
    return false;
  }
  const head = readHead(file);
  return head === undefined || generatedFrom(head) === undefined;
}

// A file's first 512 bytes, or undefined when it can't be read.
function readHead(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(512);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, length).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// The nearest `fileName` in `startDir` or its parents, not looking above `stopDir`.
export function findUp(startDir: string, fileName: string, stopDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  for (;;) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir || !isInside(parent, stop)) return undefined;
    dir = parent;
  }
}

// As Node decides it: the nearest package.json's "type", where a package.json without one means
// CommonJS. Without any package.json, generated code uses ES modules.
export function detectModuleFormat(graphDir: string, stopDir: string): 'esm' | 'commonjs' {
  const packageJson = findUp(graphDir, 'package.json', stopDir);
  if (!packageJson) return 'esm';
  const pkg = readJson(packageJson) as { type?: string } | undefined;
  return pkg?.type === 'module' ? 'esm' : 'commonjs';
}

// How generated TypeScript imports the project's TypeScript modules (docs/code-as-nodes.md,
// "Generated imports"), from the nearest tsconfig.json and the configs it extends: ".ts" when the
// project imports TypeScript extensions (or has no tsconfig.json, as Node.js runs it), ".js" for
// node16/nodenext resolution, otherwise no extension.
export function detectImportExtension(graphDir: string, stopDir: string): 'ts' | 'js' | 'none' {
  const config = findUp(graphDir, 'tsconfig.json', stopDir);
  if (!config) return 'ts';
  const options = compilerOptions(config);
  if (options.allowImportingTsExtensions === true || options.rewriteRelativeImportExtensions === true) return 'ts';
  const resolution = String(options.moduleResolution ?? options.module ?? '').toLowerCase();
  return resolution === 'node16' || resolution === 'nodenext' ? 'js' : 'none';
}

// Compiler options of a tsconfig.json, merged over those of the relative configs it extends.
function compilerOptions(configFile: string, depth = 0): Record<string, unknown> {
  const config = readJson(configFile) as { extends?: unknown; compilerOptions?: Record<string, unknown> } | undefined;
  if (!config) return {};
  const bases = (Array.isArray(config.extends) ? config.extends : [config.extends]).filter((e): e is string => typeof e === 'string' && e.startsWith('.'));
  const inherited = depth < 8 ? bases.reduce<Record<string, unknown>>((merged, base) => {
    const file = path.resolve(path.dirname(configFile), base.endsWith('.json') ? base : `${base}.json`);
    return { ...merged, ...compilerOptions(file, depth + 1) };
  }, {}) : {};
  return { ...inherited, ...(config.compilerOptions ?? {}) };
}

// A Python module's import name and import root (docs/code-as-nodes.md, "Generated imports"): the
// root is the folder above its outermost package, or its own folder outside packages.
export function pythonModule(file: string, stopDir: string): { module: string; root: string } {
  const stem = path.basename(file, '.py');
  const parts = stem === '__init__' ? [] : [stem];
  let dir = path.dirname(file);
  const stop = path.resolve(stopDir);
  while (fs.existsSync(path.join(dir, '__init__.py')) && /^[A-Za-z_]\w*$/.test(path.basename(dir)) && path.resolve(dir) !== stop && isInside(dir, stop)) {
    parts.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return { module: parts.join('.') || stem, root: dir };
}

// The nearest C# project file (*.csproj) in `startDir` or its parents, not looking above `stopDir`.
export function findCsproj(startDir: string, stopDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  for (;;) {
    const project = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.csproj')) : undefined;
    if (project) return path.join(dir, project);
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir || !isInside(parent, stop)) return undefined;
    dir = parent;
  }
}

// The namespace for a C# file in `graphDir`, as Visual Studio names a new file's: the project's
// RootNamespace (else the project file's name), then the folders below the project. Undefined
// outside a project (the class goes in the global namespace).
export function csharpNamespace(graphDir: string, stopDir: string): string | undefined {
  const project = findCsproj(graphDir, stopDir);
  if (!project) return undefined;
  let root: string;
  try {
    root = /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/.exec(fs.readFileSync(project, 'utf8'))?.[1] ?? path.basename(project, path.extname(project));
  } catch {
    root = path.basename(project, path.extname(project));
  }
  const folders = path.relative(path.dirname(project), graphDir).split(path.sep).filter(Boolean);
  return [...root.split('.'), ...folders].map(csharpIdentifier).join('.');
}

// Visual Studio's rule for namespace parts: invalid characters become "_", and a leading digit gets
// a "_" in front.
function csharpIdentifier(part: string): string {
  const id = part.replace(/[^\p{L}\p{N}_]/gu, '_');
  return /^\p{N}/u.test(id) ? `_${id}` : id || '_';
}

// The project's C# files that Run compiles with a generated file: every .cs file of the project
// (outside bin and obj), or without a project the files of the methods it calls. Files with
// top-level statements are left out: they are a program's own entry point.
export function csharpRunSources(graphDir: string, stopDir: string, outputFile: string, importedFiles: string[]): string[] {
  const project = findCsproj(graphDir, stopDir);
  const files = project ? listFiles(path.dirname(project), '.cs', ['bin', 'obj', '.git', 'node_modules']) : importedFiles.map((f) => path.join(stopDir, f));
  return files.filter((file) => {
    if (path.resolve(file).toLowerCase() === path.resolve(outputFile).toLowerCase()) return false;
    try {
      return !scanCSharp(fs.readFileSync(file, 'utf8')).topLevelStatements;
    } catch {
      return false;
    }
  });
}

function listFiles(dir: string, extension: string, skip: string[]): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.includes(entry.name.toLowerCase())) found.push(...listFiles(full, extension, skip));
    } else if (entry.name.toLowerCase().endsWith(extension)) found.push(full);
  }
  return found;
}

// A Rust source file's module in its crate (src/app/values.rs is app::values; a crate root is ""),
// or undefined when it isn't in a crate's src folder.
export function rustModule(file: string, stopDir: string): string | undefined {
  const manifest = findUp(path.dirname(file), 'Cargo.toml', stopDir);
  if (!manifest) return undefined;
  const relative = path.relative(path.join(path.dirname(manifest), 'src'), file).split(path.sep);
  if (relative[0] === '..') return undefined;
  const parts = relative.map((p) => p.replace(/\.rs$/, ''));
  if (parts[parts.length - 1] === 'mod') parts.pop();
  if (parts.length === 1 && (parts[0] === 'main' || parts[0] === 'lib')) return '';
  return parts.join('::');
}

// What Run builds with a generated Rust file: the other graphs' generated modules it uses, theirs
// in turn (found by their `crate::name_vgraph::` paths, next to the files that use them), and, when
// it calls the project's functions, the crate's modules.
export function rustRunSources(outputFile: string, root: string, importedFiles: string[]): { generated: string[]; crate?: { src: string; modules: string[]; name?: string } } {
  const generated = new Set<string>();
  let crate: { src: string; modules: string[]; name?: string } | undefined;
  const pending = [path.resolve(outputFile)];
  for (const file of importedFiles.map((f) => path.join(root, f))) {
    if (/_vgraph\.rs$/.test(file)) pending.push(file);
    else crate ??= rustCrateModules(file, root);
  }
  const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file.toLowerCase())) continue;
    seen.add(file.toLowerCase());
    if (file.toLowerCase() !== path.resolve(outputFile).toLowerCase()) generated.add(file);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/\b(?:crate|[a-z_]\w*)::(\w+_vgraph)::/g)) {
      const sibling = path.join(path.dirname(file), `${match[1]}.rs`);
      if (fs.existsSync(sibling)) pending.push(sibling);
    }
  }
  return { generated: [...generated].sort(), ...(crate ? { crate } : {}) };
}

// The crate a Rust file is in: its src folder and the top-level modules its root (lib.rs, else
// main.rs) declares, leaving out the generated modules the extension declares.
export function rustCrateModules(file: string, stopDir: string): { src: string; modules: string[]; name?: string } | undefined {
  const manifest = findUp(path.dirname(file), 'Cargo.toml', stopDir);
  if (!manifest) return undefined;
  const src = path.join(path.dirname(manifest), 'src');
  for (const name of ['lib.rs', 'main.rs']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(src, name), 'utf8');
    } catch {
      continue;
    }
    const block = findBlock(text, RUST_BLOCK);
    if (block) text = text.slice(0, block.start) + text.slice(block.end);
    const modules = [...text.matchAll(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)].map((m) => m[1]);
    // Its name, which a graph in another crate calls its code by.
    const crate = rustCrateName(path.dirname(manifest), stopDir);
    return { src, modules, ...(crate ? { name: crate } : {}) };
  }
  return undefined;
}

// Whether a C++ header declares C functions: a C file implements it (no C++ file beside it), and
// it has no extern "C" of its own. Generated C++ then includes it in extern "C" (ExposeOptions.linkage).
export function cppHeaderLinkage(header: string): 'c' | undefined {
  if (!/\.(h|hh)$/i.test(header)) return undefined;
  const stem = header.replace(/\.(h|hh)$/i, '');
  if (!fs.existsSync(`${stem}.c`) || ['.cpp', '.cc', '.cxx'].some((ext) => fs.existsSync(stem + ext))) return undefined;
  let text = '';
  try {
    text = fs.readFileSync(header, 'utf8');
  } catch {
    return undefined;
  }
  return /extern\s+"C"/.test(text) ? undefined : 'c';
}

// The C++ sources Run compiles with a generated file: the generated files it includes, theirs in
// turn, and the implementation file next to each project header they include (.cpp, .cc or .cxx).
export function cppRunSources(outputFile: string): string[] {
  const sources = new Set<string>();
  const seen = new Set<string>();
  const pending = [path.resolve(outputFile)];
  // A header's implementation: its C++ file, else its C file (which Run compiles as C).
  const sibling = (header: string) => ['.cpp', '.cc', '.cxx', '.c'].map((ext) => header.replace(/\.(h|hpp|hh|hxx)$/i, ext)).find((file) => fs.existsSync(file));
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file.toLowerCase())) continue;
    seen.add(file.toLowerCase());
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/^\s*#include\s+"([^"]+)"/gm)) {
      const included = path.resolve(path.dirname(file), match[1]);
      if (/\.vgraph\.h$/i.test(included)) {
        const source = included.replace(/\.h$/i, '.cpp');
        pending.push(included);
        if (fs.existsSync(source)) {
          sources.add(source);
          pending.push(source);
        }
      } else {
        const implementation = sibling(included);
        if (implementation) sources.add(implementation);
      }
    }
  }
  sources.delete(path.resolve(outputFile));
  return [...sources].sort();
}

// Placement warnings for a generated file (docs/output-placement.md, "Verification").
// A Java graph's place in its build (docs/language-breadth.md, "Java"): the nearest Maven or Gradle
// project's source roots (pom.xml's <sourceDirectory> and <testSourceDirectory>, else Maven's and
// Gradle's src/main/java and src/test/java), and the package of the graph's folder when it is in one.
export function javaProject(graphDir: string, stopDir: string): { package?: string; sourceRoots: string[]; build?: string; outside?: boolean } {
  let build: string | undefined;
  for (const name of ['pom.xml', 'build.gradle.kts', 'build.gradle']) {
    const found = findUp(graphDir, name, stopDir);
    if (found && (!build || found.length > build.length)) build = found;
  }
  if (!build) return { sourceRoots: [] };
  const project = path.dirname(build);
  let main = 'src/main/java';
  let test = 'src/test/java';
  if (path.basename(build) === 'pom.xml') {
    const pom = fs.readFileSync(build, 'utf8');
    main = /<sourceDirectory>\s*([^<]+?)\s*<\/sourceDirectory>/.exec(pom)?.[1] ?? main;
    test = /<testSourceDirectory>\s*([^<]+?)\s*<\/testSourceDirectory>/.exec(pom)?.[1] ?? test;
  }
  const roots = [main, test].map((r) => path.resolve(project, r.replace(/\$\{(project\.)?basedir\}\/?/, '')));
  const sourceRoots = roots.filter((r) => fs.existsSync(r));
  const root = roots.find((r) => isInside(path.resolve(graphDir), r));
  if (!root) return { sourceRoots, build: path.relative(stopDir, build) || path.basename(build), outside: true };
  const parts = path.relative(root, graphDir).split(path.sep).filter(Boolean);
  // A folder that isn't a Java identifier can't be a package; the build will say so.
  const valid = parts.every((p) => /^[A-Za-z_$][\w$]*$/.test(p));
  return { ...(parts.length && valid ? { package: parts.join('.') } : {}), sourceRoots, build: path.relative(stopDir, build) || path.basename(build) };
}

// A Go graph's package (docs/language-breadth.md, "Go"): the package the folder's other files
// declare, else the folder's name; its import path in the nearest module; and the module.
export function goPackage(graphDir: string, stopDir: string): { name: string; path?: string; module?: { path: string; dir: string } } {
  let name: string | undefined;
  try {
    for (const file of fs.readdirSync(graphDir)) {
      if (!file.endsWith('.go') || file.endsWith('_test.go') || file.endsWith('_vgraph.go') || file === 'vgraph_runtime.go') continue;
      name = /^package\s+(\w+)/m.exec(fs.readFileSync(path.join(graphDir, file), 'utf8'))?.[1];
      if (name) break;
    }
  } catch {
    // An unreadable folder: its name decides.
  }
  name ??= path.basename(graphDir).toLowerCase().replace(/[^a-z0-9_]/g, '') || 'graphs';
  if (/^[0-9]/.test(name)) name = `p${name}`;
  const modFile = findUp(graphDir, 'go.mod', stopDir);
  if (!modFile) return { name };
  const modulePath = /^module\s+(\S+)/m.exec(fs.readFileSync(modFile, 'utf8'))?.[1];
  if (!modulePath) return { name };
  const relative = path.relative(path.dirname(modFile), graphDir).split(path.sep).filter(Boolean).join('/');
  return { name, path: relative ? `${modulePath}/${relative}` : modulePath, module: { path: modulePath, dir: path.dirname(modFile) } };
}

// A PHP graph's namespace (docs/more-languages.md, "PHP"): under a PSR-4 root of the nearest
// composer.json, the root's namespace and the folders below it; else none (the global namespace).
export function phpNamespace(graphDir: string, stopDir: string): string | undefined {
  const composer = findUp(graphDir, 'composer.json', stopDir);
  if (!composer) return undefined;
  let roots: Record<string, string | string[]> = {};
  try {
    const json = JSON.parse(fs.readFileSync(composer, 'utf8')) as { autoload?: { 'psr-4'?: Record<string, string | string[]> }; 'autoload-dev'?: { 'psr-4'?: Record<string, string | string[]> } };
    roots = { ...json.autoload?.['psr-4'], ...json['autoload-dev']?.['psr-4'] };
  } catch {
    return undefined;
  }
  const base = path.dirname(composer);
  let best: { prefix: string; segments: string[] } | undefined;
  for (const [prefix, dirs] of Object.entries(roots)) {
    for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
      const relative = path.relative(path.resolve(base, dir), graphDir);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const segments = relative.split(path.sep).filter(Boolean);
      if (!best || segments.length < best.segments.length) best = { prefix, segments };
    }
  }
  if (!best) return undefined;
  const parts = [...best.prefix.split('\\').filter(Boolean), ...best.segments];
  return parts.every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) ? parts.join('\\') : undefined;
}

// A GDScript graph's Godot project (docs/more-languages.md, "GDScript"): the nearest folder with a
// project.godot, up to the workspace folder.
export function godotProject(graphDir: string, stopDir: string): string | undefined {
  const file = findUp(graphDir, 'project.godot', stopDir);
  return file && path.dirname(file);
}

// The project's Go files Run builds with a generated one: the other files of its package.
export function goRunSources(outputFile: string): string[] {
  const dir = path.dirname(outputFile);
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && f !== 'vgraph_runtime.go' && f.toLowerCase() !== path.basename(outputFile).toLowerCase())
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

export function verifyPlacement(language: string, outputFile: string, stopDir: string): CompileDiagnostic[] {
  const dir = path.dirname(outputFile);
  if (language === 'go' && goPackage(dir, stopDir).name === 'main') {
    return [{
      severity: 'warning',
      code: 'go-main-package',
      message: `${path.basename(outputFile)} is in package main, which nothing can import, so Run can't run it. Put the graph in another package's folder.`
    }];
  }
  if (language === 'java') {
    const project = javaProject(dir, stopDir);
    if (project.outside) {
      return [{
        severity: 'warning',
        code: 'java-outside-source-root',
        message: `${path.basename(outputFile)} isn't in a source folder of ${project.build}, so the project's build won't compile it. Move the graph under ${project.sourceRoots.map((r) => path.relative(stopDir, r)).join(' or ') || 'src/main/java'}.`
      }];
    }
  }
  if (language === 'typescript' || language === 'javascript') {
    const configName = language === 'typescript' ? 'tsconfig.json' : 'jsconfig.json';
    const config = findUp(dir, configName, stopDir);
    if (config && configCovers(config, outputFile) === false) {
      return [{
        severity: 'warning',
        code: 'output-outside-config',
        message: `${path.basename(outputFile)} isn't included by ${path.relative(stopDir, config) || configName}, so the project's build won't see it. Add its folder to "include".`
      }];
    }
  }
  if (language === 'python') {
    const folder = pythonImportBlocker(dir, stopDir);
    if (folder) {
      return [{
        severity: 'warning',
        code: 'python-not-importable',
        message: `Other modules can't import ${path.basename(outputFile, '.py')} because the folder name "${folder}" isn't a valid Python identifier. It still runs as a script.`
      }];
    }
  }
  return [];
}

// Whether a tsconfig/jsconfig includes `file`; undefined when that can't be decided (e.g. the
// file list comes from an `extends` base).
export function configCovers(configFile: string, file: string): boolean | undefined {
  const config = readJson(configFile) as { files?: string[]; include?: string[]; exclude?: string[]; extends?: unknown; compilerOptions?: { outDir?: string } } | undefined;
  if (!config) return undefined;
  const base = path.dirname(configFile);
  const relative = toPosix(path.relative(base, file));
  if (relative.startsWith('..')) return false;
  if (config.files?.some((f) => toPosix(path.normalize(f)) === relative)) return true;
  if (!config.include && !config.files && config.extends) return undefined;
  const include = config.include ?? (config.files ? [] : ['**/*']);
  const exclude = config.exclude ?? ['node_modules', 'bower_components', 'jspm_packages', ...(config.compilerOptions?.outDir ? [config.compilerOptions.outDir] : [])];
  const matches = (pattern: string, isExclude: boolean) => globToRegExp(pattern, isExclude).test(relative);
  return include.some((p) => matches(p, false)) && !exclude.some((p) => matches(p, true));
}

// The first folder between the Python project root and `dir` whose name can't be a package name.
function pythonImportBlocker(dir: string, stopDir: string): string | undefined {
  const marker = ['pyproject.toml', 'setup.py', 'setup.cfg'].map((m) => findUp(dir, m, stopDir)).find(Boolean);
  const root = marker ? path.dirname(marker) : stopDir;
  const segments = toPosix(path.relative(root, dir)).split('/').filter(Boolean);
  return segments.find((s) => !/^[A-Za-z_]\w*$/.test(s));
}

// tsconfig-style glob: `**` spans folders, `*` and `?` stay within one. A pattern naming a folder
// (no wildcard in its last part and no extension) covers everything under it.
export function globToRegExp(pattern: string, prefixMatch = false): RegExp {
  let glob = toPosix(path.normalize(pattern)).replace(/^\.\//, '').replace(/\/$/, '');
  const last = glob.split('/').pop() ?? '';
  if (!/[*?]/.test(last) && !/\.[^/]+$/.test(last)) glob = glob === '.' ? '**/*' : `${glob}/**/*`;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}${prefixMatch ? '(?:/.*)?' : ''}$`, process.platform === 'win32' ? 'i' : '');
}

// JSON with comments and trailing commas, as tsconfig.json allows.
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readJson(file: string): unknown {
  try {
    return parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isInside(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
