import { LanguagePackRegistry } from '../language-pack';
import { javascriptPack, typescriptPack } from './javascript';

export const DEFAULT_LANGUAGE = 'javascript';

// The packs built into the extension, in detection-priority order.
export function builtinLanguagePacks(): LanguagePackRegistry {
  return new LanguagePackRegistry([typescriptPack, javascriptPack]);
}
