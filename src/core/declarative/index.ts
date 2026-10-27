// Declarative language packs (docs/language-breadth.md, "Declarative packs"): a definition (JSON)
// becomes a LanguagePack whose generator renders the Visual IR through the definition's templates
// and whose runner and debugger are the definition's, as data.
import { CodeDebugger, CodeRunner, LanguagePack, RunContext } from '../language-pack';
import { TypeRef } from '../types';
import { CheckedDefinition, DeclarativeDebugger, DeclarativePackDefinition, DeclarativeRunner, checkDefinition } from './definition';
import { DeclarativeEmitter, declarativeFileName, declarativeLibraryExports, typeKey } from './generator';
import { TemplateValue, parseTemplate, renderTemplate } from './template';

export type { DeclarativeDebugger, DeclarativePackDefinition, DeclarativeRunner } from './definition';
export { checkDefinition } from './definition';
export { parseTemplate, renderTemplate, TemplateError } from './template';
export type { Template, TemplateValue } from './template';

// The pack, or why the definition can't be one.
export function loadDeclarativePack(value: unknown): { pack?: LanguagePack; problems: string[] } {
  const { problems, checked } = checkDefinition(value);
  if (!checked) return { problems };
  return { pack: packFrom(checked), problems };
}

// The pack for a definition; throws when the definition has problems.
export function declarativePack(definition: DeclarativePackDefinition): LanguagePack {
  const { pack, problems } = loadDeclarativePack(definition);
  if (!pack) throw new Error(`The ${definition?.displayName ?? definition?.id ?? 'declarative'} pack definition has problems:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return pack;
}

function packFrom(checked: CheckedDefinition): LanguagePack {
  const d = checked.definition;
  const extension = /(\.[\w]+)$/.exec(d.fileName.replace(/\{\{[^}]*\}\}/g, ''))?.[1] ?? '';
  return {
    id: d.id,
    apiVersion: d.apiVersion,
    displayName: d.displayName,
    generatedFileExtension: extension,
    workspaceMarkers: d.workspaceMarkers ?? [],
    capabilities: checked.capabilities,
    mapType: (type) => spellType(checked, type),
    generator: {
      snippetLanguages: d.snippetLanguages ?? [d.id],
      importLanguages: [d.id],
      ...(d.snippets ? { snippets: d.snippets } : {}),
      outputFileName: (graphFileName) => declarativeFileName(d, graphFileName),
      libraryExports: (_name, functions) => declarativeLibraryExports(checked, functions),
      generate: (program, options) => new DeclarativeEmitter(checked, program, options).emit(),
      ...(d.runner ? { runner: runnerFrom(d.runner) } : {}),
      ...(d.debugger && d.runner ? { debugger: debuggerFrom(d.debugger) } : {})
    }
  };
}

// A type's spelling, for the editor (Run uses the emitter's).
function spellType(checked: CheckedDefinition, type: TypeRef): string {
  const map = checked.definition.types.map;
  const spell = (t: TypeRef | undefined): string => {
    const source = map[typeKey(t)];
    if (source === undefined) return t?.id ?? 'any';
    const element = t?.container ? spell({ id: t.id }) : '';
    return renderTemplate(parseTemplate(source), { T: element, K: element, V: t?.container ? spell(t.valueType) : '', name: t ? t.id.replace(/^\w+:/, '') : '' });
  };
  return spell(type);
}

// ---- Runner and debugger ---------------------------------------------------------------------------

// What argument templates can use.
function facts(file: { path: string; url: string }, className: string, context: RunContext | undefined): Record<string, TemplateValue> {
  const slash = (p: string) => p.replace(/\\/g, '/');
  const path = slash(file.path);
  return {
    file: path, url: file.url, dir: path.replace(/\/[^/]*$/, ''), name: path.replace(/^.*\//, '').replace(/\.[^.]*$/, ''),
    scaffold: slash(context?.scaffoldDir ?? ''), className, mainMethod: context?.mainMethod ?? '',
    exe: context?.platform === 'win32' ? '.exe' : '', platform: context?.platform ?? ''
  };
}

function renderArgs(args: string[], values: Record<string, TemplateValue>, expand: Record<string, string[]>): string[] {
  return args.flatMap((arg) => {
    const spread = /^\{\{\s*(\w+)\s*\}\}$/.exec(arg)?.[1];
    if (spread && spread in expand) return expand[spread];
    return [renderTemplate(parseTemplate(arg), values)];
  });
}

function runnerFrom(r: DeclarativeRunner): CodeRunner {
  const run = (args: string[]) => (file: { path: string; url: string }, className: string, context?: RunContext & { tests?: { name: string; method: string }[] }) =>
    renderArgs(args, facts(file, className, context), { args: context?.args ?? [], tests: (context?.tests ?? []).flatMap((t) => [t.name, t.method]) });
  return {
    commands: (platform) => (Array.isArray(r.commands) ? r.commands : r.commands[platform] ?? r.commands.default ?? []),
    args: run(r.run),
    ...(r.test ? { testArgs: run(r.test) } : {}),
    ...(r.build ? { build: run(r.build), executable: (file, className, context) => renderTemplate(parseTemplate(r.executable!), facts(file, className, context)) } : {}),
    ...(r.scaffold ? {
      scaffold: (file, className, context) => Object.fromEntries(Object.entries(r.scaffold!).map(([name, source]) => [name, renderTemplate(parseTemplate(source), facts(file, className, context))]))
    } : {}),
    ...(r.env ? { env: r.env } : {}),
    missingToolMessage: r.missingToolMessage
  };
}

function debuggerFrom(d: DeclarativeDebugger): CodeDebugger {
  const fill = (value: unknown, values: Record<string, TemplateValue>, args: string[]): unknown => {
    if (typeof value === 'string') return /^\{\{\s*args\s*\}\}$/.test(value) ? args : renderTemplate(parseTemplate(value), values);
    if (Array.isArray(value)) return value.flatMap((v) => (typeof v === 'string' && /^\{\{\s*args\s*\}\}$/.test(v) ? args : [fill(v, values, args)]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, values, args)]));
    return value;
  };
  return {
    type: d.type,
    ...(d.extension ? { extension: d.extension } : {}),
    ...(d.platforms ? { platforms: d.platforms } : {}),
    ...(d.build ? { build: (file, className, context) => renderArgs(d.build!, facts(file, className, context), { args: context.args ?? [] }) } : {}),
    configuration: (file, className, context) => fill(d.configuration, { ...facts(file, className, context), cwd: context.cwd.replace(/\\/g, '/') }, context.args ?? []) as Record<string, unknown>
  };
}
