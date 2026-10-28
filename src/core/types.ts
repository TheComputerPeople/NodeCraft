// The canonical, language-neutral type system. Every language pack maps these types to its own;
// graphs and node definitions only ever use canonical ids.
//
// Type ids:
//   bool, int, float, string       primitives
//   any                            accepts any value (a dynamic/top type in each language)
//   wildcard, wildcard:value       adopt the type of whatever is first connected to them (a node's
//                                  element or key type, and a map's value type)
//   struct:<Name>, enum:<Name>     user-defined types
//   object:<Class>                 a reference to an instance of a class
//   interface:<Interface>          a reference to an object whose class implements the interface
//   delegate:(<parameter types>)   an event that takes these parameters (a Custom Event's red pin)
//   native:<qualified name>        a type imported from user code with no canonical equivalent;
//                                  checked by name and passed through untouched
//
// Containers follow Unreal's model: the pin type plus a container kind. For a map, `id` is the
// key type and `valueType` the value type.

export type ContainerKind = 'array' | 'set' | 'map';

export interface TypeRef {
  id: string;
  container?: ContainerKind;
  valueType?: TypeRef;
  nullable?: boolean;
}

export const PRIMITIVE_TYPES = ['bool', 'int', 'float', 'string'] as const;
export type PrimitiveTypeId = (typeof PRIMITIVE_TYPES)[number];

export type TypeCategory = 'primitive' | 'any' | 'wildcard' | 'struct' | 'enum' | 'object' | 'interface' | 'native' | 'delegate' | 'unknown';

const NAMED_CATEGORIES = ['struct', 'enum', 'object', 'interface', 'native', 'delegate'] as const;

// Type ids written by earlier versions of the extension.
const LEGACY_TYPE_IDS: Record<string, string> = { number: 'float' };

export function parseTypeId(id: string): { category: TypeCategory; name: string } {
  if ((PRIMITIVE_TYPES as readonly string[]).includes(id)) return { category: 'primitive', name: id };
  if (id === 'any') return { category: 'any', name: id };
  if (id === 'wildcard' || id === 'wildcard:value') return { category: 'wildcard', name: 'wildcard' };
  const separator = id.indexOf(':');
  const prefix = id.slice(0, separator);
  if (separator > 0 && (NAMED_CATEGORIES as readonly string[]).includes(prefix)) {
    return { category: prefix as TypeCategory, name: id.slice(separator + 1) };
  }
  return { category: 'unknown', name: id };
}

// Rewrites legacy ids (recursively, through map value types) to their canonical form.
export function normalizeTypeRef(type: TypeRef): TypeRef {
  const id = LEGACY_TYPE_IDS[type.id] ?? type.id;
  const valueType = type.valueType && normalizeTypeRef(type.valueType);
  if (id === type.id && valueType === type.valueType) return type;
  return { ...type, id, ...(valueType ? { valueType } : {}) };
}

// A missing type means "any", which is how untyped data pins have always behaved.
export function canConnect(from: TypeRef | undefined, to: TypeRef | undefined): boolean {
  if (!from || !to || from.id === 'any' || to.id === 'any') return true;
  if ((from.container ?? null) !== (to.container ?? null)) return false;
  if (from.container === 'map' && !canConnect(from.valueType, to.valueType)) return false;
  return elementsConnect(from.id, to.id);
}

// The workspace's class hierarchy (src/core/objects.ts): an object of a class connects where its
// parent class is expected, for graph classes and classes in the project's code. Set by whoever
// knows the classes (the compiler, the editor).
let isSubclass: ((from: string, to: string) => boolean) | undefined;

export function setClassHierarchy(test: ((from: string, to: string) => boolean) | undefined): void {
  isSubclass = test;
}

function elementsConnect(from: string, to: string): boolean {
  if (from === to || from.startsWith('wildcard') || to.startsWith('wildcard')) return true;
  if (from.startsWith('object:') && (to.startsWith('object:') || to.startsWith('interface:'))) return !!isSubclass?.(from, to);
  // A class from the project's code: its objects connect where a class it extends is expected.
  if (from.startsWith('native:') && to.startsWith('native:')) return !!isSubclass?.(from, to);
  // Numeric pins connect both ways until Phase 2 adds Unreal-style conversion nodes.
  return (from === 'int' && to === 'float') || (from === 'float' && to === 'int');
}

// A readable label for tooltips and the Details panel, e.g. "array<float>" or "map<string, int>".
export function formatType(type: TypeRef | undefined): string {
  if (!type) return 'any';
  const element = parseTypeId(type.id).name;
  const base = type.container === 'map'
    ? `map<${element}, ${formatType(type.valueType)}>`
    : type.container ? `${type.container}<${element}>` : element;
  return type.nullable ? `${base}?` : base;
}
