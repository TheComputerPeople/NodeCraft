// Value rules shared by Simulate and, as a reference, by every language pack's generated helpers.
// See docs/semantics.md ("Values").
import { TypeRef } from './types';

export function defaultValue(type: TypeRef | undefined): unknown {
  if (!type) return null;
  if (type.container === 'array') return [];
  if (type.container === 'set') return new Set();
  if (type.container === 'map') return new Map();
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

// A type's default as stored in a graph file (JSON): containers are empty arrays.
export function storedDefault(type: TypeRef | undefined): unknown {
  return type?.container ? [] : defaultValue(type);
}

// A stored value (a variable's default, a value typed on a pin) as a value of `type`: containers
// are stored as JSON arrays, maps as [key, value] pairs.
export function fromStored(value: unknown, type: TypeRef | undefined): unknown {
  if (!type?.container || !Array.isArray(value)) return value;
  if (type.container === 'set') return new Set(value);
  if (type.container === 'map') return new Map(value.filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length === 2));
  return [...value];
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
