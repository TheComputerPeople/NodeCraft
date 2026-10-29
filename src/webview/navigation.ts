// Go to Definition (F12, or double-click) and Find References (Shift+F12) on a node
// (docs/node-authoring.md, gap 5). A graph of this file opens here; anything else is the host's to
// open, and references are searched in every graph file by the host.
import { definitionFor } from '../core/editing';
import { DefinitionSite, definitionSite } from '../core/navigation';
import { lookupDefinition } from './document';
import { setStatus } from './dom';
import { showReferences } from './find';
import { postToHost } from './host';
import { openGraph } from './my-blueprint';
import { state } from './state';

export function siteOf(nodeId: string): DefinitionSite | undefined {
  const node = state.graph?.nodes.find((n) => n.id === nodeId);
  return node ? definitionSite(node, definitionFor(node, lookupDefinition), state.document ?? undefined) : undefined;
}

export function goToDefinition(nodeId: string): void {
  const node = state.graph?.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const site = siteOf(nodeId);
  if (!site) {
    setStatus(`${definitionFor(node, lookupDefinition).displayName} is built in: it has no definition to open.`);
    return;
  }
  if (site.kind === 'graph') openGraph(site.graphId);
  else postToHost({ type: 'goToDefinition', nodeType: node.type, site });
}

export function findReferences(nodeId: string): void {
  const node = state.graph?.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const def = definitionFor(node, lookupDefinition);
  showReferences(def.displayName);
  postToHost({ type: 'findReferences', nodeType: def.type });
}
