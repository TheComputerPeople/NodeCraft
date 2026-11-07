// Language versions (docs/project-integration.md, part 2): what each language's generated code
// needs, and the lowest version a project's declaration allows, to warn when it's older.

// What a language's generated code needs, as measured: `needs` when an older version was shown to
// fail (or checked statically), `tested` when it's only the oldest version tried.
export interface LanguageRequirement {
  // Comparable with a declared version's `lowest`: "17", "3.8", "2022" (an ES year), "2018" (an edition).
  version: string;
  // As people say it: "Java 17", "ES2022", "C++20", "edition 2018".
  label: string;
  basis: 'needs' | 'tested';
  // What it needs it for: "records, switch rules and HexFormat".
  why?: string;
}

// Versions compared by their numbers: "3.10" is after "3.9", "8" equals "8.0".
export function compareVersionNumbers(a: string, b: string): number {
  const x = a.split('.').map((n) => Number(n) || 0);
  const y = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// The lowest version a declaration allows: ">=3.8" and "^3.8" and "~> 3.8" and "3.8.*" give "3.8",
// "^7.4 || ^8.0" gives "7.4", "3.11.4" gives "3.11.4". Undefined when it has no lower bound ("<4").
export function lowestVersion(spec: string): string | undefined {
  let lowest: string | undefined;
  for (const alternative of spec.split('||')) {
    let bound: string | undefined;
    for (const match of alternative.matchAll(/(>=|<=|>|<|\^|~>|~=|~|===|==|=|!=)?\s*v?(\d+(?:\.\d+)*)/g)) {
      const op = match[1] ?? '';
      if (op === '<' || op === '<=' || op === '!=') continue;
      if (!bound || compareVersionNumbers(match[2], bound) > 0) bound = match[2];
    }
    if (!bound) return undefined;
    if (!lowest || compareVersionNumbers(bound, lowest) < 0) lowest = bound;
  }
  return lowest;
}

// The warning for a project that declares an older version than generated code needs, or none.
export function versionWarning(languageName: string, requirement: LanguageRequirement, declared: { declared: string; lowest: string; source: string }): string | undefined {
  if (compareVersionNumbers(declared.lowest, requirement.version) >= 0) return undefined;
  // A range says which version it lets in; a version is quoted as written.
  const range = /[<>=^~*|]/.test(declared.declared);
  const project = `This project declares ${declared.declared} in ${declared.source}${range ? `, which allows ${declared.lowest}` : ''}`;
  const needs = requirement.basis === 'needs'
    ? `generated ${languageName} needs ${requirement.label}${requirement.why ? ` (${requirement.why})` : ''}`
    : `generated ${languageName} is tested with ${requirement.label} and later`;
  return `${project}, but ${needs}. Older versions may not build or run it.`;
}
