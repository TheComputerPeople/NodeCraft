import { LanguagePackRegistry } from '../language-pack';
import { cppPack } from './cpp';
import { csharpPack } from './csharp';
import { javascriptPack, typescriptPack } from './javascript';
import { pythonPack } from './python';

export const DEFAULT_LANGUAGE = 'javascript';

// The packs built into the extension, in detection-priority order: a project with a tsconfig.json is
// TypeScript, a Python project that keeps a package.json for tooling is still Python, a .NET
// project with a package.json for front-end tooling is still C#, and so is a C++ project.
export function builtinLanguagePacks(): LanguagePackRegistry {
  return new LanguagePackRegistry([typescriptPack, csharpPack, cppPack, pythonPack, javascriptPack]);
}
