// Compiling one graph file into its project, as Compile does it: the graph's own language, then a
// shared struct's or enum's other languages (docs/multi-language.md, gap 2), the generated files
// written next to the graph, old outputs of the graph removed, the files registered with the
// project's build (docs/output-placement.md) and the project checked (docs/project-integration.md).
// Free of the vscode API: the extension's CompileService and the corpus of project layouts
// (test/conformance/corpus.ts) both compile through it, so the corpus checks what Compile writes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CompileDiagnostic, CompileResult, compileDocument } from '../core/compiler';
import { LanguagePack, LanguagePackRegistry } from '../core/language-pack';
import { GraphDocument } from '../core/model';
import { OutputPlan, hasBlock, withBlock } from '../core/output-plan';
import { NodeRegistry } from '../core/registry';
import { generatedLanguages } from '../core/user-types';
import { generateOptionsFor, isGeneratedFrom, verifyPlacement } from './placement';
import { ProjectVersionCheck, projectVersionCheck } from './projects';

export interface GraphCompileHost {
  registry: NodeRegistry;
  languages: LanguagePackRegistry;
  // Writes a generated file (skipping one whose text is the same, for watchers and builds).
  write(file: string, text: string): Promise<void>;
  // Deletes a file the graph generated before (in a language it no longer has).
  remove(file: string): Promise<void>;
  // Registers a generated file with the project's build, returning the warnings for the graph.
  register?(pack: LanguagePack, root: string, outputFile: string): Promise<CompileDiagnostic[]>;
}

export interface GraphCompileResult {
  // The graph's own language's compile.
  result: CompileResult;
  language: string;
  // Every diagnostic: the compile's, placement's, the project's, the build registration's and the
  // other languages' (named by language).
  diagnostics: CompileDiagnostic[];
  // Present when the graph compiled.
  outputPath?: string;
  testPath?: string;
  // Every file written, absolute.
  written: string[];
  // The project's language version, checked (undefined outside a project).
  versionCheck?: ProjectVersionCheck;
}

export async function compileGraphFile(graph: GraphDocument, graphPath: string, root: string, host: GraphCompileHost): Promise<GraphCompileResult> {
  const graphDir = path.dirname(graphPath);
  const graphFileName = path.basename(graphPath);
  const options = (language: string | undefined) => ({ registry: host.registry, languages: host.languages, generate: generateOptionsFor(language, graphFileName, graphDir, root, host.languages.get(language ?? '')?.generator) });
  const result = compileDocument(graph, options(graph.language));
  const language = result.output?.language ?? graph.language ?? '';
  if (!result.output) return { result, language, diagnostics: result.diagnostics, written: [] };

  const outputPath = path.join(graphDir, result.output.fileName);
  const files = [{ path: outputPath, text: result.output.text }, ...(result.output.companionFiles ?? []).map((c) => ({ path: path.join(graphDir, c.fileName), text: c.text }))];
  const testFileName = result.output.testFile !== undefined ? host.languages.get(language)?.generator?.testFileName?.(graphFileName) : undefined;
  const testPath = testFileName ? path.join(graphDir, testFileName) : undefined;
  if (testPath) files.push({ path: testPath, text: result.output.testFile! });
  for (const file of files) await host.write(file.path, file.text);

  // A shared struct or enum is generated for its other languages too, next to its own output. Their
  // problems name the language.
  const shared: CompileDiagnostic[] = [];
  for (const other of generatedLanguages(graph).slice(1)) {
    const pack = host.languages.get(other);
    const named = (list: CompileDiagnostic[]) => list.map((d) => ({ ...d, message: `${pack?.displayName ?? other}: ${d.message}` }));
    const compiled = compileDocument({ ...graph, language: other }, options(other));
    shared.push(...named(compiled.diagnostics));
    if (!compiled.output || !pack) continue;
    const outputs = [{ path: path.join(graphDir, compiled.output.fileName), text: compiled.output.text }, ...(compiled.output.companionFiles ?? []).map((c) => ({ path: path.join(graphDir, c.fileName), text: c.text }))];
    for (const output of outputs) await host.write(output.path, output.text);
    files.push(...outputs);
    shared.push(...named([...verifyPlacement(other, outputs[0].path, root), ...(host.register ? await host.register(pack, root, outputs[0].path) : [])]));
  }

  // The graph's outputs in languages it no longer has.
  const written = files.map((f) => f.path);
  for (const candidate of outputPathsFor(host.languages, graphPath)) {
    if (!written.includes(candidate) && isGeneratedFrom(candidate, graphFileName)) await host.remove(candidate);
  }

  const pack = host.languages.get(language);
  const registration = pack && host.register ? await host.register(pack, root, outputPath) : [];
  const versionCheck = pack ? projectVersionCheck(pack, graphDir, root) : undefined;
  const diagnostics = [...result.diagnostics, ...verifyPlacement(language, outputPath, root), ...(versionCheck?.diagnostics ?? []), ...registration, ...shared];
  return { result, language, diagnostics, outputPath, ...(testPath ? { testPath } : {}), written, ...(versionCheck ? { versionCheck } : {}) };
}

// Every file a graph could generate, in any language.
export function outputPathsFor(languages: LanguagePackRegistry, graphPath: string): string[] {
  const dir = path.dirname(graphPath);
  const name = path.basename(graphPath);
  return languages.all().flatMap((p) => (p.generator
    ? [p.generator.outputFileName(name), ...(p.generator.companionFileNames?.(name) ?? []), ...(p.generator.testFileName ? [p.generator.testFileName(name)] : [])].map((f) => path.join(dir, f))
    : []));
}

// A pack's output plan applied as if the user accepted every hook: the files it owns written, and
// each hook's block put in its build file. What the extension does once the user says yes; the
// corpus registers generated files this way.
export function applyAcceptedPlan(pack: LanguagePack, root: string, generatedFiles: string[], outputFile?: string): CompileDiagnostic[] {
  const placement = pack.generator?.placement;
  if (!placement) return [];
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  const plan: OutputPlan = placement({ outputFile: outputFile && posix(path.relative(root, outputFile)), generatedFiles: generatedFiles.map((f) => posix(path.relative(root, f))).sort(), readFile: read, exists: (file) => fs.existsSync(path.join(root, file)) });
  for (const owned of plan.ownedFiles ?? []) {
    const file = path.join(root, owned.path);
    if (owned.text === '') fs.rmSync(file, { force: true });
    else if (read(owned.path) !== owned.text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, owned.text);
    }
  }
  const diagnostics: CompileDiagnostic[] = [...(plan.diagnostics ?? [])];
  for (const hook of plan.hooks ?? []) {
    const text = read(hook.file);
    if (text === undefined) diagnostics.push({ severity: 'warning', code: 'build-registration', message: `${hook.file} doesn't exist, so the generated code isn't registered with the build (${hook.description}).` });
    else if (!hasBlock(text, hook.block)) fs.writeFileSync(path.join(root, hook.file), withBlock(text, hook.block));
  }
  return diagnostics;
}

function posix(p: string): string {
  return p.split(path.sep).join('/');
}
