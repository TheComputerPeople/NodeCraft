import { LanguagePackRegistry } from '../language-pack';
import { cppPack } from './cpp';
import { csharpPack } from './csharp';
import { javaPack } from './java';
import { javascriptPack, typescriptPack } from './javascript';
import { pythonPack } from './python';
import { rustPack } from './rust';

export const DEFAULT_LANGUAGE = 'javascript';

// The packs built into the extension, in detection-priority order: a project with a tsconfig.json is
// TypeScript, a Python project that keeps a package.json for tooling is still Python, a .NET
// project with a package.json for front-end tooling is still C#, and so are C++, Rust and Java projects.
export function builtinLanguagePacks(): LanguagePackRegistry {
  return new LanguagePackRegistry([typescriptPack, csharpPack, cppPack, rustPack, javaPack, pythonPack, javascriptPack]);
}
