// What the utility node files (utilities*.ts) share: the shape of a utility node and its pins.
import { NodeExample, PinDefinition, TypeRef } from './model';

export type Snippets = Record<string, string>;

export interface UtilityNode {
  type: string;
  displayName: string;
  category: string;
  description: string;
  keywords: string[];
  inputs: PinDefinition[];
  result: TypeRef;
  code: Snippets;
  // Drawn as a compact node with the name in the middle, as Unreal draws operators.
  compact?: boolean;
  // Inputs and the outputs they give (src/core/node-examples.ts).
  examples?: NodeExample[];
}

export const input = (id: string, name: string, type: TypeRef, defaultValue?: unknown): PinDefinition => ({ id, name, kind: 'data', direction: 'input', type, ...(defaultValue !== undefined ? { defaultValue } : {}) });
export const output = (type: TypeRef): PinDefinition => ({ id: 'returnValue', name: 'Return Value', kind: 'data', direction: 'output', type });
export const STRING: TypeRef = { id: 'string' };
export const INT: TypeRef = { id: 'int' };
export const FLOAT: TypeRef = { id: 'float' };
export const BOOL: TypeRef = { id: 'bool' };
export const ARRAY: TypeRef = { id: 'wildcard', container: 'array' };
export const SET: TypeRef = { id: 'wildcard', container: 'set' };
export const ITEM: TypeRef = { id: 'wildcard' };
export const FLOATS: TypeRef = { id: 'float', container: 'array' };
export const INTS: TypeRef = { id: 'int', container: 'array' };
export const STRINGS: TypeRef = { id: 'string', container: 'array' };
export const MAP: TypeRef = { id: 'wildcard', container: 'map', valueType: { id: 'wildcard:value' } };
export const text = (id = 'text', name = 'Text') => input(id, name, STRING, '');
