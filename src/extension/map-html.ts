// The Codebase Map webview's markup (docs/codebase-map.md, Part 3). Free of the vscode API, so the
// browser tests load exactly the page the extension serves.
import type { WebviewHtmlOptions } from './webview-html';

export function renderMapHtml({ cspSource, nonce, scriptUri, styleUri }: WebviewHtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
<title>Codebase Map</title>
</head>
<body>
<div id="map-app">
  <header id="map-toolbar">
    <span id="map-title">Codebase Map</span>
    <span id="map-modes" role="radiogroup" aria-label="View">
      <button class="map-mode" data-mode="architecture" role="radio" aria-checked="true" title="Projects, folders and files, and their imports: importers above what they import">Architecture</button>
      <button class="map-mode" data-mode="structure" role="radio" aria-checked="false" title="Types and their members, and inheritance: parents above their children">Structure</button>
      <button class="map-mode" data-mode="calls" role="radio" aria-checked="false" title="What calls what, from the entry points or a function, flowing down">Call flow</button>
      <button class="map-mode" data-mode="flow" role="radio" aria-checked="false" title="A function's control flow (choose one with its ⧉ button)">Control flow</button>
    </span>
    <span id="map-flow" hidden>
      <button id="map-flow-back" title="Back to the flowchart before" aria-label="Back">&#x2190;</button>
      <button id="map-flow-forward" title="Forward to the next flowchart" aria-label="Forward">&#x2192;</button>
      <span id="map-flow-label"></span>
    </span>
    <span id="map-calls" hidden>
      <span id="map-directions" role="radiogroup" aria-label="Direction">
        <button class="map-direction" data-direction="callees" role="radio" aria-checked="true" title="The calls it makes, flowing down">Calls made</button>
        <button class="map-direction" data-direction="callers" role="radio" aria-checked="false" title="Everything that reaches it, from above">Callers</button>
      </span>
      <span id="map-root"><span id="map-root-label">From the entry points</span><button id="map-root-clear" title="Start from the entry points" aria-label="Start from the entry points" hidden>×</button></span>
    </span>
    <input id="map-find" type="search" placeholder="Find (Ctrl+F)" aria-label="Find on the map" aria-controls="map-found" aria-autocomplete="list" autocomplete="off" spellcheck="false">
    <button id="map-filter" aria-haspopup="true" aria-expanded="false" title="Hide languages, projects, packages or tests">Filter</button>
    <button id="map-fit" title="Fit the map (Home)">Fit</button>
    <span class="map-legend" aria-label="Legend">
      <span class="legend-item" data-kind="imports">imports</span>
      <span class="legend-item" data-kind="calls">calls</span>
      <span class="legend-item" data-kind="inherits">extends</span>
      <span class="legend-item guess">guessed</span>
      <span class="legend-item cycle">import cycle</span>
    </span>
    <span id="map-status" aria-live="polite">Reading the code…</span>
  </header>
  <ul id="map-found" role="listbox" aria-label="Found" hidden></ul>
  <div id="map-filters" role="dialog" aria-label="Filters" hidden></div>
  <main id="map-canvas" tabindex="0" aria-label="Codebase Map. Drag to pan, scroll to zoom, double-click a box to open it.">
    <div id="map-world">
      <svg id="map-arrows" aria-hidden="true"></svg>
      <div id="map-boxes"></div>
    </div>
  </main>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
