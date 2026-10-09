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
  <aside id="palette" class="panel">
    <div class="panel-title">Nodes</div>
    <input id="search" class="search" placeholder="Search nodes…" aria-label="Search nodes">
    <div id="categories"></div>
  </aside>
  <main id="workspace">
    <div id="toolbar">
      <button id="run" title="Run Graph">▶ Run</button>
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
    <div id="help">Drag pins to connect. Ctrl+click a wire/pin to rewire; release off a pin to remove. Alt+click breaks connections. Right-click opens a menu. Click-drag the background to box-select; middle-drag pans; wheel zooms.</div>
  </main>
  <aside id="inspector" class="panel">
    <div class="panel-title">Inspector</div>
    <div id="inspector-content" class="muted">Select a node to edit defaults.</div>
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
