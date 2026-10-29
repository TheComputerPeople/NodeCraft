// A language's terms (docs/language-context.md, part 2): its words for the containers, in node names
// and categories, and how it writes types, so the editor shows a graph in its language's terms.
// Saved graphs don't change: node types, pin ids and type ids are the same in every language.
import { NodeDefinition } from './model';
import { TypeRef, parseTypeId } from './types';

// How a language writes types: each basic type, and templates for containers ({T} the element, {K}
// and {V} a map's key and value) and for a type that may be empty.
export interface TypeSpelling {
  bool: string;
  int: string;
  float: string;
  string: string;
  any: string;
  array: string;
  set: string;
  map: string;
  nullable?: string;
  // A basic type as written inside a container, where it differs (Java's boxed Long).
  elements?: Partial<Record<BasicType, string>>;
}

export interface LanguageTerms {
  // The containers' names, in node names ("Make List") and categories ("Utilities / List").
  array: string;
  set: string;
  map: string;
  types: TypeSpelling;
}

type BasicType = 'bool' | 'int' | 'float' | 'string';
const BASIC = new Set(['bool', 'int', 'float', 'string']);

// The editor's own spelling, Unreal's words: "array<float>", "map<string, int>", "int?".
export const DEFAULT_SPELLING: TypeSpelling = { bool: 'bool', int: 'int', float: 'float', string: 'string', any: 'any', array: 'array<{T}>', set: 'set<{T}>', map: 'map<{K}, {V}>', nullable: '{T}?' };
export const DEFAULT_TERMS: LanguageTerms = { array: 'Array', set: 'Set', map: 'Map', types: DEFAULT_SPELLING };

// A type as the language writes it.
export function typeText(type: TypeRef | undefined, spelling: TypeSpelling = DEFAULT_SPELLING): string {
  if (!type) return spelling.any;
  const element = (id: string) => (BASIC.has(id) ? spelling.elements?.[id as BasicType] ?? spelling[id as BasicType] : name(id, spelling));
  const base = type.container === 'map'
    ? spelling.map.replace('{K}', element(type.id)).replace('{V}', type.valueType ? (type.valueType.container ? typeText(type.valueType, spelling) : element(type.valueType.id)) : spelling.any)
    : type.container
      ? spelling[type.container].replace('{T}', element(type.id))
      : name(type.id, spelling);
  return type.nullable && spelling.nullable ? spelling.nullable.replace('{T}', base) : base;
}

function name(id: string, spelling: TypeSpelling): string {
  if (BASIC.has(id)) return spelling[id as BasicType];
  if (id === 'any') return spelling.any;
  return parseTypeId(id).name;
}

// Node names that name a container, as templates; a category's "Array", "Set" and "Map" are too.
// "Set Variable" and "Map Range" aren't here: there, Set and Map are verbs.
export const NAME_TEMPLATES: Record<string, string> = {
  'core:array.make': 'Make {Array}',
  'core:set.make': 'Make {Set}',
  'core:map.make': 'Make {Map}',
  'core:array.set': 'Set {Array} Elem',
  'core:set.to-array': 'To {Array}',
  'core:string.parse-into-array': 'Parse Into {Array}',
  'core:string.join': 'Join String {Array}',
  'core:array.append': 'Append {Array}',
  'core:array.min': 'Min Of Float {Array}',
  'core:array.max': 'Max Of Float {Array}',
  'core:map.from-arrays': 'Make {Map} From {Array}s'
};

function fill(template: string, terms: LanguageTerms): string {
  return template.replace(/\{(Array|Set|Map)\}/g, (_m, word: string) => terms[word.toLowerCase() as 'array' | 'set' | 'map']);
}

// A built-in node's definition in the language's terms. Its Unreal name stays a keyword, so a
// search for it still finds the node.
export function localizeDefinition(definition: NodeDefinition, terms: LanguageTerms): NodeDefinition {
  if (!definition.type.startsWith('core:')) return definition;
  const template = NAME_TEMPLATES[definition.type];
  const displayName = template ? fill(template, terms) : definition.displayName;
  const category = definition.category.split(' / ').map((part) => (part === 'Array' || part === 'Set' || part === 'Map' ? fill(`{${part}}`, terms) : part)).join(' / ');
  if (displayName === definition.displayName && category === definition.category) return definition;
  const keywords = displayName === definition.displayName ? definition.keywords : [...(definition.keywords ?? []), definition.displayName];
  return { ...definition, displayName, category, ...(keywords ? { keywords } : {}) };
}

// The built-in languages' terms.
export const LANGUAGE_TERMS: Record<string, LanguageTerms> = {
  typescript: {
    array: 'Array', set: 'Set', map: 'Map',
    types: { bool: 'boolean', int: 'integer', float: 'number', string: 'string', any: 'unknown', array: '{T}[]', set: 'Set<{T}>', map: 'Map<{K}, {V}>', nullable: '{T} | null' }
  },
  javascript: {
    array: 'Array', set: 'Set', map: 'Map',
    types: { bool: 'boolean', int: 'integer', float: 'number', string: 'string', any: 'any', array: '{T}[]', set: 'Set<{T}>', map: 'Map<{K}, {V}>', nullable: '{T} | null' }
  },
  python: {
    array: 'List', set: 'Set', map: 'Dict',
    types: { bool: 'bool', int: 'int', float: 'float', string: 'str', any: 'Any', array: 'list[{T}]', set: 'set[{T}]', map: 'dict[{K}, {V}]', nullable: '{T} | None' }
  },
  csharp: {
    array: 'List', set: 'HashSet', map: 'Dictionary',
    types: { bool: 'bool', int: 'int', float: 'double', string: 'string', any: 'object', array: 'List<{T}>', set: 'HashSet<{T}>', map: 'Dictionary<{K}, {V}>', nullable: '{T}?' }
  },
  cpp: {
    array: 'Vector', set: 'Set', map: 'Map',
    types: { bool: 'bool', int: 'long long', float: 'double', string: 'std::string', any: 'std::any', array: 'std::vector<{T}>', set: 'std::set<{T}>', map: 'vgraph::Map<{K}, {V}>' }
  },
  rust: {
    array: 'Vec', set: 'Set', map: 'Map',
    types: { bool: 'bool', int: 'i64', float: 'f64', string: 'String', any: 'vgraph::Value', array: 'Vec<{T}>', set: 'vgraph::Set<{T}>', map: 'vgraph::Map<{K}, {V}>' }
  },
  java: {
    array: 'List', set: 'Set', map: 'Map',
    types: {
      bool: 'boolean', int: 'long', float: 'double', string: 'String', any: 'Object', array: 'ArrayList<{T}>', set: 'LinkedHashSet<{T}>', map: 'LinkedHashMap<{K}, {V}>',
      elements: { bool: 'Boolean', int: 'Long', float: 'Double' }
    }
  },
  go: {
    array: 'Slice', set: 'Set', map: 'Map',
    types: { bool: 'bool', int: 'int', float: 'float64', string: 'string', any: 'any', array: '[]{T}', set: 'VgSet[{T}]', map: 'VgMap[{K}, {V}]' }
  },
  lua: {
    array: 'List', set: 'Set', map: 'Table',
    types: { bool: 'boolean', int: 'integer', float: 'number', string: 'string', any: 'any', array: '{T}[]', set: 'table<{T}, true>', map: 'table<{K}, {V}>' }
  },
  gdscript: {
    array: 'Array', set: 'Set', map: 'Dictionary',
    types: { bool: 'bool', int: 'int', float: 'float', string: 'String', any: 'Variant', array: 'Array[{T}]', set: 'VgSet', map: 'Dictionary[{K}, {V}]' }
  },
  ruby: {
    array: 'Array', set: 'Set', map: 'Hash',
    types: { bool: 'Boolean', int: 'Integer', float: 'Float', string: 'String', any: 'Object', array: 'Array<{T}>', set: 'Set<{T}>', map: 'Hash{{K} => {V}}' }
  },
  php: {
    array: 'List', set: 'Set', map: 'Map',
    types: { bool: 'bool', int: 'int', float: 'float', string: 'string', any: 'mixed', array: 'VgList<{T}>', set: 'VgSet<{T}>', map: 'VgMap<{K}, {V}>', nullable: '?{T}' }
  }
};
