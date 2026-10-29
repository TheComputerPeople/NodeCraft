// Unreal's function metadata (docs/node-authoring.md, gap 6), as graph functions and macros set it
// in Details: Keywords, Compact Node Title and Deprecated on the signature, Advanced View on its
// inputs. Each node made from a signature (calls, macro instances, library functions, other
// classes' functions) takes them.
import { GraphSignature, NodeDefinition } from './model';

export type FunctionMetadata = Pick<NodeDefinition, 'keywords' | 'compactTitle' | 'deprecated'>;

export function signatureMetadata(signature: GraphSignature | undefined): FunctionMetadata {
  return {
    ...(signature?.keywords?.length ? { keywords: signature.keywords } : {}),
    ...(signature?.compactTitle ? { compactTitle: signature.compactTitle } : {}),
    ...(signature?.deprecated ? { deprecated: signature.deprecated } : {})
  };
}

// The warning a deprecated node shows, and compiles with.
export function deprecationMessage(def: NodeDefinition): string {
  const message = def.deprecated?.message?.trim();
  return `"${def.displayName}" is deprecated${message ? `: ${message}` : '.'}`;
}

// Keywords as Details takes them: words separated by spaces or commas.
export function parseKeywords(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean))];
}
