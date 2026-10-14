// Value rules shared by Simulate and, as a reference, by every language pack's generated helpers.
// See docs/semantics.md ("Values").
import { TypeRef } from './types';
import { StructValue, TypeLookup, enumeratorName } from './user-types';

// `types` describes the workspace's structs and enums (src/core/user-types.ts): a struct's default
// has each field's default, an enum's is its first value.
export function defaultValue(type: TypeRef | undefined, types?: TypeLookup): unknown {
  if (!type) return null;
  if (type.container === 'array') return [];
  if (type.container === 'set') return new Set();
  if (type.container === 'map') return new Map();
  const user = types?.(type.id);
  if (user?.kind === 'struct') return new StructValue(user, new Map(user.fields.map((f) => [f.id, f.defaultValue !== undefined ? fromStored(f.defaultValue, f.type, types) : defaultValue(f.type, types)])));
  if (user?.kind === 'enum') return enumeratorName(user, undefined);
  switch (type.id) {
    case 'bool':
      return false;
    case 'int':
    case 'float':
      return 0;
    case 'string':
      return '';
    default:
      return null;
  }
}

// JavaScript truthiness already matches the rule: false, 0, NaN, '' and null are false.
export function toBoolean(value: unknown): boolean {
  return Boolean(value);
}

export function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

// A type's default as stored in a graph file (JSON): containers are empty arrays; a struct is an
// object of the fields that differ from their defaults (none); an enum is its first value's id.
export function storedDefault(type: TypeRef | undefined, types?: TypeLookup): unknown {
  if (type?.container) return [];
  if (type?.id.startsWith('struct:')) return {};
  if (type?.id.startsWith('enum:')) {
    const user = types?.(type.id);
    return user?.kind === 'enum' ? user.enumerators[0]?.id ?? null : null;
  }
  return defaultValue(type);
}

// A stored value (a variable's default, a value typed on a pin) as a value of `type`: containers
// are stored as JSON arrays, maps as [key, value] pairs; a struct as an object of field values by
// field id (missing fields take their defaults); an enum value as its enumerator's id.
export function fromStored(value: unknown, type: TypeRef | undefined, types?: TypeLookup): unknown {
  const user = type && !type.container ? types?.(type.id) : undefined;
  if (user?.kind === 'enum') return enumeratorName(user, value);
  if (user?.kind === 'struct') {
    const stored = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const base = defaultValue(type, types) as StructValue;
    return base.with(new Map(user.fields.filter((f) => stored[f.id] !== undefined).map((f) => [f.id, fromStored(stored[f.id], f.type, types)])));
  }
  if (!type?.container || !Array.isArray(value)) return value;
  const element = (item: unknown, t: TypeRef): unknown => fromStored(item, t, types);
  const elementType: TypeRef = { id: type.id };
  if (type.container === 'set') return new Set(value.map((v) => element(v, elementType)));
  if (type.container === 'map') {
    return new Map(value.filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length === 2).map(([k, v]) => [element(k, elementType), type.valueType ? element(v, type.valueType) : v]));
  }
  return value.map((v) => element(v, elementType));
}

// Text form of a value, as Print shows it. Numbers use JavaScript's shortest round-trip form, so
// other languages' helpers reproduce that algorithm. Containers print as JSON: sets in ascending
// order (they have no order of their own), maps as objects in the order their keys were added.
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, (_key, v: unknown) => (v instanceof Set ? [...v].sort(compareValues) : v instanceof Map ? Object.fromEntries(v) : v)) ?? '';
  } catch {
    return String(value);
  }
}

function compareValues(a: unknown, b: unknown): number {
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}
