// Unreal's set and array functions beyond the container nodes' (docs/code-as-nodes.md, "More of
// Unreal's library"), and map functions for everyday use. They make new containers and leave their
// inputs as they are; sets print, as To Array lists them, in ascending order, so every language
// shows the same set.
import { TypeRef } from './model';
import { ARRAY, FLOAT, FLOATS, INT, INTS, ITEM, MAP, SET, Snippets, UtilityNode, input } from './utility-kit';

// A snippet in each language, after a check in that language.
const after = (first: Snippets, then: Snippets): Snippets => Object.fromEntries(Object.entries(then).map(([language, code]) => [language, `${first[language]}\n${code}`]));

const sets = () => [input('a', 'A', SET), input('b', 'B', SET)];

// A new set of A's items that pass `keep` (an expression of `item` and B), per language.
function filtered(keep: boolean): Snippets {
  const not = keep ? '' : '!';
  return {
    javascript: `return new Set([...a].filter((item) => ${not}b.has(item)));`,
    python: `return a ${keep ? '&' : '-'} b`,
    csharp: `return a.${keep ? 'Intersect' : 'Except'}(b).ToHashSet();`,
    cpp: `std::decay_t<decltype(a)> result;\nfor (const auto& item : a) if (${not}b.count(item)) result.insert(item);\nreturn result;`,
    rust: `let mut result = vgraph::Set::new();\nfor item in a.items.iter() {\n    if ${not}b.contains(item) { result.insert(item.clone()); }\n}\nreturn result;`,
    java: `var result = new java.util.LinkedHashSet<>(a);\nresult.${keep ? 'retainAll' : 'removeAll'}(b);\nreturn result;`,
    go: `result := NewVgSet(a.items[:0:0]...)\nfor _, item := range a.items {\n\tif ${not}b.Contains(item) {\n\t\tresult.Add(item)\n\t}\n}\nreturn result`,
    lua: `local result = vg.set()\nfor item in pairs(a.items) do\n  if ${keep ? '' : 'not '}b:contains(item) then result:add(item) end\nend\nreturn result`,
    gdscript: `var result = vg.set_of([])\nfor item in a.items:\n\tif ${keep ? '' : 'not '}b.contains(item):\n\t\tresult.add(item)\nreturn result`,
    ruby: `return a ${keep ? '&' : '-'} b`,
    php: `$result = new VgSet();\nforeach ($a->items as $item) {\n    if (${not}$b->contains($item)) {\n        $result->add($item);\n    }\n}\nreturn $result;`
  };
}

export const SET_UTILITIES: UtilityNode[] = [
  {
    type: 'core:set.union', displayName: 'Union', category: 'Utilities / Set', result: SET, keywords: ['union', 'combine', 'merge', 'or', 'all'],
    inputs: sets(), description: 'A new set of the items in A, B or both.',
    code: {
      javascript: 'return new Set([...a, ...b]);',
      python: 'return a | b',
      csharp: 'return a.Union(b).ToHashSet();',
      cpp: 'std::decay_t<decltype(a)> result = a;\nresult.insert(b.begin(), b.end());\nreturn result;',
      rust: 'let mut result = a.clone();\nfor item in b.items.iter() { result.insert(item.clone()); }\nreturn result;',
      java: 'var result = new java.util.LinkedHashSet<>(a);\nresult.addAll(b);\nreturn result;',
      go: 'result := NewVgSet(a.items...)\nfor _, item := range b.items {\n\tresult.Add(item)\n}\nreturn result',
      lua: 'local result = vg.set()\nfor item in pairs(a.items) do result:add(item) end\nfor item in pairs(b.items) do result:add(item) end\nreturn result',
      gdscript: 'var result = vg.set_of(a.items.keys())\nfor item in b.items:\n\tresult.add(item)\nreturn result',
      ruby: 'return a | b',
      php: '$result = new VgSet($a->items);\nforeach ($b->items as $item) {\n    $result->add($item);\n}\nreturn $result;'
    }
  },
  {
    type: 'core:set.intersection', displayName: 'Intersection', category: 'Utilities / Set', result: SET, keywords: ['intersect', 'common', 'both', 'and'],
    inputs: sets(), description: 'A new set of the items in both A and B.', code: filtered(true)
  },
  {
    type: 'core:set.difference', displayName: 'Difference', category: 'Utilities / Set', result: SET, keywords: ['difference', 'except', 'minus', 'subtract', 'without'],
    inputs: sets(), description: 'A new set of the items in A that aren\'t in B.', code: filtered(false)
  }
];

// ---- Maps ---------------------------------------------------------------------------------------

const VALUE: TypeRef = { id: 'wildcard:value' };
const VALUES: TypeRef = { id: 'wildcard:value', container: 'array' };

const SAME_LENGTH: Snippets = {
  javascript: "if (keys.length !== values.length) throw new Error('Keys and Values must be the same length');",
  python: 'if len(keys) != len(values):\n    raise ValueError("Keys and Values must be the same length")',
  csharp: 'if (keys.Count != values.Count) throw new ArgumentException("Keys and Values must be the same length");',
  cpp: 'if (keys.size() != values.size()) throw std::invalid_argument("Keys and Values must be the same length");',
  rust: 'if keys.len() != values.len() { panic!("Keys and Values must be the same length"); }',
  java: 'if (keys.size() != values.size()) throw new IllegalArgumentException("Keys and Values must be the same length");',
  go: 'if len(*keys) != len(*values) {\n\tVgFail("Keys and Values must be the same length")\n}',
  lua: 'if keys.n ~= values.n then error("Keys and Values must be the same length", 0) end',
  gdscript: 'if keys.size() != values.size():\n\treturn vg.fail("Keys and Values must be the same length")',
  ruby: 'raise ArgumentError, "Keys and Values must be the same length" unless keys.length == values.length',
  php: "if (count($keys->items) !== count($values->items)) {\n    throw new \\InvalidArgumentException('Keys and Values must be the same length');\n}"
};

export const MAP_UTILITIES: UtilityNode[] = [
  {
    type: 'core:map.merge', displayName: 'Merge', category: 'Utilities / Map', result: MAP, keywords: ['merge', 'combine', 'union', 'assign', 'extend'],
    inputs: [input('a', 'A', MAP), input('b', 'B', MAP)],
    description: 'A new map of A\'s entries and B\'s. Where both have a key, B\'s value wins, at A\'s place in the order; B\'s other keys follow.',
    code: {
      javascript: 'return new Map([...a, ...b]);',
      python: 'return {**a, **b}',
      csharp: 'var result = a.ToDictionary((entry) => entry.Key, (entry) => entry.Value);\nforeach (var entry in b) result[entry.Key] = entry.Value;\nreturn result;',
      cpp: 'std::decay_t<decltype(a)> result = a;\nfor (const auto& entry : b) result[entry.first] = entry.second;\nreturn result;',
      rust: 'let mut result = a.clone();\nfor (key, value) in b.entries.iter() { result.insert(key.clone(), value.clone()); }\nreturn result;',
      java: 'var result = new java.util.LinkedHashMap<>(a);\nresult.putAll(b);\nreturn result;',
      go: 'result := a.Empty()\nfor _, key := range a.keys {\n\tresult.Put(key, a.values[key])\n}\nfor _, key := range b.keys {\n\tresult.Put(key, b.values[key])\n}\nreturn result',
      lua: 'local result = vg.map()\nfor i = 1, a.n do result:put(a.keys[i], a.values[a.keys[i]]) end\nfor i = 1, b.n do result:put(b.keys[i], b.values[b.keys[i]]) end\nreturn result',
      gdscript: 'return a.merged(b, true)',
      ruby: 'return a.merge(b)',
      php: '$result = new VgMap();\nforeach ([$a, $b] as $map) {\n    foreach ($map->keys as $i => $key) {\n        $result->put($key, $map->values[$i]);\n    }\n}\nreturn $result;'
    }
  },
  {
    type: 'core:map.find-or-default', displayName: 'Find or Default', category: 'Utilities / Map', result: VALUE, keywords: ['get', 'lookup', 'default', 'fallback', 'value'],
    inputs: [input('source', 'Target Map', MAP), input('key', 'Key', ITEM), input('fallback', 'Default', VALUE)],
    description: 'The value for the key, or Default if the map doesn\'t have it (where Find would stop the run).',
    code: {
      javascript: 'return source.has(key) ? /** @type {any} */ (source.get(key)) : fallback;',
      typescript: 'return source.has(key) ? source.get(key)! : fallback;',
      python: 'return source[key] if key in source else fallback',
      csharp: 'return source.TryGetValue(key, out var value) ? value : fallback;',
      cpp: 'return source.contains(key) ? source.at(key) : fallback;',
      rust: 'return source.get(&key).unwrap_or(fallback);',
      java: 'return source.containsKey(key) ? source.get(key) : fallback;',
      go: 'if value, ok := source.Get(key); ok {\n\treturn value\n}\nreturn fallback',
      lua: 'if source:contains(key) then return source:get(key) end\nreturn fallback',
      gdscript: 'return source.get(key, fallback)',
      ruby: 'return source.fetch(key, fallback)',
      php: 'return $source->has($key) ? $source->get($key) : $fallback;'
    }
  },
  {
    type: 'core:map.from-arrays', displayName: 'Make Map From Arrays', category: 'Utilities / Map', result: MAP, keywords: ['zip', 'from arrays', 'pairs', 'keys values', 'combine'],
    inputs: [input('keys', 'Keys', ARRAY), input('values', 'Values', VALUES)],
    description: 'A map of each key to the value at the same place in Values. A key given twice keeps its first place and its last value. Arrays of different lengths stop the run with an error.',
    code: after(SAME_LENGTH, {
      javascript: 'const result = new Map();\nkeys.forEach((key, i) => result.set(key, values[i]));\nreturn result;',
      python: 'return dict(zip(keys, values))',
      csharp: [
        'static Dictionary<TKey, TValue> Zip<TKey, TValue>(List<TKey> keys, List<TValue> values) where TKey : notnull',
        '{',
        '    var result = new Dictionary<TKey, TValue>();',
        '    for (var i = 0; i < keys.Count; i++) result[keys[i]] = values[i];',
        '    return result;',
        '}',
        'return Zip(keys, values);'
      ].join('\n'),
      cpp: 'vgraph::Map<typename std::decay_t<decltype(keys)>::value_type, typename std::decay_t<decltype(values)>::value_type> result;\nfor (std::size_t i = 0; i < keys.size(); i++) result[keys[i]] = values[i];\nreturn result;',
      rust: 'let mut result = vgraph::Map::new();\nfor (key, value) in keys.iter().zip(values.iter()) { result.insert(key.clone(), value.clone()); }\nreturn result;',
      java: 'return java.util.stream.IntStream.range(0, keys.size()).boxed().collect(java.util.stream.Collectors.toMap(keys::get, values::get, (first, later) -> later, java.util.LinkedHashMap::new));',
      go: 'result := NewVgMapFor(*keys, *values)\nfor i, key := range *keys {\n\tresult.Put(key, (*values)[i])\n}\nreturn result',
      lua: 'local result = vg.map()\nfor i = 1, keys.n do result:put(keys[i], values[i]) end\nreturn result',
      gdscript: 'var result := {}\nfor i in keys.size():\n\tresult[keys[i]] = values[i]\nreturn result',
      ruby: 'return keys.zip(values).to_h',
      php: '$result = new VgMap();\nforeach ($keys->items as $i => $key) {\n    $result->put($key, $values->items[$i]);\n}\nreturn $result;'
    })
  }
];

// ---- Arrays -------------------------------------------------------------------------------------
//
// `start` names the Start event's function in GDScript, so its snippets name that pin as ${start}.

const items = () => input('items', 'Target Array', ARRAY);
const index = (id: string, name: string) => input(id, name, INT, 0);

// An empty array stops the run, for the nodes that need an item.
const NOT_EMPTY: Snippets = {
  javascript: "if (!items.length) throw new Error('Array is empty');",
  python: 'if not items:\n    raise IndexError("Array is empty")',
  csharp: 'if (items.Count == 0) throw new InvalidOperationException("Array is empty");',
  cpp: 'if (items.empty()) throw std::out_of_range("Array is empty");',
  rust: 'if items.is_empty() { panic!("Array is empty"); }',
  java: 'if (items.isEmpty()) throw new IllegalStateException("Array is empty");',
  go: 'if len(*items) == 0 {\n\tVgFail("Array is empty")\n}',
  lua: 'if items.n == 0 then error("Array is empty", 0) end',
  gdscript: 'if items.is_empty():\n\treturn vg.fail("Array is empty")',
  ruby: 'raise IndexError, "Array is empty" if items.empty?',
  php: "if (count($items->items) === 0) {\n    throw new \\UnderflowException('Array is empty');\n}"
};
const FLOATS_NOT_EMPTY: Snippets = Object.fromEntries(Object.entries(NOT_EMPTY).map(([language, code]) => [language, code.replace(/(?<!->)items/g, 'values')]));

// Swap's two indexes must both be in range.
const SWAP_RANGE: Snippets = {
  javascript: "if (first < 0 || first >= items.length || second < 0 || second >= items.length) throw new Error('Index out of range');",
  python: 'if not (0 <= first < len(items) and 0 <= second < len(items)):\n    raise IndexError("Index out of range")',
  csharp: 'if (first < 0 || first >= items.Count || second < 0 || second >= items.Count) throw new ArgumentOutOfRangeException(nameof(first), "Index out of range");',
  cpp: 'auto size = static_cast<long long>(items.size());\nif (first < 0 || first >= size || second < 0 || second >= size) throw std::out_of_range("Index out of range");',
  rust: 'if first < 0 || first >= items.len() as i64 || second < 0 || second >= items.len() as i64 { panic!("Index out of range"); }',
  java: 'if (first < 0 || first >= items.size() || second < 0 || second >= items.size()) throw new IndexOutOfBoundsException("Index out of range");',
  go: 'if first < 0 || first >= len(*items) || second < 0 || second >= len(*items) {\n\tVgFail("Index out of range")\n}',
  lua: 'if first < 0 or first >= items.n or second < 0 or second >= items.n then error("Index out of range", 0) end',
  gdscript: 'if first < 0 or first >= items.size() or second < 0 or second >= items.size():\n\treturn vg.fail("Index out of range")',
  ruby: 'raise IndexError, "Index out of range" unless first.between?(0, items.length - 1) && second.between?(0, items.length - 1)',
  php: "if ($first < 0 || $first >= count($items->items) || $second < 0 || $second >= count($items->items)) {\n    throw new \\OutOfRangeException('Index out of range');\n}"
};

const STEP_NOT_ZERO: Snippets = {
  javascript: "if (step === 0) throw new Error(\"Step can't be 0\");",
  python: 'if step == 0:\n    raise ValueError("Step can\'t be 0")',
  csharp: 'if (step == 0) throw new ArgumentException("Step can\'t be 0");',
  cpp: 'if (step == 0) throw std::invalid_argument("Step can\'t be 0");',
  rust: 'if step == 0 { panic!("Step can\'t be 0"); }',
  java: 'if (step == 0) throw new IllegalArgumentException("Step can\'t be 0");',
  go: 'if step == 0 {\n\tVgFail("Step can\'t be 0")\n}',
  lua: 'if step == 0 then error("Step can\'t be 0", 0) end',
  gdscript: 'if step == 0:\n\treturn vg.fail("Step can\'t be 0")',
  ruby: 'raise ArgumentError, "Step can\'t be 0" if step.zero?',
  php: "if ($step === 0) {\n    throw new \\InvalidArgumentException(\"Step can't be 0\");\n}"
};

// The smallest or largest value (Unreal's Min Of Float Array and Max Of Float Array).
function extreme(smallest: boolean): Snippets {
  const op = smallest ? '<' : '>';
  return after(FLOATS_NOT_EMPTY, {
    javascript: `let result = values[0];\nfor (const value of values) if (value ${op} result) result = value;\nreturn result;`,
    python: `result = values[0]\nfor value in values:\n    if value ${op} result:\n        result = value\nreturn result`,
    csharp: `var result = values[0];\nforeach (var value in values) if (value ${op} result) result = value;\nreturn result;`,
    cpp: `double result = values[0];\nfor (double value : values) if (value ${op} result) result = value;\nreturn result;`,
    rust: `let mut result = values[0];\nfor value in values.iter() { if *value ${op} result { result = *value; } }\nreturn result;`,
    java: `double result = values.get(0);\nfor (double value : values) if (value ${op} result) result = value;\nreturn result;`,
    go: `result := (*values)[0]\nfor _, value := range *values {\n\tif value ${op} result {\n\t\tresult = value\n\t}\n}\nreturn result`,
    lua: `local result = values[1]\nfor i = 2, values.n do\n  if values[i] ${op} result then result = values[i] end\nend\nreturn result`,
    gdscript: `var result = values[0]\nfor value in values:\n\tif value ${op} result:\n\t\tresult = value\nreturn result`,
    ruby: `return values.${smallest ? 'min' : 'max'}`,
    php: `$result = $values->items[0];\nforeach ($values->items as $value) {\n    if ($value ${op} $result) {\n        $result = $value;\n    }\n}\nreturn $result;`
  });
}

export const ARRAY_UTILITIES: UtilityNode[] = [
  {
    type: 'core:array.reverse', displayName: 'Reverse', category: 'Utilities / Array', result: ARRAY, keywords: ['reverse', 'backwards', 'flip'],
    inputs: [items()], description: 'A new array of the items in reverse order.',
    code: {
      javascript: 'return [...items].reverse();', python: 'return items[::-1]', csharp: 'var result = items.ToList();\nresult.Reverse();\nreturn result;',
      cpp: 'return std::decay_t<decltype(items)>(items.rbegin(), items.rend());', rust: 'let mut result = items.clone();\nresult.reverse();\nreturn result;',
      java: 'var result = new java.util.ArrayList<>(items);\njava.util.Collections.reverse(result);\nreturn result;',
      go: 'result := slices.Clone(*items)\nslices.Reverse(result)\nreturn &result',
      lua: 'local result = vg.array()\nfor i = items.n, 1, -1 do\n  result.n = result.n + 1\n  result[result.n] = items[i]\nend\nreturn result',
      gdscript: 'var result = items.duplicate()\nresult.reverse()\nreturn result', ruby: 'return items.reverse', php: 'return new VgList(array_reverse($items->items));'
    }
  },
  {
    type: 'core:array.slice', displayName: 'Slice', category: 'Utilities / Array', result: ARRAY, keywords: ['slice', 'subarray', 'range', 'part', 'take'],
    inputs: [items(), index('start', 'Start Index'), input('count', 'Length', INT, 1)],
    description: 'A new array of Length items from Start Index (0 is the first), or as many as there are.',
    code: {
      javascript: 'const begin = Math.max(0, start);\nreturn items.slice(begin, begin + Math.max(0, count));',
      python: 'begin = max(0, start)\nreturn items[begin:begin + max(0, count)]',
      csharp: 'var begin = Math.Min(Math.Max(0, start), items.Count);\nreturn items.GetRange(begin, Math.Min(Math.Max(0, count), items.Count - begin));',
      cpp: 'auto size = static_cast<long long>(items.size());\nauto begin = std::min(std::max(0LL, start), size);\nauto end = std::min(begin + std::max(0LL, count), size);\nreturn std::decay_t<decltype(items)>(items.begin() + begin, items.begin() + end);',
      rust: 'let begin = (start.max(0) as usize).min(items.len());\nlet end = (begin + count.max(0) as usize).min(items.len());\nreturn items[begin..end].to_vec();',
      java: 'int begin = (int) Math.min(Math.max(0, start), items.size());\nint end = (int) Math.min(begin + Math.max(0, count), items.size());\nreturn new java.util.ArrayList<>(items.subList(begin, end));',
      go: 'begin := min(max(start, 0), len(*items))\nend := min(begin+max(count, 0), len(*items))\nresult := slices.Clone((*items)[begin:end])\nreturn &result',
      lua: 'local result = vg.array()\nlocal begin = math.max(0, start)\nfor i = begin + 1, math.min(items.n, begin + math.max(0, count)) do\n  result.n = result.n + 1\n  result[result.n] = items[i]\nend\nreturn result',
      gdscript: 'var begin := clampi(${start}, 0, items.size())\nreturn items.slice(begin, mini(begin + maxi(count, 0), items.size()))',
      ruby: 'return items[[start, 0].max, [count, 0].max] || []',
      php: 'return new VgList(array_slice($items->items, max(0, $start), max(0, $count)));'
    }
  },
  {
    type: 'core:array.sort', displayName: 'Sort', category: 'Utilities / Array', result: ARRAY, keywords: ['sort', 'order', 'ascending', 'arrange'],
    inputs: [items()],
    description: 'A new array of the items in ascending order: numbers by value, text by character code (so capitals come before small letters), false before true.',
    code: {
      javascript: 'return [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));',
      python: 'return sorted(items)',
      // Strings by character code, as the other languages compare them (C#'s default is by culture).
      csharp: 'var result = items.ToList();\nif ((object)result is List<string> strings) strings.Sort(string.CompareOrdinal);\nelse result.Sort();\nreturn result;',
      cpp: 'std::decay_t<decltype(items)> result = items;\nstd::stable_sort(result.begin(), result.end());\nreturn result;',
      rust: 'let mut result = items.clone();\nresult.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));\nreturn result;',
      java: 'var result = new java.util.ArrayList<>(items);\nresult.sort(null);\nreturn result;',
      go: 'result := slices.Clone(*items)\nsort.SliceStable(result, func(i, j int) bool { return vgLess(result[i], result[j]) })\nreturn &result',
      lua: 'local result = vg.array_of(items, items.n)\ntable.sort(result, vg.less)\nreturn result',
      gdscript: 'var result = items.duplicate()\nresult.sort()\nreturn result',
      // Ruby's booleans don't compare, so they sort as 0 and 1.
      ruby: 'return items.sort_by { |item| item == true ? 1 : (item == false ? 0 : item) }',
      php: '$result = $items->items;\nsort($result, $result !== [] && is_string($result[0]) ? SORT_STRING : SORT_REGULAR);\nreturn new VgList($result);'
    }
  },
  {
    type: 'core:array.shuffle', displayName: 'Shuffle', category: 'Utilities / Array', result: ARRAY, keywords: ['shuffle', 'random', 'mix', 'randomize'],
    inputs: [items()], description: 'A new array of the items in a random order. A new order each time it is read.',
    code: {
      javascript: 'const result = [...items];\nfor (let i = result.length - 1; i > 0; i--) {\n  const j = Math.floor(Math.random() * (i + 1));\n  [result[i], result[j]] = [result[j], result[i]];\n}\nreturn result;',
      python: 'import random\nresult = list(items)\nrandom.shuffle(result)\nreturn result',
      csharp: 'return items.OrderBy((_) => Random.Shared.Next()).ToList();',
      cpp: 'static std::mt19937_64 engine{std::random_device{}()};\nstd::decay_t<decltype(items)> result = items;\nstd::shuffle(result.begin(), result.end(), engine);\nreturn result;',
      rust: 'let mut result = items.clone();\nfor i in (1..result.len()).rev() {\n    let j = (vgraph::random() * (i + 1) as f64) as usize;\n    result.swap(i, j);\n}\nreturn result;',
      java: 'var result = new java.util.ArrayList<>(items);\njava.util.Collections.shuffle(result);\nreturn result;',
      go: 'result := slices.Clone(*items)\nrand.Shuffle(len(result), func(i, j int) { result[i], result[j] = result[j], result[i] })\nreturn &result',
      lua: 'local result = vg.array_of(items, items.n)\nfor i = result.n, 2, -1 do\n  local j = math.random(i)\n  result[i], result[j] = result[j], result[i]\nend\nreturn result',
      gdscript: 'var result = items.duplicate()\nresult.shuffle()\nreturn result',
      ruby: 'return items.shuffle',
      php: '$result = $items->items;\nshuffle($result);\nreturn new VgList($result);'
    }
  },
  {
    type: 'core:array.sum', displayName: 'Sum', category: 'Utilities / Array', result: FLOAT, keywords: ['sum', 'total', 'add up'],
    inputs: [input('values', 'Values', FLOATS)], description: 'The values added up, in order (0 for an empty array).',
    code: {
      javascript: 'let total = 0;\nfor (const value of values) total += value;\nreturn total;',
      // Python's sum() and Ruby's Array#sum compensate for rounding; the other languages add in order.
      python: 'total = 0.0\nfor value in values:\n    total += value\nreturn total',
      csharp: 'var total = 0.0;\nforeach (var value in values) total += value;\nreturn total;',
      cpp: 'double total = 0;\nfor (double value : values) total += value;\nreturn total;',
      rust: 'let mut total = 0.0;\nfor value in values.iter() { total += *value; }\nreturn total;',
      java: 'double total = 0;\nfor (double value : values) total += value;\nreturn total;',
      go: 'total := 0.0\nfor _, value := range *values {\n\ttotal += value\n}\nreturn total',
      lua: 'local total = 0\nfor i = 1, values.n do total = total + values[i] end\nreturn total',
      gdscript: 'var total := 0.0\nfor value in values:\n\ttotal += value\nreturn total',
      ruby: 'return values.inject(0.0) { |total, value| total + value }',
      php: '$total = 0.0;\nforeach ($values->items as $value) {\n    $total += $value;\n}\nreturn $total;'
    }
  },
  {
    type: 'core:array.min', displayName: 'Min Of Float Array', category: 'Utilities / Array', result: FLOAT, keywords: ['minimum', 'smallest', 'lowest'],
    inputs: [input('values', 'Values', FLOATS)], description: 'The smallest value. An empty array stops the run with an error.', code: extreme(true)
  },
  {
    type: 'core:array.max', displayName: 'Max Of Float Array', category: 'Utilities / Array', result: FLOAT, keywords: ['maximum', 'largest', 'highest'],
    inputs: [input('values', 'Values', FLOATS)], description: 'The largest value. An empty array stops the run with an error.', code: extreme(false)
  },
  {
    type: 'core:array.range', displayName: 'Range', category: 'Utilities / Array', result: INTS, keywords: ['range', 'sequence', 'numbers', 'count', 'from to'],
    inputs: [input('start', 'Start', INT, 0), input('stop', 'End', INT, 10), input('step', 'Step', INT, 1)],
    description: 'The whole numbers from Start up to End, End left out, Step apart (0, 1, … 9 by default). A negative Step counts down; a Step of 0 stops the run with an error.',
    code: after(STEP_NOT_ZERO, {
      javascript: 'const result = [];\nfor (let i = start; step > 0 ? i < stop : i > stop; i += step) result.push(i);\nreturn result;',
      python: 'return list(range(start, stop, step))',
      csharp: 'var result = new List<int>();\nfor (var i = start; step > 0 ? i < stop : i > stop; i += step) result.Add(i);\nreturn result;',
      cpp: 'std::vector<long long> result;\nfor (long long i = start; step > 0 ? i < stop : i > stop; i += step) result.push_back(i);\nreturn result;',
      rust: 'let mut result = Vec::new();\nlet mut i = start;\nwhile if step > 0 { i < stop } else { i > stop } {\n    result.push(i);\n    i += step;\n}\nreturn result;',
      java: 'var result = new java.util.ArrayList<Long>();\nfor (long i = start; step > 0 ? i < stop : i > stop; i += step) result.add(i);\nreturn result;',
      go: 'result := []int{}\nfor i := start; (step > 0 && i < stop) || (step < 0 && i > stop); i += step {\n\tresult = append(result, i)\n}\nreturn &result',
      lua: 'local result = vg.array()\nfor i = start, step > 0 and stop - 1 or stop + 1, step do\n  result.n = result.n + 1\n  result[result.n] = i\nend\nreturn result',
      gdscript: 'return range(${start}, stop, step)',
      ruby: 'result = []\ni = start\nwhile step > 0 ? i < stop : i > stop\n  result << i\n  i += step\nend\nreturn result',
      php: '$result = [];\nfor ($i = $start; $step > 0 ? $i < $stop : $i > $stop; $i += $step) {\n    $result[] = $i;\n}\nreturn new VgList($result);'
    })
  },
  {
    type: 'core:array.first', displayName: 'First', category: 'Utilities / Array', result: ITEM, keywords: ['first', 'head', 'front'],
    inputs: [items()], description: 'The first item. An empty array stops the run with an error.',
    code: after(NOT_EMPTY, {
      javascript: 'return items[0];', python: 'return items[0]', csharp: 'return items[0];', cpp: 'return items.front();', rust: 'return items[0].clone();',
      java: 'return items.get(0);', go: 'return (*items)[0]', lua: 'return items[1]', gdscript: 'return items[0]', ruby: 'return items.first', php: 'return $items->items[0];'
    })
  },
  {
    type: 'core:array.last', displayName: 'Last', category: 'Utilities / Array', result: ITEM, keywords: ['last', 'tail', 'back', 'end'],
    inputs: [items()], description: 'The last item. An empty array stops the run with an error.',
    code: after(NOT_EMPTY, {
      javascript: 'return items[items.length - 1];', python: 'return items[-1]', csharp: 'return items[items.Count - 1];', cpp: 'return items.back();',
      rust: 'return items[items.len() - 1].clone();', java: 'return items.get(items.size() - 1);', go: 'return (*items)[len(*items)-1]', lua: 'return items[items.n]',
      gdscript: 'return items.back()', ruby: 'return items.last', php: 'return $items->items[count($items->items) - 1];'
    })
  },
  {
    type: 'core:array.random-item', displayName: 'Random Item', category: 'Utilities / Array', result: ITEM, keywords: ['random', 'pick', 'choose', 'sample'],
    inputs: [items()], description: 'One of the items, picked at random; a new pick each time it is read. An empty array stops the run with an error.',
    code: after(NOT_EMPTY, {
      javascript: 'return items[Math.floor(Math.random() * items.length)];', python: 'import random\nreturn random.choice(items)',
      csharp: 'return items[Random.Shared.Next(items.Count)];',
      cpp: 'static std::mt19937_64 engine{std::random_device{}()};\nreturn items[std::uniform_int_distribution<std::size_t>(0, items.size() - 1)(engine)];',
      rust: 'return items[(vgraph::random() * items.len() as f64) as usize].clone();', java: 'return items.get((int) (Math.random() * items.size()));',
      go: 'return (*items)[rand.Intn(len(*items))]', lua: 'return items[math.random(items.n)]', gdscript: 'return items.pick_random()', ruby: 'return items.sample',
      php: 'return $items->items[array_rand($items->items)];'
    })
  },
  {
    type: 'core:array.append', displayName: 'Append Array', category: 'Utilities / Array', result: ARRAY, keywords: ['append', 'concat', 'concatenate', 'combine', 'join'],
    inputs: [input('a', 'A', ARRAY), input('b', 'B', ARRAY)], description: 'A new array of A\'s items followed by B\'s.',
    code: {
      javascript: 'return [...a, ...b];', python: 'return a + b', csharp: 'return a.Concat(b).ToList();',
      cpp: 'std::decay_t<decltype(a)> result = a;\nresult.insert(result.end(), b.begin(), b.end());\nreturn result;',
      rust: 'let mut result = a.clone();\nresult.extend(b.iter().cloned());\nreturn result;',
      java: 'var result = new java.util.ArrayList<>(a);\nresult.addAll(b);\nreturn result;',
      go: 'result := append(slices.Clone(*a), *b...)\nreturn &result',
      lua: 'local result = vg.array_of(a, a.n)\nfor i = 1, b.n do\n  result.n = result.n + 1\n  result[result.n] = b[i]\nend\nreturn result',
      gdscript: 'return a + b', ruby: 'return a + b', php: 'return new VgList(array_merge($a->items, $b->items));'
    }
  },
  {
    type: 'core:array.swap', displayName: 'Swap', category: 'Utilities / Array', result: ARRAY, keywords: ['swap', 'exchange', 'switch'],
    inputs: [items(), index('first', 'First Index'), index('second', 'Second Index')],
    description: 'A new array with the items at First Index and Second Index changed places. An index out of range stops the run with an error.',
    code: after(SWAP_RANGE, {
      javascript: 'const result = [...items];\n[result[first], result[second]] = [result[second], result[first]];\nreturn result;',
      python: 'result = list(items)\nresult[first], result[second] = result[second], result[first]\nreturn result',
      csharp: 'var result = items.ToList();\n(result[first], result[second]) = (result[second], result[first]);\nreturn result;',
      cpp: 'std::decay_t<decltype(items)> result = items;\nstd::iter_swap(result.begin() + first, result.begin() + second);\nreturn result;',
      rust: 'let mut result = items.clone();\nresult.swap(first as usize, second as usize);\nreturn result;',
      java: 'var result = new java.util.ArrayList<>(items);\njava.util.Collections.swap(result, (int) first, (int) second);\nreturn result;',
      go: 'result := slices.Clone(*items)\nresult[first], result[second] = result[second], result[first]\nreturn &result',
      lua: 'local result = vg.array_of(items, items.n)\nresult[first + 1], result[second + 1] = result[second + 1], result[first + 1]\nreturn result',
      gdscript: 'var result = items.duplicate()\nvar saved = result[first]\nresult[first] = result[second]\nresult[second] = saved\nreturn result',
      ruby: 'result = items.dup\nresult[first], result[second] = result[second], result[first]\nreturn result',
      php: '$result = $items->items;\n[$result[$first], $result[$second]] = [$result[$second], $result[$first]];\nreturn new VgList($result);'
    })
  }
];
