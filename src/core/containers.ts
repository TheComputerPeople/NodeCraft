// Arrays, sets and maps (docs/program-structure.md, "Containers"): Make Array/Set/Map, For Each
// Loop, and Unreal's array, set and map functions. Their pins are wildcards: a node takes the
// element type of the first wire connected to it, as in Unreal (src/core/resolve.ts).
import { GraphNode, NodeDefinition, PinDefinition, TypeRef } from './model';

export const MAKE_ARRAY = 'core:array.make';
export const MAKE_SET = 'core:set.make';
export const MAKE_MAP = 'core:map.make';
export const FOR_EACH_LOOP = 'core:flow.for-each-loop';
export const FOR_EACH_LOOP_WITH_BREAK = 'core:flow.for-each-loop-with-break';

// Wildcard type ids: a node's element (or map key) type, and a map's value type.
export const WILDCARD = 'wildcard';
export const WILDCARD_VALUE = 'wildcard:value';

const T: TypeRef = { id: WILDCARD };
const V: TypeRef = { id: WILDCARD_VALUE };
const ARRAY: TypeRef = { id: WILDCARD, container: 'array' };
const SET: TypeRef = { id: WILDCARD, container: 'set' };
const MAP: TypeRef = { id: WILDCARD, container: 'map', valueType: V };
const INT: TypeRef = { id: 'int' };
const BOOL: TypeRef = { id: 'bool' };

const pin = (id: string, name: string, direction: PinDefinition['direction'], type: TypeRef, defaultValue?: unknown): PinDefinition => ({
  id, name, kind: 'data', direction, type, ...(defaultValue !== undefined ? { defaultValue } : {})
});
const execIn: PinDefinition = { id: 'execIn', name: '', kind: 'exec', direction: 'input' };
const execOut: PinDefinition = { id: 'execOut', name: '', kind: 'exec', direction: 'output' };

interface Snippets {
  javascript: string;
  // When TypeScript needs different code from JavaScript (e.g. a type assertion).
  typescript?: string;
  python: string;
  csharp: string;
}

// The C++ snippets, by node type (docs/language-breadth.md, "C++"). The container is passed by
// reference, so changes reach the variable it came from, as in the other languages.
const CPP_SIZE = 'static_cast<long long>(target.size())';
const CPP_RANGE = `if (index < 0 || index >= ${CPP_SIZE}) throw std::out_of_range("Index out of range");`;
const CPP_FIND = 'auto found = std::find(target.begin(), target.end(), item);';
const CPP: Record<string, string> = {
  'core:array.add': `target.push_back(item);\nreturn ${CPP_SIZE} - 1;`,
  'core:array.add-unique': `if (std::find(target.begin(), target.end(), item) != target.end()) return -1;\ntarget.push_back(item);\nreturn ${CPP_SIZE} - 1;`,
  'core:array.insert': `if (index < 0 || index > ${CPP_SIZE}) throw std::out_of_range("Index out of range");\ntarget.insert(target.begin() + index, item);`,
  'core:array.remove-index': `${CPP_RANGE}\ntarget.erase(target.begin() + index);`,
  'core:array.remove-item': 'auto before = target.size();\nstd::erase(target, item);\nreturn target.size() != before;',
  'core:array.set': `${CPP_RANGE}\ntarget[index] = item;`,
  'core:array.clear': 'target.clear();',
  'core:array.get': `${CPP_RANGE}\nreturn target[index];`,
  'core:array.length': `return ${CPP_SIZE};`,
  'core:array.last-index': `return ${CPP_SIZE} - 1;`,
  'core:array.find': `${CPP_FIND}\nreturn found == target.end() ? -1 : static_cast<long long>(found - target.begin());`,
  'core:array.contains': `${CPP_FIND}\nreturn found != target.end();`,
  'core:array.is-valid-index': `return index >= 0 && index < ${CPP_SIZE};`,
  'core:array.is-empty': 'return target.empty();',
  'core:set.add': 'target.insert(item);',
  'core:set.remove': 'return target.erase(item) > 0;',
  'core:set.clear': 'target.clear();',
  'core:set.contains': 'return target.count(item) > 0;',
  'core:set.length': `return ${CPP_SIZE};`,
  // A std::set is already in ascending order.
  'core:set.to-array': 'return std::vector(target.begin(), target.end());',
  'core:map.add': 'target[key] = value;',
  'core:map.remove': 'return target.erase(key);',
  'core:map.clear': 'target.clear();',
  'core:map.find': 'if (!target.contains(key)) throw std::out_of_range("Key not found");\nreturn target.at(key);',
  'core:map.contains': 'return target.contains(key);',
  'core:map.length': `return ${CPP_SIZE};`,
  'core:map.keys': 'std::vector<typename std::decay_t<decltype(target)>::key_type> keys;\nfor (const auto& entry : target) keys.push_back(entry.first);\nreturn keys;',
  'core:map.values': 'std::vector<typename std::decay_t<decltype(target)>::mapped_type> values;\nfor (const auto& entry : target) values.push_back(entry.second);\nreturn values;'
};

// The Rust snippets, by node type: the container comes by mutable reference.
const RUST_RANGE = 'if index < 0 || index >= target.len() as i64 { panic!("Index out of range"); }';
const RUST: Record<string, string> = {
  'core:array.add': 'target.push(item);\nreturn target.len() as i64 - 1;',
  'core:array.add-unique': 'if target.contains(&item) { return -1; }\ntarget.push(item);\nreturn target.len() as i64 - 1;',
  'core:array.insert': 'if index < 0 || index > target.len() as i64 { panic!("Index out of range"); }\ntarget.insert(index as usize, item);',
  'core:array.remove-index': `${RUST_RANGE}\ntarget.remove(index as usize);`,
  'core:array.remove-item': 'let before = target.len();\ntarget.retain(|x| x != &item);\nreturn target.len() != before;',
  'core:array.set': `${RUST_RANGE}\ntarget[index as usize] = item;`,
  'core:array.clear': 'target.clear();',
  'core:array.get': `${RUST_RANGE}\nreturn target[index as usize].clone();`,
  'core:array.length': 'return target.len() as i64;',
  'core:array.last-index': 'return target.len() as i64 - 1;',
  'core:array.find': 'return target.iter().position(|x| x == &item).map(|i| i as i64).unwrap_or(-1);',
  'core:array.contains': 'return target.contains(&item);',
  'core:array.is-valid-index': 'return index >= 0 && index < target.len() as i64;',
  'core:array.is-empty': 'return target.is_empty();',
  'core:set.add': 'target.insert(item);',
  'core:set.remove': 'return target.remove(&item);',
  'core:set.clear': 'target.clear();',
  'core:set.contains': 'return target.contains(&item);',
  'core:set.length': 'return target.len() as i64;',
  'core:set.to-array': 'return target.sorted();',
  'core:map.add': 'target.insert(key, value);',
  'core:map.remove': 'return target.remove(&key);',
  'core:map.clear': 'target.clear();',
  'core:map.find': 'return target.get(&key).unwrap_or_else(|| panic!("Key not found"));',
  'core:map.contains': 'return target.contains(&key);',
  'core:map.length': 'return target.len() as i64;',
  'core:map.keys': 'return target.keys();',
  'core:map.values': 'return target.values();'
};

// The Java snippets: indexes are longs, Java's lists take ints.
const JAVA_RANGE = 'if (index < 0 || index >= target.size()) throw new IndexOutOfBoundsException("Index out of range");';
const JAVA: Record<string, string> = {
  'core:array.add': 'target.add(item);\nreturn target.size() - 1;',
  'core:array.add-unique': 'if (target.contains(item)) return -1;\ntarget.add(item);\nreturn target.size() - 1;',
  'core:array.insert': 'if (index < 0 || index > target.size()) throw new IndexOutOfBoundsException("Index out of range");\ntarget.add((int) index, item);',
  'core:array.remove-index': `${JAVA_RANGE}\ntarget.remove((int) index);`,
  'core:array.remove-item': 'return target.removeIf(x -> java.util.Objects.equals(x, item));',
  'core:array.set': `${JAVA_RANGE}\ntarget.set((int) index, item);`,
  'core:array.clear': 'target.clear();',
  'core:array.get': `${JAVA_RANGE}\nreturn target.get((int) index);`,
  'core:array.length': 'return target.size();',
  'core:array.last-index': 'return target.size() - 1;',
  'core:array.find': 'return target.indexOf(item);',
  'core:array.contains': 'return target.contains(item);',
  'core:array.is-valid-index': 'return index >= 0 && index < target.size();',
  'core:array.is-empty': 'return target.isEmpty();',
  'core:set.add': 'target.add(item);',
  'core:set.remove': 'return target.remove(item);',
  'core:set.clear': 'target.clear();',
  'core:set.contains': 'return target.contains(item);',
  'core:set.length': 'return target.size();',
  'core:set.to-array': 'var result = new java.util.ArrayList<>(target);\nresult.sort(null);\nreturn result;',
  'core:map.add': 'target.put(key, value);',
  'core:map.remove': 'return target.remove(key) != null;',
  'core:map.clear': 'target.clear();',
  'core:map.find': 'if (!target.containsKey(key)) throw new java.util.NoSuchElementException("Key not found");\nreturn target.get(key);',
  'core:map.contains': 'return target.containsKey(key);',
  'core:map.length': 'return target.size();',
  'core:map.keys': 'return new java.util.ArrayList<>(target.keySet());',
  'core:map.values': 'return new java.util.ArrayList<>(target.values());'
};

// The Go snippets: arrays are pointers to slices, sets and maps the runtime's ordered types, so a
// node changes the container it was given.
const GO_RANGE = 'if index < 0 || index >= len(*target) {\n\tVgFail("Index out of range")\n}';
const GO: Record<string, string> = {
  'core:array.add': '*target = append(*target, item)\nreturn len(*target) - 1',
  'core:array.add-unique': 'if slices.Contains(*target, item) {\n\treturn -1\n}\n*target = append(*target, item)\nreturn len(*target) - 1',
  'core:array.insert': 'if index < 0 || index > len(*target) {\n\tVgFail("Index out of range")\n}\n*target = slices.Insert(*target, index, item)',
  'core:array.remove-index': `${GO_RANGE}\n*target = slices.Delete(*target, index, index+1)`,
  'core:array.remove-item': 'kept := (*target)[:0]\nfor _, x := range *target {\n\tif x != item {\n\t\tkept = append(kept, x)\n\t}\n}\nremoved := len(kept) != len(*target)\n*target = kept\nreturn removed',
  'core:array.set': `${GO_RANGE}\n(*target)[index] = item`,
  'core:array.clear': '*target = (*target)[:0]',
  'core:array.get': `${GO_RANGE}\nreturn (*target)[index]`,
  'core:array.length': 'return len(*target)',
  'core:array.last-index': 'return len(*target) - 1',
  'core:array.find': 'return slices.Index(*target, item)',
  'core:array.contains': 'return slices.Contains(*target, item)',
  'core:array.is-valid-index': 'return index >= 0 && index < len(*target)',
  'core:array.is-empty': 'return len(*target) == 0',
  'core:set.add': 'target.Add(item)',
  'core:set.remove': 'return target.Remove(item)',
  'core:set.clear': 'target.Clear()',
  'core:set.contains': 'return target.Contains(item)',
  'core:set.length': 'return target.Len()',
  'core:set.to-array': 'return target.Sorted()',
  'core:map.add': 'target.Put(key, value)',
  'core:map.remove': 'return target.Remove(key)',
  'core:map.clear': 'target.Clear()',
  'core:map.find': 'value, ok := target.Get(key)\nif !ok {\n\tVgFail("Key not found")\n}\nreturn value',
  'core:map.contains': '_, ok := target.Get(key)\nreturn ok',
  'core:map.length': 'return target.Len()',
  'core:map.keys': 'return target.Keys()',
  'core:map.values': 'return target.Values()'
};

// An Unreal container function as a code node: impure ones have exec pins.
function fn(type: string, displayName: string, category: string, inputs: PinDefinition[], result: TypeRef | undefined, code: Snippets, description: string, options: { impure?: boolean; keywords?: string[] } = {}): NodeDefinition {
  return {
    type, version: 1, displayName, category, description,
    inputs: [...(options.impure ? [execIn] : []), ...inputs],
    outputs: [...(options.impure ? [execOut] : []), ...(result ? [pin('returnValue', 'Return Value', 'output', result)] : [])],
    implementation: { kind: 'code', languages: { ...code, ...(CPP[type] ? { cpp: CPP[type] } : {}), ...(RUST[type] ? { rust: RUST[type] } : {}), ...(JAVA[type] ? { java: JAVA[type] } : {}), ...(GO[type] ? { go: GO[type] } : {}) } },
    ...(options.keywords ? { keywords: options.keywords } : {})
  };
}

const target = (type: TypeRef, name = 'Target Array') => pin('target', name, 'input', type);
const RANGE = {
  javascript: 'if (index < 0 || index >= target.length) throw new Error("Index out of range");',
  python: 'if index < 0 or index >= len(target):\n    raise IndexError("Index out of range")',
  csharp: 'if (index < 0 || index >= target.Count) throw new ArgumentOutOfRangeException(nameof(index), "Index out of range");'
};
const with_range = (code: Snippets): Snippets => ({ javascript: `${RANGE.javascript}\n${code.javascript}`, python: `${RANGE.python}\n${code.python}`, csharp: `${RANGE.csharp}\n${code.csharp}` });

export function containerDefinitions(): NodeDefinition[] {
  const index = pin('index', 'Index', 'input', INT, 0);
  const item = pin('item', 'Item', 'input', T);
  return [
    // ---- Make ---------------------------------------------------------------------------------------
    {
      type: MAKE_ARRAY, version: 1, displayName: 'Make Array', category: 'Utilities / Array', description: 'An array of the items, in order. A new array each time it is read.',
      inputs: [pin('item0', '[0]', 'input', T)], outputs: [pin('array', 'Array', 'output', ARRAY)], implementation: { kind: 'native', operation: 'make-array' }, keywords: ['array', 'list', 'make', 'create']
    },
    {
      type: MAKE_SET, version: 1, displayName: 'Make Set', category: 'Utilities / Set', description: 'A set of the items. A new set each time it is read.',
      inputs: [pin('item0', '[0]', 'input', T)], outputs: [pin('set', 'Set', 'output', SET)], implementation: { kind: 'native', operation: 'make-set' }, keywords: ['set', 'make', 'create']
    },
    {
      type: MAKE_MAP, version: 1, displayName: 'Make Map', category: 'Utilities / Map', description: 'A map of the keys to their values. A new map each time it is read.',
      inputs: [pin('key0', 'Key 0', 'input', T), pin('value0', 'Value 0', 'input', V)], outputs: [pin('map', 'Map', 'output', MAP)], implementation: { kind: 'native', operation: 'make-map' }, keywords: ['map', 'dictionary', 'make', 'create']
    },

    // ---- For Each ----------------------------------------------------------------------------------
    {
      type: FOR_EACH_LOOP, version: 1, displayName: 'For Each Loop', category: 'Flow', color: '#e6b450', description: 'Runs Loop Body for each element of the array, then Completed.',
      inputs: [execIn, pin('array', 'Array', 'input', ARRAY)],
      outputs: [{ id: 'loopBody', name: 'Loop Body', kind: 'exec', direction: 'output' }, pin('element', 'Array Element', 'output', T), pin('index', 'Array Index', 'output', INT), { id: 'completed', name: 'Completed', kind: 'exec', direction: 'output' }],
      implementation: { kind: 'native', operation: 'for-each' }, keywords: ['loop', 'foreach', 'each', 'iterate']
    },
    {
      type: FOR_EACH_LOOP_WITH_BREAK, version: 1, displayName: 'For Each Loop with Break', category: 'Flow', color: '#e6b450', description: 'Like For Each Loop; running Break stops the loop after the current Loop Body.',
      inputs: [execIn, pin('array', 'Array', 'input', ARRAY), { id: 'break', name: 'Break', kind: 'exec', direction: 'input' }],
      outputs: [{ id: 'loopBody', name: 'Loop Body', kind: 'exec', direction: 'output' }, pin('element', 'Array Element', 'output', T), pin('index', 'Array Index', 'output', INT), { id: 'completed', name: 'Completed', kind: 'exec', direction: 'output' }],
      implementation: { kind: 'native', operation: 'for-each' }, keywords: ['loop', 'foreach', 'each', 'break']
    },

    // ---- Array -----------------------------------------------------------------------------------
    fn('core:array.add', 'Add', 'Utilities / Array', [target(ARRAY), item], INT,
      { javascript: 'target.push(item);\nreturn target.length - 1;', python: 'target.append(item)\nreturn len(target) - 1', csharp: 'target.Add(item);\nreturn target.Count - 1;' },
      'Adds the item to the end of the array; returns its index.', { impure: true, keywords: ['append', 'push'] }),
    fn('core:array.add-unique', 'Add Unique', 'Utilities / Array', [target(ARRAY), item], INT, {
      javascript: 'if (target.includes(item)) return -1;\ntarget.push(item);\nreturn target.length - 1;',
      python: 'if item in target:\n    return -1\ntarget.append(item)\nreturn len(target) - 1',
      csharp: 'if (target.Contains(item)) return -1;\ntarget.Add(item);\nreturn target.Count - 1;'
    }, 'Adds the item if the array doesn\'t have it yet; returns its index, or -1 if it was there.', { impure: true }),
    fn('core:array.insert', 'Insert', 'Utilities / Array', [target(ARRAY), item, index], undefined, {
      javascript: 'if (index < 0 || index > target.length) throw new Error("Index out of range");\ntarget.splice(index, 0, item);',
      python: 'if index < 0 or index > len(target):\n    raise IndexError("Index out of range")\ntarget.insert(index, item)',
      csharp: 'if (index < 0 || index > target.Count) throw new ArgumentOutOfRangeException(nameof(index), "Index out of range");\ntarget.Insert(index, item);'
    }, 'Inserts the item at the index, moving later items up. An index beyond the end stops the run.', { impure: true }),
    fn('core:array.remove-index', 'Remove Index', 'Utilities / Array', [target(ARRAY), index], undefined,
      with_range({ javascript: 'target.splice(index, 1);', python: 'del target[index]', csharp: 'target.RemoveAt(index);' }),
      'Removes the item at the index. An index out of range stops the run.', { impure: true, keywords: ['delete'] }),
    fn('core:array.remove-item', 'Remove Item', 'Utilities / Array', [target(ARRAY), item], BOOL, {
      javascript: 'let removed = false;\nfor (let i = target.length - 1; i >= 0; i--) {\n  if (target[i] === item) {\n    target.splice(i, 1);\n    removed = true;\n  }\n}\nreturn removed;',
      python: 'count = len(target)\ntarget[:] = [x for x in target if x != item]\nreturn len(target) != count',
      csharp: 'return target.RemoveAll(x => object.Equals(x, item)) > 0;'
    }, 'Removes every copy of the item; true if any was removed.', { impure: true, keywords: ['delete'] }),
    fn('core:array.set', 'Set Array Elem', 'Utilities / Array', [target(ARRAY), index, item], undefined,
      with_range({ javascript: 'target[index] = item;', python: 'target[index] = item', csharp: 'target[index] = item;' }),
      'Replaces the item at the index. An index out of range stops the run.', { impure: true, keywords: ['set', 'replace'] }),
    fn('core:array.clear', 'Clear', 'Utilities / Array', [target(ARRAY)], undefined,
      { javascript: 'target.length = 0;', python: 'target.clear()', csharp: 'target.Clear();' }, 'Removes every item.', { impure: true, keywords: ['empty', 'reset'] }),
    fn('core:array.get', 'Get', 'Utilities / Array', [target(ARRAY), index], T,
      with_range({ javascript: 'return target[index];', python: 'return target[index]', csharp: 'return target[index];' }),
      'The item at the index. An index out of range stops the run.', { keywords: ['item', 'element', 'at'] }),
    fn('core:array.length', 'Length', 'Utilities / Array', [target(ARRAY)], INT,
      { javascript: 'return target.length;', python: 'return len(target)', csharp: 'return target.Count;' }, 'The number of items.', { keywords: ['count', 'size'] }),
    fn('core:array.last-index', 'Last Index', 'Utilities / Array', [target(ARRAY)], INT,
      { javascript: 'return target.length - 1;', python: 'return len(target) - 1', csharp: 'return target.Count - 1;' }, 'The index of the last item (-1 when empty).'),
    fn('core:array.find', 'Find', 'Utilities / Array', [target(ARRAY), pin('item', 'Item to Find', 'input', T)], INT,
      { javascript: 'return target.indexOf(item);', python: 'return target.index(item) if item in target else -1', csharp: 'return target.IndexOf(item);' },
      'The index of the first copy of the item, or -1.', { keywords: ['index of', 'search'] }),
    fn('core:array.contains', 'Contains', 'Utilities / Array', [target(ARRAY), pin('item', 'Item to Find', 'input', T)], BOOL,
      { javascript: 'return target.includes(item);', python: 'return item in target', csharp: 'return target.Contains(item);' }, 'True if the array has the item.', { keywords: ['has', 'includes'] }),
    fn('core:array.is-valid-index', 'Is Valid Index', 'Utilities / Array', [target(ARRAY), pin('index', 'Index to Test', 'input', INT, 0)], BOOL,
      { javascript: 'return index >= 0 && index < target.length;', python: 'return 0 <= index < len(target)', csharp: 'return index >= 0 && index < target.Count;' }, 'True if the index is in range.'),
    fn('core:array.is-empty', 'Is Empty', 'Utilities / Array', [target(ARRAY)], BOOL,
      { javascript: 'return target.length === 0;', python: 'return len(target) == 0', csharp: 'return target.Count == 0;' }, 'True if the array has no items.'),

    // ---- Set ---------------------------------------------------------------------------------------
    fn('core:set.add', 'Add', 'Utilities / Set', [target(SET, 'Target Set'), pin('item', 'New Item', 'input', T)], undefined,
      { javascript: 'target.add(item);', python: 'target.add(item)', csharp: 'target.Add(item);' }, 'Adds the item (nothing happens if it is already there).', { impure: true }),
    fn('core:set.remove', 'Remove', 'Utilities / Set', [target(SET, 'Target Set'), item], BOOL, {
      javascript: 'return target.delete(item);',
      python: 'if item in target:\n    target.remove(item)\n    return True\nreturn False',
      csharp: 'return target.Remove(item);'
    }, 'Removes the item; true if it was there.', { impure: true, keywords: ['delete'] }),
    fn('core:set.clear', 'Clear', 'Utilities / Set', [target(SET, 'Target Set')], undefined,
      { javascript: 'target.clear();', python: 'target.clear()', csharp: 'target.Clear();' }, 'Removes every item.', { impure: true }),
    fn('core:set.contains', 'Contains', 'Utilities / Set', [target(SET, 'Target Set'), pin('item', 'Item to Find', 'input', T)], BOOL,
      { javascript: 'return target.has(item);', python: 'return item in target', csharp: 'return target.Contains(item);' }, 'True if the set has the item.'),
    fn('core:set.length', 'Length', 'Utilities / Set', [target(SET, 'Target Set')], INT,
      { javascript: 'return target.size;', python: 'return len(target)', csharp: 'return target.Count;' }, 'The number of items.', { keywords: ['count', 'size'] }),
    // Sets have no order of their own; To Array sorts, so every language gives the same array.
    fn('core:set.to-array', 'To Array', 'Utilities / Set', [target(SET, 'A')], ARRAY, {
      javascript: 'return [...target].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));',
      python: 'return sorted(target)',
      csharp: 'var result = target.ToList();\nresult.Sort();\nreturn result;'
    }, 'The items as an array, in ascending order.'),

    // ---- Map ---------------------------------------------------------------------------------------
    fn('core:map.add', 'Add', 'Utilities / Map', [target(MAP, 'Target Map'), pin('key', 'Key', 'input', T), pin('value', 'Value', 'input', V)], undefined,
      { javascript: 'target.set(key, value);', python: 'target[key] = value', csharp: 'target[key] = value;' }, 'Sets the value for the key, replacing any value it had.', { impure: true, keywords: ['set', 'put'] }),
    fn('core:map.remove', 'Remove', 'Utilities / Map', [target(MAP, 'Target Map'), pin('key', 'Key', 'input', T)], BOOL, {
      javascript: 'return target.delete(key);',
      python: 'if key in target:\n    del target[key]\n    return True\nreturn False',
      csharp: 'return target.Remove(key);'
    }, 'Removes the key and its value; true if it was there.', { impure: true, keywords: ['delete'] }),
    fn('core:map.clear', 'Clear', 'Utilities / Map', [target(MAP, 'Target Map')], undefined,
      { javascript: 'target.clear();', python: 'target.clear()', csharp: 'target.Clear();' }, 'Removes every key.', { impure: true }),
    // Unreal's Find also returns a success flag; until nodes have several outputs, a missing key
    // stops the run (check with Contains first).
    fn('core:map.find', 'Find', 'Utilities / Map', [target(MAP, 'Target Map'), pin('key', 'Key', 'input', T)], V, {
      javascript: 'if (!target.has(key)) throw new Error("Key not found");\nreturn /** @type {any} */ (target.get(key));',
      typescript: 'if (!target.has(key)) throw new Error("Key not found");\nreturn target.get(key)!;',
      python: 'if key not in target:\n    raise KeyError("Key not found")\nreturn target[key]',
      csharp: 'if (!target.ContainsKey(key)) throw new KeyNotFoundException("Key not found");\nreturn target[key];'
    }, 'The value for the key. A missing key stops the run; check with Contains first.', { keywords: ['get', 'lookup', 'value'] }),
    fn('core:map.contains', 'Contains', 'Utilities / Map', [target(MAP, 'Target Map'), pin('key', 'Key', 'input', T)], BOOL,
      { javascript: 'return target.has(key);', python: 'return key in target', csharp: 'return target.ContainsKey(key);' }, 'True if the map has the key.', { keywords: ['has key'] }),
    fn('core:map.length', 'Length', 'Utilities / Map', [target(MAP, 'Target Map')], INT,
      { javascript: 'return target.size;', python: 'return len(target)', csharp: 'return target.Count;' }, 'The number of keys.', { keywords: ['count', 'size'] }),
    fn('core:map.keys', 'Keys', 'Utilities / Map', [target(MAP, 'Target Map')], ARRAY,
      { javascript: 'return [...target.keys()];', python: 'return list(target.keys())', csharp: 'return target.Keys.ToList();' }, 'The keys, in the order they were added.'),
    fn('core:map.values', 'Values', 'Utilities / Map', [target(MAP, 'Target Map')], { id: WILDCARD_VALUE, container: 'array' },
      { javascript: 'return [...target.values()];', python: 'return list(target.values())', csharp: 'return target.Values.ToList();' }, 'The values, in the order their keys were added.')
  ];
}

// ---- Make nodes' inputs, added on the node ------------------------------------------------------

export function makeItemCount(node: GraphNode): number {
  const pins = Number(node.properties.pins);
  return Number.isInteger(pins) && pins >= 0 ? pins : 1;
}

// Make Array/Set/Map with as many inputs as the node has items ("Add pin +").
export function makeDefinition(base: NodeDefinition, node: GraphNode): NodeDefinition {
  const count = makeItemCount(node);
  if (node.type === MAKE_MAP) {
    const inputs = Array.from({ length: count }, (_, i) => [pin(`key${i}`, `Key ${i}`, 'input', T), pin(`value${i}`, `Value ${i}`, 'input', V)]).flat();
    return { ...base, inputs };
  }
  return { ...base, inputs: Array.from({ length: count }, (_, i) => pin(`item${i}`, `[${i}]`, 'input', T)) };
}

// ---- Wildcards ----------------------------------------------------------------------------------

export function isWildcardId(id: string): boolean {
  return id === WILDCARD || id === WILDCARD_VALUE;
}

export function hasWildcard(type: TypeRef | undefined): boolean {
  return !!type && (isWildcardId(type.id) || (!!type.valueType && isWildcardId(type.valueType.id)));
}

// The element types a node has adopted, by wildcard id (Unreal changes a wildcard pin's type when a
// wire is connected).
export function adoptedTypes(node: GraphNode): Record<string, string> {
  const adopted = node.properties.wildcards;
  return adopted && typeof adopted === 'object' ? (adopted as Record<string, string>) : {};
}

// A pin type with the node's adopted element types in place of its wildcards.
export function substituteWildcards(type: TypeRef, adopted: Record<string, string>): TypeRef {
  const id = adopted[type.id] ?? type.id;
  const valueType = type.valueType && substituteWildcards(type.valueType, adopted);
  return { ...type, id, ...(valueType ? { valueType } : {}) };
}

export function resolveWildcards(def: NodeDefinition, node: GraphNode): NodeDefinition {
  const adopted = adoptedTypes(node);
  if (!Object.keys(adopted).length) return def;
  const map = (pins: PinDefinition[]) => pins.map((p) => (p.type && hasWildcard(p.type) ? { ...p, type: substituteWildcards(p.type, adopted) } : p));
  return { ...def, inputs: map(def.inputs), outputs: map(def.outputs) };
}

// What a wildcard pin learns from the concrete pin type wired to it: element (and value) type ids.
export function inferWildcards(wildcard: TypeRef, concrete: TypeRef | undefined): Record<string, string> {
  if (!concrete || concrete.id === 'any' || isWildcardId(concrete.id)) return {};
  if ((wildcard.container ?? null) !== (concrete.container ?? null)) return {};
  const found: Record<string, string> = {};
  if (isWildcardId(wildcard.id)) found[wildcard.id] = concrete.id;
  if (wildcard.valueType && concrete.valueType) Object.assign(found, inferWildcards(wildcard.valueType, concrete.valueType));
  return found;
}
