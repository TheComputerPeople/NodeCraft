import { LanguagePackRegistry } from '../language-pack';
import { cppPack } from './cpp';
import { csharpPack } from './csharp';
import { goPack } from './go';
import { javaPack } from './java';
import { javascriptPack, typescriptPack } from './javascript';
import { gdscriptPack } from './gdscript';
import { luaPack } from './lua';
import { pythonPack } from './python';
import { rubyPack } from './ruby';
import { rustPack } from './rust';

export const DEFAULT_LANGUAGE = 'javascript';

// The packs built into the extension, in detection-priority order: a project with a tsconfig.json is
// TypeScript, a Python project that keeps a package.json for tooling is still Python, a .NET
// project with a package.json for front-end tooling is still C#, and so are C++, Rust, Java, Go, Godot, Lua and Ruby projects.
export function builtinLanguagePacks(): LanguagePackRegistry {
  return new LanguagePackRegistry([typescriptPack, csharpPack, cppPack, rustPack, javaPack, goPack, gdscriptPack, luaPack, rubyPack, pythonPack, javascriptPack]);
}
