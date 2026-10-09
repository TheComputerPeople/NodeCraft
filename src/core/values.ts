// Value rules shared by Simulate and, as a reference, by every language pack's generated helpers.
// See docs/semantics.md ("Values").
import { TypeRef } from './types';

export function defaultValue(type: TypeRef | undefined): unknown {
  if (!type) return null;
  if (type.container === 'array') return [];
  if (type.container === 'set') return [];
  if (type.container === 'map') return {};
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

// Text form of a value, as Print shows it. Numbers use JavaScript's shortest round-trip form, so
// other languages' helpers reproduce that algorithm.
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
