// Unreal's set and array functions beyond the container nodes' (docs/code-as-nodes.md, "More of
// Unreal's library"). They make new containers and leave their inputs as they are; sets print, as
// To Array lists them, in ascending order, so every language shows the same set.
import { SET, Snippets, UtilityNode, input } from './utility-kit';

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
