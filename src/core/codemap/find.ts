// Finding things in the Codebase Map (docs/codebase-map.md, Part 3): the index's entities by name,
// ranked; what the filters hide; tests by their names and places. Pure.
import { CodeIndex, Entity } from './code-index';

export interface FoundEntity {
  id: string;
  label: string;
  kind: Entity['kind'];
  // Where it is: its file and line, or its folder.
  where: string;
}

// What the map's filters hide.
export interface MapFilters {
  // Languages hidden (the extension's ids).
  languages?: string[];
  // Projects hidden (their ids).
  projects?: string[];
  // False hides the external packages.
  externals?: boolean;
  // False hides tests: files and folders of tests, and test functions.
  tests?: boolean;
}

export const MAX_FOUND = 30;

// The entities whose names match `query`, best first: the name itself, then names starting with it,
// then a word in the name starting with it (camelCase, snake_case), then anywhere in it. Declarations
// come before files and folders of the same rank.
export function findEntities(index: CodeIndex, query: string): FoundEntity[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { entity: Entity; score: number }[] = [];
  for (const entity of index.entities) {
    if (entity.kind === 'project' && !entity.name) continue;
    const name = entity.name.toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    const words = entity.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_.\-/]+/);
    const score = name === q || name === `${q}.vgraph` ? 0 : at === 0 ? 1 : words.some((w) => w.startsWith(q)) ? 2 : 3;
    const kindRank = entity.kind === 'function' || entity.kind === 'type' || entity.kind === 'graph' ? 0 : entity.kind === 'file' || entity.kind === 'graph-file' ? 1 : 2;
    scored.push({ entity, score: score * 3 + kindRank });
  }
  scored.sort((a, b) => a.score - b.score || a.entity.name.length - b.entity.name.length || a.entity.name.localeCompare(b.entity.name));
  return scored.slice(0, MAX_FOUND).map(({ entity }) => ({
    id: entity.id,
    label: entity.kind === 'graph-file' ? entity.name.replace(/\.vgraph$/, '') : entity.name,
    kind: entity.kind,
    where: entity.path ? `${entity.path}${entity.line ? `:${entity.line}` : ''}` : entity.kind
  }));
}

// A test: in a test folder, in a file named as tests are, or marked as a test entry point.
export function isTest(entity: Entity): boolean {
  if (entity.entries?.some((e) => e.kind === 'test')) return true;
  const p = entity.path ?? '';
  return /(^|\/)(tests?|__tests__|specs?|testing)(\/|$)/i.test(p) || /(\.test|\.spec|_test|_spec|Test|Tests|Spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/.test(p);
}

// The entities the filters hide (with everything inside them).
export function hiddenBy(index: CodeIndex, filters: MapFilters | undefined): Set<string> {
  const hidden = new Set<string>();
  if (!filters) return hidden;
  const languages = new Set(filters.languages ?? []);
  const projects = new Set(filters.projects ?? []);
  const hides = (e: Entity): boolean => {
    if (e.kind === 'external') return filters.externals === false || (!!e.language && languages.has(e.language));
    if (e.kind === 'project') return projects.has(e.id);
    if (e.language && languages.has(e.language)) return true;
    if (filters.tests !== false) return false;
    // A folder of tests by its name; anything else by its file's name or its entry points.
    return e.kind === 'module' ? /(^|\/)(tests?|__tests__|specs?)$/i.test(e.path ?? '') : isTest(e);
  };
  // Parents come before their children in the index: a hidden parent hides what it holds.
  for (const e of index.entities) {
    if (hides(e) || (e.parent && hidden.has(e.parent))) hidden.add(e.id);
  }
  return hidden;
}

// The languages and projects of an index, for the filters.
export function filterOptions(index: CodeIndex): { languages: string[]; projects: { id: string; label: string }[] } {
  const languages = new Set<string>();
  for (const e of index.entities) if (e.language && e.kind !== 'external') languages.add(e.language);
  return {
    languages: [...languages].sort(),
    projects: index.entities.filter((e) => e.kind === 'project').map((e) => ({ id: e.id, label: e.name }))
  };
}
