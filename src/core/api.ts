// The public API (docs/language-breadth.md, "The public API and the pack SDK"): what the extension's
// activate returns to other extensions, so language packs and node libraries can ship separately.
// Kept free of the VS Code API so the pack SDK can carry these types.
import { LanguagePack } from './language-pack';
import { NodeDefinition } from './model';

// The version of the API and of the pack types (LanguagePack, the Visual IR). A change that breaks
// packs is a new version; registering a pack built for another version is refused.
export const API_VERSION = 1;

export interface Disposable {
  dispose(): void;
}

// Node definitions shipped together, such as a framework pack's events and nodes.
export interface NodeLibrary {
  name: string;
  version: string;
  nodes: NodeDefinition[];
}

export interface BlueprintVisualScriptingApi {
  readonly apiVersion: number;
  // A language pack written in code (Tier 1). It must say which API version it was built for
  // (`apiVersion`); its id must not be taken. Disposing removes it.
  registerLanguagePack(pack: LanguagePack): Disposable;
  // Node definitions for every graph, under the library's name. Disposing removes them.
  registerNodeLibrary(library: NodeLibrary): Disposable;
}

// Why a pack can't be registered, or undefined when it can.
export function packProblem(pack: Partial<LanguagePack> | undefined, taken: (id: string) => boolean): string | undefined {
  if (!pack || typeof pack !== 'object') return 'A language pack must be an object.';
  if (typeof pack.id !== 'string' || !pack.id) return 'A language pack needs an id.';
  if (pack.apiVersion !== API_VERSION) {
    return `The ${pack.displayName ?? pack.id} pack was built for API version ${pack.apiVersion ?? '(none)'}, but this extension provides version ${API_VERSION}.`;
  }
  if (taken(pack.id)) return `A language pack with the id "${pack.id}" is already registered.`;
  if (typeof pack.displayName !== 'string' || typeof pack.mapType !== 'function' || !pack.capabilities) return `The ${pack.id} pack is missing displayName, capabilities or mapType.`;
  return undefined;
}
