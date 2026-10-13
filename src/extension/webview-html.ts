// The editor webview's markup. Kept free of the vscode API so the browser tests load exactly the
// page the extension serves.
export interface WebviewHtmlOptions {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

export function renderEditorHtml({ cspSource, nonce, scriptUri, styleUri }: WebviewHtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
<title>Blueprint Visual Graph</title>
</head>
<body>
<div id="app">
  <aside id="left" class="panel">
    <section id="my-blueprint" aria-label="My Blueprint">
      <div class="panel-title">My Blueprint</div>
      <div id="mb-sections"></div>
    </section>
    <section id="palette" aria-label="Palette">
      <div class="panel-title">Palette</div>
      <input id="search" class="search" placeholder="Search nodes…" aria-label="Search nodes">
      <div id="categories"></div>
    </section>
  </aside>
  <div id="floating-menu" class="floating-menu" hidden></div>
  <div id="drag-ghost" hidden></div>
  <main id="workspace">
    <div id="toolbar">
      <button id="compile" class="compile-button" data-state="unknown" title="Compile the graph to its target language"><span class="compile-icon" aria-hidden="true"></span>Compile</button>
      <button id="run" title="Compile, then run the generated code">▶ Run</button>
      <button id="simulate" title="Run the graph in the editor without compiling">Simulate</button>
      <label class="language-picker" title="Target language for generated code"><span>Language</span><select id="language" aria-label="Target language"></select></label>
      <button id="fit" title="Fit graph">Fit</button>
      <span id="graph-name">Untitled</span>
      <span id="status">Ready</span>
    </div>
    <div id="canvas-wrap">
      <svg id="edges" aria-hidden="true"></svg>
      <div id="world"></div>
      <div id="selection-box" hidden></div>
      <div id="context-menu" hidden></div>
    </div>
    <section id="compiler-results" hidden aria-label="Compiler Results">
      <header><span id="results-title">Compiler Results</span><button id="results-close" title="Close">×</button></header>
      <ul id="results-list"></ul>
    </section>
    <div id="help">Drag pins to connect · Alt+click a pin breaks its links · Ctrl+drag a pin moves them · Right-click for menus, right-drag to pan · Hold B, S or P and click to place · F7 compiles</div>
  </main>
  <aside id="inspector" class="panel">
    <div class="panel-title">Details</div>
    <div id="inspector-content" class="muted">Select a node to see its details.</div>
  </aside>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}
