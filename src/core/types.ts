// The canonical, language-neutral type system. Every language pack maps these types to its own;
// graphs and node definitions only ever use canonical ids.
//
// Type ids:
//   bool, int, float, string       primitives
//   any                            accepts any value (a dynamic/top type in each language)
//   wildcard                       adopts the type of whatever it is first connected to
//   struct:<Name>, enum:<Name>     user-defined types
//   object:<Class>                 a reference to an instance of a class
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

export type TypeCategory = 'primitive' | 'any' | 'wildcard' | 'struct' | 'enum' | 'object' | 'native' | 'unknown';

const NAMED_CATEGORIES = ['struct', 'enum', 'object', 'native'] as const;

// Type ids written by earlier versions of the extension.
const LEGACY_TYPE_IDS: Record<string, string> = { number: 'float' };

export function parseTypeId(id: string): { category: TypeCategory; name: string } {
  if ((PRIMITIVE_TYPES as readonly string[]).includes(id)) return { category: 'primitive', name: id };
  if (id === 'any' || id === 'wildcard') return { category: id, name: id };
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

function elementsConnect(from: string, to: string): boolean {
  if (from === to || from === 'wildcard' || to === 'wildcard') return true;
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
