// Structs and enums (docs/program-structure.md, "Structs and enums"): `.vgraph` files of kind
// "structure" (fields with types and defaults) and "enumeration" (named values). They are workspace
// types, used as `struct:<Name>` and `enum:<Name>` pin types. Their nodes (Make, Break, Set Members;
// Switch on, ==, !=) carry the type's description, so the compiler, Simulate and the editor learn
// the type from the node registry like everything else.
import { Graph, GraphDocument, GraphNode, NodeDefinition, PinDefinition } from './model';
import { TypeRef, parseTypeId } from './types';
import type { ClassInfo, InterfaceInfo } from './objects';

export interface StructField {
  id: string;
  name: string;
  type: TypeRef;
  defaultValue?: unknown;
  description?: string;
}

export interface Enumerator {
  id: string;
  name: string;
  description?: string;
}

// Where a type is declared and generated, for imports.
export interface TypeSource {
  // The type's .vgraph file and its generated file, workspace-relative with "/" separators.
  document: string;
  generatedPath: string;
  // Python: the generated module's import name. C#: the type's namespace.
  module?: string;
}

export interface StructInfo {
  kind: 'struct';
  // The pin type id, "struct:<Name>".
  id: string;
  name: string;
  fields: StructField[];
  language?: string;
  description?: string;
  source?: TypeSource;
  // A shared type's languages (its own first) and where each generates it; typeLookup gives each
  // language its own view, with `language` and `source` set to that language's.
  languages?: string[];
  sources?: Record<string, TypeSource>;
}

export interface EnumInfo {
  kind: 'enum';
  id: string;
  name: string;
  enumerators: Enumerator[];
  language?: string;
  description?: string;
  source?: TypeSource;
  languages?: string[];
  sources?: Record<string, TypeSource>;
}

// Workspace types: structs, enums, and classes (src/core/objects.ts).
export type UserType = StructInfo | EnumInfo | ClassInfo | InterfaceInfo;

export type TypeLookup = (id: string) => UserType | undefined;

export function structTypeId(name: string): string {
  return `struct:${name}`;
}

export function enumTypeId(name: string): string {
  return `enum:${name}`;
}

// The languages a structure, enumeration or function library is generated for: its own, then its
// other languages.
export function generatedLanguages(doc: GraphDocument): string[] {
  const others = doc.kind === 'structure' || doc.kind === 'enumeration' || doc.kind === 'functionLibrary' ? doc.languages ?? [] : [];
  return [...new Set([doc.language ?? '', ...others].filter(Boolean))];
}

// The type a structure or enumeration document declares. `sources` are where its other languages
// generate it, for a shared type.
export function declaredType(doc: GraphDocument, source?: TypeSource, sources?: Record<string, TypeSource>): StructInfo | EnumInfo | undefined {
  const languages = generatedLanguages(doc);
  const all = { ...sources, ...(source && doc.language ? { [doc.language]: source } : {}) };
  const shared = languages.length > 1 ? { languages, ...(Object.keys(all).length ? { sources: all } : {}) } : {};
  const common = { name: doc.name, ...(doc.language ? { language: doc.language } : {}), ...(typeof doc.metadata?.description === 'string' ? { description: doc.metadata.description } : {}), ...(source ? { source } : {}), ...shared };
  if (doc.kind === 'structure') {
    return { kind: 'struct', id: structTypeId(doc.name), ...common, fields: doc.variables.map((v) => ({ id: v.id, name: v.name, type: v.type, ...(v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}), ...(v.description ? { description: v.description } : {}) })) };
  }
  if (doc.kind === 'enumeration') return { kind: 'enum', id: enumTypeId(doc.name), ...common, enumerators: doc.enumerators ?? [] };
  return undefined;
}

// ---- Nodes ------------------------------------------------------------------------------------

const STRUCT_COLOR = '#1f4fa8';
const ENUM_COLOR = '#0f6b5f';

const execIn: PinDefinition = { id: 'execIn', name: '', kind: 'exec', direction: 'input' };
const execOut: PinDefinition = { id: 'execOut', name: '', kind: 'exec', direction: 'output' };

function data(id: string, name: string, direction: PinDefinition['direction'], type: TypeRef, defaultValue?: unknown): PinDefinition {
  return { id, name, kind: 'data', direction, type, ...(defaultValue !== undefined ? { defaultValue } : {}) };
}

export function structNodeType(type: StructInfo, operation: StructOperation): string {
  return `${type.id}.${operation}`;
}

export function enumNodeType(type: EnumInfo, operation: EnumOperation): string {
  return `${type.id}.${operation}`;
}

export type StructOperation = 'make' | 'break' | 'set-members';
export type EnumOperation = 'switch' | 'equal' | 'not-equal';

// Make, Break and Set Members for a struct; Switch on, == and != for an enum.
export function userTypeDefinitions(type: StructInfo | EnumInfo): NodeDefinition[] {
  return type.kind === 'struct' ? structDefinitions(type) : enumDefinitions(type);
}

function structDefinitions(type: StructInfo): NodeDefinition[] {
  const struct: TypeRef = { id: type.id };
  const fieldPins = (direction: PinDefinition['direction']) => type.fields.map((f) => data(f.id, f.name, direction, f.type, direction === 'input' ? f.defaultValue : undefined));
  const category = 'Structs';
  return [
    {
      type: structNodeType(type, 'make'), version: 1, displayName: `Make ${type.name}`, category, color: STRUCT_COLOR,
      description: `A new ${type.name} from its fields.`, keywords: ['make', 'struct', 'construct'],
      inputs: fieldPins('input'), outputs: [data('struct', type.name, 'output', struct)],
      implementation: { kind: 'struct', operation: 'make', type }
    },
    {
      type: structNodeType(type, 'break'), version: 1, displayName: `Break ${type.name}`, category, color: STRUCT_COLOR,
      description: `The fields of a ${type.name}.`, keywords: ['break', 'struct', 'fields'],
      inputs: [data('struct', type.name, 'input', struct)], outputs: fieldPins('output'),
      implementation: { kind: 'struct', operation: 'break', type }
    },
    {
      // Unreal's "Set members in": changes some fields of a struct variable (wired from its Get),
      // leaving the others.
      type: structNodeType(type, 'set-members'), version: 1, displayName: `Set members in ${type.name}`, category, color: STRUCT_COLOR,
      description: `Changes fields of a ${type.name} variable wired into it. Its output is the changed value.`, keywords: ['set', 'members', 'struct'],
      inputs: [execIn, data('struct', type.name, 'input', struct), ...type.fields.map((f) => data(f.id, f.name, 'input', f.type))],
      outputs: [execOut, data('result', type.name, 'output', struct)],
      implementation: { kind: 'struct', operation: 'set-members', type }
    }
  ];
}

function enumDefinitions(type: EnumInfo): NodeDefinition[] {
  const value: TypeRef = { id: type.id };
  const first = type.enumerators[0]?.id;
  const category = 'Enums';
  const compare = (operation: 'equal' | 'not-equal', symbol: string, verb: string): NodeDefinition => ({
    type: enumNodeType(type, operation), version: 1, displayName: `${symbol} (${type.name})`, category, color: ENUM_COLOR, compact: true,
    description: `True if A ${verb} B.`, keywords: [operation === 'equal' ? 'equal' : 'not equal', type.name],
    inputs: [data('a', 'A', 'input', value, first), data('b', 'B', 'input', value, first)], outputs: [data('returnValue', '', 'output', { id: 'bool' })],
    implementation: { kind: 'enum', operation, type }
  });
  return [
    {
      type: enumNodeType(type, 'switch'), version: 1, displayName: `Switch on ${type.name}`, category, color: ENUM_COLOR,
      description: `Runs the output named after the value.`, keywords: ['switch', 'case', type.name],
      inputs: [execIn, data('selection', 'Selection', 'input', value, first)],
      outputs: type.enumerators.map((e) => ({ id: e.id, name: e.name, kind: 'exec' as const, direction: 'output' as const })),
      implementation: { kind: 'enum', operation: 'switch', type }
    },
    compare('equal', '==', 'equals'),
    compare('not-equal', '!=', 'does not equal')
  ];
}

// Every struct, enum and class the definitions describe, by type id, for graphs in `language`.
export function typeLookup(definitions: Iterable<NodeDefinition>, language?: string): TypeLookup {
  const types = new Map<string, UserType>();
  for (const def of definitions) {
    const implementation = def.implementation;
    if (implementation?.kind !== 'struct' && implementation?.kind !== 'enum' && implementation?.kind !== 'class' && implementation?.kind !== 'interface') continue;
    const type = forLanguage(implementation.type, language);
    if (type && !types.has(type.id)) types.set(type.id, type);
  }
  return (id) => types.get(id);
}

// A type as graphs in `language` see it, or undefined when they can't use it. A shared struct or
// enum is seen with that language's generated file.
function forLanguage(type: UserType, language: string | undefined): UserType | undefined {
  if (!language || !type.language || type.language === language) return type;
  if ((type.kind !== 'struct' && type.kind !== 'enum') || !type.languages?.includes(language)) return undefined;
  const source = type.sources?.[language];
  return { ...type, language, ...(source ? { source } : {}) };
}

// A struct, enum, class or interface a graph mentions that its language can't use: one declared in
// another language's graph file, or not declared at all. Generated code would otherwise lose it
// (docs/multi-language.md, gap 2). `own` are the types the graph file itself declares.
export interface TypeProblem {
  code: 'wrong-language' | 'unknown-type';
  message: string;
  graphId?: string;
  nodeId?: string;
}

export function userTypeProblems(
  doc: GraphDocument,
  own: (string | undefined)[],
  resolve: (node: GraphNode) => NodeDefinition | undefined,
  definitions: Iterable<NodeDefinition>,
  // The display names of the graph's language and of others.
  names: { graph: string; of: (language: string) => string }
): TypeProblem[] {
  const all = [...definitions];
  const types = typeLookup(all, doc.language);
  const anywhere = typeLookup(all);
  const known = new Set(own);
  const problems: TypeProblem[] = [];
  const reported = new Set<string>();
  const check = (value: unknown, graphId?: string, nodeId?: string): void => {
    if (Array.isArray(value)) value.forEach((item) => check(item, graphId, nodeId));
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach((item) => check(item, graphId, nodeId));
    if (typeof value !== 'string' || !isUserTypeId(value) || known.has(value) || types(value)) return;
    // Once per place, and nodes that read a variable don't repeat the variable's problem.
    const key = `${value} ${graphId ?? ''} ${nodeId ?? ''}`;
    if (reported.has(key) || reported.has(`${value}  `)) return;
    reported.add(key);
    const other = anywhere(value);
    const { category, name } = parseTypeId(value);
    // A missing class or interface has its own errors where it's used (class-missing, parent-missing).
    if (!other?.language && category !== 'struct' && category !== 'enum') return;
    const word = USER_TYPE_WORDS[category];
    const languages = other && (other.kind === 'struct' || other.kind === 'enum') && other.languages ? other.languages : other?.language ? [other.language] : [];
    const message = other?.language
      ? `${other.name} is a ${languages.map(names.of).join(' and ')} ${word}${other.source ? ` (${other.source.document})` : ''}; a ${names.graph} graph can't use it.`
      : `No ${word} named ${name} is declared in the workspace.`;
    problems.push({ code: other?.language ? 'wrong-language' : 'unknown-type', message, ...(graphId ? { graphId } : {}), ...(nodeId ? { nodeId } : {}) });
  };
  check([doc.variables, doc.dispatchers, doc.parent, doc.interfaces]);
  for (const graph of doc.graphs) {
    check([graph.signature, graph.localVariables], graph.id);
    for (const node of graph.nodes) {
      const definition = resolve(node);
      const implementation = definition?.implementation;
      // A type's own nodes (Make, Break, Switch on, ...) name the type; its fields are its file's concern.
      const owner = implementation?.kind === 'struct' || implementation?.kind === 'enum' || implementation?.kind === 'class' || implementation?.kind === 'interface' ? implementation.type.id : undefined;
      check([node.properties, owner ?? [definition?.inputs.map((p) => p.type), definition?.outputs.map((p) => p.type)]], graph.id, node.id);
    }
  }
  return problems;
}

const USER_TYPE_WORDS: Record<string, string> = { struct: 'struct', enum: 'enum', object: 'class', interface: 'interface' };

// Graph files declaring a type name another file declares too. A name means one type in a
// workspace, so the registry keeps the last file's (in `files` order) and graphs use that one; each
// other file gets a problem saying so.
export function duplicateTypes<T extends { path: string; definitions: NodeDefinition[] }>(files: T[]): { file: T; message: string }[] {
  const declared = new Map<string, { file: T; type: UserType }[]>();
  for (const file of files) {
    const types = new Map<string, UserType>();
    for (const def of file.definitions) {
      const implementation = def.implementation;
      if (implementation?.kind === 'struct' || implementation?.kind === 'enum' || implementation?.kind === 'class' || implementation?.kind === 'interface') types.set(implementation.type.id, implementation.type);
    }
    for (const [id, type] of types) declared.set(id, [...(declared.get(id) ?? []), { file, type }]);
  }
  return [...declared.values()].filter((all) => all.length > 1).flatMap((all) => {
    const used = all[all.length - 1];
    const word = USER_TYPE_WORDS[parseTypeId(used.type.id).category];
    return all.slice(0, -1).map(({ file }) => ({ file, message: `A ${word} named ${used.type.name} is also declared in ${used.file.path}, and graphs use that one: a name means one type in the workspace. Rename one of them.` }));
  });
}

export function isUserTypeId(id: string): boolean {
  const category = parseTypeId(id).category;
  return category === 'struct' || category === 'enum' || category === 'object' || category === 'interface';
}

// ---- Values (Simulate) --------------------------------------------------------------------------

// A struct value in Simulate: its fields by id, in the struct's order. Struct values are never
// changed in place (Set Members makes a new one), which gives them Unreal's value semantics.
export class StructValue {
  constructor(readonly type: StructInfo, readonly fields: ReadonlyMap<string, unknown>) {}

  get(fieldId: string): unknown {
    return this.fields.get(fieldId);
  }

  with(changes: ReadonlyMap<string, unknown>): StructValue {
    return new StructValue(this.type, new Map(this.type.fields.map((f) => [f.id, changes.has(f.id) ? changes.get(f.id) : this.fields.get(f.id)])));
  }

  // As Print shows it: an object with a key per field name, in field order.
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.type.fields.map((f) => [f.name, this.fields.get(f.id)]));
  }
}

// An enum value in Simulate is its enumerator's name, which is also how it prints.
export function enumeratorName(type: EnumInfo, id: unknown): string {
  return type.enumerators.find((e) => e.id === id)?.name ?? type.enumerators[0]?.name ?? '';
}

// Set members in shows a pin for each field chosen in its Details (`properties.members`, field
// ids), as Unreal's does; the other fields keep their values.
export function setMembersDefinition(base: NodeDefinition, members: unknown): NodeDefinition {
  const chosen = new Set(Array.isArray(members) ? members.filter((m): m is string => typeof m === 'string') : []);
  return { ...base, inputs: base.inputs.filter((p) => p.kind === 'exec' || p.id === 'struct' || chosen.has(p.id)) };
}

// The structs, enums and classes graphs in `language` can use, by name.
export function listUserTypes(definitions: Iterable<NodeDefinition>, language?: string): UserType[] {
  const types = new Map<string, UserType>();
  for (const def of definitions) {
    const implementation = def.implementation;
    if (implementation?.kind !== 'struct' && implementation?.kind !== 'enum' && implementation?.kind !== 'class' && implementation?.kind !== 'interface') continue;
    const type = forLanguage(implementation.type, language);
    if (type && !types.has(type.id)) types.set(type.id, type);
  }
  return [...types.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---- Split struct pins (Unreal's Split Struct Pin and Recombine Struct Pin) ---------------------
//
// A struct pin listed in a node's `properties.split` shows a pin per field instead, with the id
// "<pin>.<field>" (a field that is a struct can be split again). Before compiling and Simulate,
// expandSplitPins turns each split into a hidden Make or Break node, so nothing else needs to know.

export const SPLIT_PROPERTY = 'split';

export function splitPinIds(properties: Record<string, unknown>): string[] {
  const value = properties[SPLIT_PROPERTY];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// The struct a pin type names, from its Make node's definition.
export function structInfo(type: TypeRef | undefined, definition: (type: string) => NodeDefinition | undefined): StructInfo | undefined {
  if (!type || type.container || !type.id.startsWith('struct:')) return undefined;
  const implementation = definition(`${type.id}.make`)?.implementation;
  return implementation?.kind === 'struct' ? implementation.type : undefined;
}

// The definition with the node's split pins replaced by a pin per field.
export function applySplits(def: NodeDefinition, split: readonly string[], definition: (type: string) => NodeDefinition | undefined): NodeDefinition {
  if (!split.length) return def;
  const expand = (pins: PinDefinition[]): PinDefinition[] => pins.flatMap((pin) => {
    const struct = pin.kind === 'data' && split.includes(pin.id) ? structInfo(pin.type, definition) : undefined;
    if (!struct) return [pin];
    return expand(struct.fields.map((f) => ({
      id: `${pin.id}.${f.id}`, name: `${pin.name || pin.id} ${f.name}`, kind: 'data' as const, direction: pin.direction, type: f.type,
      ...(pin.direction === 'input' && f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
      split: { pin: pin.id, field: f.id }
    })));
  });
  return { ...def, inputs: expand(def.inputs), outputs: expand(def.outputs) };
}

// The graph with every split pin replaced by a hidden Make node (inputs) or Break node (outputs),
// with ids "<node>/split:<pin>", so diagnostics and Simulate's events point at the node itself.
// `unsplit` resolves a node as if nothing were split.
export function expandSplitPins(graph: Graph, unsplit: (node: GraphNode) => NodeDefinition | undefined, definition: (type: string) => NodeDefinition | undefined): Graph {
  if (!graph.nodes.some((n) => splitPinIds(n.properties).length)) return graph;
  const nodes: GraphNode[] = [];
  const connections = [...graph.connections];
  // Moves the wires of (node, from) to (target, to).
  const rewire = (node: string, from: string, target: string, to: string): void => {
    for (const c of connections) {
      if (c.toNode === node && c.toPin === from) Object.assign(c, { toNode: target, toPin: to });
      if (c.fromNode === node && c.fromPin === from) Object.assign(c, { fromNode: target, fromPin: to });
    }
  };
  for (const original of graph.nodes) {
    const split = splitPinIds(original.properties);
    if (!split.length) {
      nodes.push(original);
      continue;
    }
    const properties = { ...original.properties };
    delete properties[SPLIT_PROPERTY];
    const node: GraphNode = { ...original, properties };
    nodes.push(node);
    const def = unsplit(node);
    // `owner` holds the struct pin `pin`; the sub-pins on the original node are "<base>.<field>".
    const expand = (owner: GraphNode, pin: PinDefinition, base: string): void => {
      const struct = structInfo(pin.type, definition);
      if (!struct) return;
      const input = pin.direction === 'input';
      const helper: GraphNode = {
        id: `${original.id}${'/'}split:${base}`, type: structNodeType(struct, input ? 'make' : 'break'), position: owner.position, properties: {}
      };
      nodes.push(helper);
      connections.push(input
        ? { id: `${helper.id}>`, fromNode: helper.id, fromPin: 'struct', toNode: owner.id, toPin: pin.id }
        : { id: `${helper.id}<`, fromNode: owner.id, fromPin: pin.id, toNode: helper.id, toPin: 'struct' });
      for (const f of struct.fields) {
        const sub = `${base}.${f.id}`;
        const fieldPin: PinDefinition = { id: f.id, name: f.name, kind: 'data', direction: pin.direction, type: f.type };
        if (split.includes(sub) && structInfo(f.type, definition)) {
          expand(helper, fieldPin, sub);
          continue;
        }
        rewire(original.id, sub, helper.id, f.id);
        const stored = original.properties[`pin:${sub}`];
        if (input && stored !== undefined) helper.properties[`pin:${f.id}`] = stored;
      }
    };
    for (const pin of [...(def?.inputs ?? []), ...(def?.outputs ?? [])]) if (pin.kind === 'data' && split.includes(pin.id)) expand(node, pin, pin.id);
  }
  return { ...graph, nodes, connections };
}
