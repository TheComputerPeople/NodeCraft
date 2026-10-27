// A declarative language pack (docs/language-breadth.md, "Declarative packs"): a JSON definition of
// templates for the Visual IR, a type map and capabilities, which declarativePack turns into a
// LanguagePack. The schema is schemas/language-pack.schema.json.
import { API_VERSION } from '../api';
import { LanguageCapabilities } from '../language-pack';
import { NameStyle } from '../compiler/names';
import { Template, TemplateError, parseTemplate } from './template';

export interface DeclarativePackDefinition {
  id: string;
  displayName: string;
  apiVersion: number;
  // The generated file's name: "{{snake}}_vgraph.c", from the graph file's name without
  // ".vgraph" as `name`, `snake`, `camel` and `pascal`.
  fileName: string;
  workspaceMarkers?: string[];
  // What generated code can express. The format can't yet express object references, inheritance,
  // interfaces, event dispatchers or latent actions, so those must be false (or left out).
  capabilities?: Partial<LanguageCapabilities>;
  // Keys of a code node's `languages` map its snippets are taken from (the pack's id by default).
  snippetLanguages?: string[];
  // Implementations of library nodes (by node type) in the language, for nodes whose definitions
  // have none: a function body over the node's inputs, like a code node's snippet.
  snippets?: Record<string, string>;
  types: {
    // The canonical types' spellings: "int", "float", "bool", "string", "any"; containers with
    // {{T}} for the element (and {{K}}, {{V}} for a map's key and value): "array", "set", "map";
    // user types with {{name}}: "struct", "enum".
    map: Record<string, string>;
    // Each type's default value, by the same keys.
    defaults: Record<string, string>;
  };
  naming: {
    reserved: string[];
    // Case styles (snake, camel, pascal or keep); types are pascal and the rest snake by default.
    type?: NameStyle;
    function?: NameStyle;
    variable?: NameStyle;
    parameter?: NameStyle;
    enumerator?: NameStyle;
  };
  // The spelling of each binary operator: <, <=, >=, ==, !=, &&, ||, + and - (as written by default).
  operators?: Record<string, string>;
  // Templates by name: the file, functions, each statement and expression kind (README of the SDK).
  templates: Record<string, string>;
  // Support code by the identifier it defines: included (once, in this order) when generated code,
  // or other included support code, uses the identifier.
  helpers?: Record<string, string>;
  runner?: DeclarativeRunner;
  debugger?: DeclarativeDebugger;
}

// Run as data. Each argument is a template over the run's facts (file, dir, scaffold, className,
// mainMethod, exe: ".exe" on Windows); an argument that is exactly {{args}} (the program's arguments)
// or {{tests}} (each test's name and method) expands to several.
export interface DeclarativeRunner {
  // Candidate commands, tried in order; per platform ("win32", "linux", "darwin", "default").
  commands: string[][] | Record<string, string[][]>;
  // For languages that build first: arguments for the command that build, and the program to run.
  build?: string[];
  executable?: string;
  // Arguments that run the generated file (after the command, or for the built program).
  run: string[];
  // Arguments that run the tests, as `run` does.
  test?: string[];
  // Files written to a scratch folder (`scaffold`) before running: name → template, given the run's
  // facts and `tests`.
  scaffold?: Record<string, string>;
  env?: Record<string, string>;
  missingToolMessage: string;
}

export interface DeclarativeDebugger {
  type: string;
  extension?: { id: string; name: string };
  platforms?: Record<string, { type: string; extension?: { id: string; name: string } }>;
  // Build arguments, as the runner's `build`, when the debugger needs a build of its own.
  build?: string[];
  // The launch configuration: strings are templates over the run's facts (plus `cwd`); a string
  // that is exactly {{args}} becomes the arguments' list.
  configuration: Record<string, unknown>;
}

// The capabilities the declarative format can express in this phase.
export const DECLARATIVE_LIMITS: (keyof LanguageCapabilities)[] = ['classes', 'inheritance', 'interfaces', 'async', 'delegates'];

export const DECLARATIVE_DEFAULTS: LanguageCapabilities = {
  staticTyping: false, classes: false, inheritance: false, interfaces: false, generics: false, async: false, exceptions: false, containers: [], delegates: false
};

export interface CheckedDefinition {
  definition: DeclarativePackDefinition;
  templates: Map<string, Template>;
  capabilities: LanguageCapabilities;
}

// The definition's problems (empty when it can be used), and its parsed templates.
export function checkDefinition(value: unknown): { problems: string[]; checked?: CheckedDefinition } {
  const problems: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problems: ['A declarative pack definition must be a JSON object.'] };
  const d = value as DeclarativePackDefinition;
  const isString = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (!isString(d.id) || !/^[a-z][a-z0-9-]*$/.test(d.id)) problems.push('"id" must be a lowercase identifier, such as "c" or "my-lang".');
  if (!isString(d.displayName)) problems.push('"displayName" is missing.');
  if (d.apiVersion !== API_VERSION) problems.push(`"apiVersion" is ${JSON.stringify(d.apiVersion)}, but this extension's API version is ${API_VERSION}.`);
  if (!isString(d.fileName)) problems.push('"fileName" is missing.');
  if (!d.types || typeof d.types.map !== 'object' || typeof d.types.defaults !== 'object') problems.push('"types" needs "map" and "defaults".');
  if (!d.naming || !Array.isArray(d.naming.reserved)) problems.push('"naming" needs "reserved", the language\'s reserved words.');
  if (!d.templates || typeof d.templates !== 'object') problems.push('"templates" is missing.');
  const capabilities: LanguageCapabilities = { ...DECLARATIVE_DEFAULTS, ...(d.capabilities ?? {}) };
  for (const key of DECLARATIVE_LIMITS) {
    if (capabilities[key]) problems.push(`"capabilities.${key}" can't be true: declarative packs can't express it yet.`);
  }
  if (d.runner) {
    if (!Array.isArray(d.runner.run)) problems.push('"runner.run" must be a list of arguments.');
    if (!d.runner.commands || typeof d.runner.commands !== 'object') problems.push('"runner.commands" must list candidate commands.');
    if (!isString(d.runner.missingToolMessage)) problems.push('"runner.missingToolMessage" is missing.');
    if (d.runner.build && !isString(d.runner.executable)) problems.push('"runner.executable" is needed with "runner.build".');
  }
  if (d.debugger && (!isString(d.debugger.type) || typeof d.debugger.configuration !== 'object')) problems.push('"debugger" needs "type" and "configuration".');
  const templates = new Map<string, Template>();
  const parse = (where: string, source: unknown): void => {
    if (typeof source !== 'string') {
      problems.push(`${where} must be a string.`);
      return;
    }
    try {
      templates.set(where, parseTemplate(source));
    } catch (error) {
      problems.push(`${where}: ${error instanceof TemplateError ? error.message : String(error)}`);
    }
  };
  if (d.templates && typeof d.templates === 'object') {
    for (const [name, source] of Object.entries(d.templates)) parse(name, source);
    for (const required of ['file', 'function']) if (!(required in d.templates)) problems.push(`"templates.${required}" is missing.`);
  }
  if (problems.length) return { problems };
  return { problems, checked: { definition: d, templates, capabilities } };
}
