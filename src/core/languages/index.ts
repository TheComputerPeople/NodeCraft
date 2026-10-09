import { LanguagePackRegistry } from '../language-pack';
import { javascriptPack, typescriptPack } from './javascript';
import { pythonPack } from './python';

export const DEFAULT_LANGUAGE = 'javascript';

// The packs built into the extension, in detection-priority order: a project with a tsconfig.json is
// TypeScript, and a Python project that keeps a package.json for tooling is still Python.
export function builtinLanguagePacks(): LanguagePackRegistry {
  return new LanguagePackRegistry([typescriptPack, pythonPack, javascriptPack]);
}
