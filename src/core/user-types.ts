// Structs and enums (docs/program-structure.md, "Structs and enums"): `.vgraph` files of kind
// "structure" (fields with types and defaults) and "enumeration" (named values). They are workspace
// types, used as `struct:<Name>` and `enum:<Name>` pin types. Their nodes (Make, Break, Set Members;
// Switch on, ==, !=) carry the type's description, so the compiler, Simulate and the editor learn
// the type from the node registry like everything else.
import { GraphDocument, NodeDefinition, PinDefinition } from './model';
import { TypeRef, parseTypeId } from './types';

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
}

export interface EnumInfo {
  kind: 'enum';
  id: string;
  name: string;
  enumerators: Enumerator[];
  language?: string;
  description?: string;
  source?: TypeSource;
}

export type UserType = StructInfo | EnumInfo;

export type TypeLookup = (id: string) => UserType | undefined;

export function structTypeId(name: string): string {
  return `struct:${name}`;
}

export function enumTypeId(name: string): string {
  return `enum:${name}`;
}

// The type a structure or enumeration document declares.
export function declaredType(doc: GraphDocument, source?: TypeSource): UserType | undefined {
  const common = { name: doc.name, ...(doc.language ? { language: doc.language } : {}), ...(typeof doc.metadata?.description === 'string' ? { description: doc.metadata.description } : {}), ...(source ? { source } : {}) };
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
export function userTypeDefinitions(type: UserType): NodeDefinition[] {
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

// Every struct and enum the definitions describe, by type id, for graphs in `language`.
export function typeLookup(definitions: Iterable<NodeDefinition>, language?: string): TypeLookup {
  const types = new Map<string, UserType>();
  for (const def of definitions) {
    const implementation = def.implementation;
    if (implementation?.kind !== 'struct' && implementation?.kind !== 'enum') continue;
    const type = implementation.type;
    if (language && type.language && type.language !== language) continue;
    if (!types.has(type.id)) types.set(type.id, type);
  }
  return (id) => types.get(id);
}

export function isUserTypeId(id: string): boolean {
  const category = parseTypeId(id).category;
  return category === 'struct' || category === 'enum';
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

// The structs and enums graphs in `language` can use, by name.
export function listUserTypes(definitions: Iterable<NodeDefinition>, language?: string): UserType[] {
  const types = new Map<string, UserType>();
  for (const def of definitions) {
    const implementation = def.implementation;
    if (implementation?.kind !== 'struct' && implementation?.kind !== 'enum') continue;
    const type = implementation.type;
    if (language && type.language && type.language !== language) continue;
    if (!types.has(type.id)) types.set(type.id, type);
  }
  return [...types.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
