/* Blueprint-style graph editor. Dependency-free webview with Blueprint-like interactions. */
(() => {
  const vscode = acquireVsCodeApi();
  const state = {
    graph: null,
    definitions: [],
    defByType: new Map(),
    selectedNodeIds: new Set(),
    selectedNodeId: null,
    draftConnection: null,
    rewire: null,
    pan: { x: 0, y: 0 },
    zoom: 1,
    dragging: null,
    panning: null,
    selection: null,
    saveTimer: null,
    saveDelay: 150,
    dirty: false,
    // Nodes reached by the current/last run. The host runs a graph synchronously, so events arrive
    // in one burst; showing the whole path briefly is the only highlight a user can actually see.
    executedNodeIds: new Set(),
    runActive: false,
    runtimeClearTimer: null,
    runtimePaintPending: false
  };
  const RUN_TRAIL_MS = 1500;

  const world = document.getElementById('world');
  const edges = document.getElementById('edges');
  const canvasWrap = document.getElementById('canvas-wrap');
  const selectionBox = document.getElementById('selection-box');
  const categories = document.getElementById('categories');
  const search = document.getElementById('search');
  const inspector = document.getElementById('inspector-content');
  const status = document.getElementById('status');
  const graphName = document.getElementById('graph-name');
  const contextMenu = document.getElementById('context-menu');

  document.getElementById('run').addEventListener('click', () => vscode.postMessage({ type: 'runGraph' }));
  document.getElementById('fit').addEventListener('click', fitGraph);
  search.addEventListener('input', renderPalette);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'init') {
      applySettings(message);
      setDefinitions(message.definitions || []);
      // No graph means the document could not be parsed; editing stays disabled until it can.
      if (message.graph) loadGraph(message.graph);
    } else if (message.type === 'graphChanged') {
      const hadGraph = !!state.graph;
      const selected = new Set(state.selectedNodeIds);
      const primary = state.selectedNodeId;
      loadGraph(message.graph, hadGraph);
      if (hadGraph) {
        state.selectedNodeIds = new Set([...selected].filter(id => state.graph.nodes.some(n => n.id === id)));
        state.selectedNodeId = state.graph.nodes.some(n => n.id === primary) ? primary : [...state.selectedNodeIds][0] || null;
        render();
      }
    } else if (message.type === 'definitions') {
      setDefinitions(message.definitions || []);
      render();
    } else if (message.type === 'settings') {
      applySettings(message);
    } else if (message.type === 'runtimeEvent') {
      handleRuntimeEvent(message.event);
    } else if (message.type === 'error') {
      state.runActive = false;
      setStatus(message.message || 'Error');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedNodeIds.size) {
      deleteSelected();
      e.preventDefault();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      selectAllNodes();
      e.preventDefault();
    }
    if (e.key === 'Escape') {
      hideContextMenu();
      state.draftConnection = null;
      state.rewire = null;
      state.selection = null;
      hideSelectionBox();
      renderEdges();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      flushSave();
      e.preventDefault();
    }
  });

  canvasWrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.target.closest('#context-menu')) return;
    const nodeEl = e.target.closest('.node');
    if (nodeEl) {
      const nodeId = nodeEl.dataset.node;
      if (!state.selectedNodeIds.has(nodeId)) {
        selectNode(nodeId, false, true);
      } else {
        state.selectedNodeId = nodeId;
        syncSelectionClasses();
        renderInspector();
      }
      showNodeContextMenu(nodeId, e.clientX, e.clientY);
    } else {
      const position = screenToWorld(e.clientX, e.clientY);
      showAddNodeMenu(position, e.clientX, e.clientY, state.definitions, 'Add Node');
    }
  });

  // Core editor gestures use the original mouse-event path. Pins stop propagation so the
  // node/background handlers never steal a wiring gesture.
  canvasWrap.addEventListener('mousedown', (e) => {
    if (e.target.closest('#context-menu')) return;
    hideContextMenu();

    if (e.button === 1) {
      state.panning = { startX: e.clientX, startY: e.clientY, panX: state.pan.x, panY: state.pan.y };
      e.preventDefault();
      return;
    }

    if (e.button === 0 && !e.target.closest('.node') && !e.target.closest('.pin') && !e.target.closest('.edge-hit')) {
      beginGroupSelection(e);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (state.panning) state.panning = null;

    if (state.selection) {
      finishGroupSelection(e);
      return;
    }

    if (state.dragging?.kind === 'nodes') {
      const moved = state.dragging.moved;
      state.dragging = null;
      if (moved) markDirty();
      return;
    }

    if (state.rewire) {
      finishRewire(e);
      return;
    }

    // Preserve the known-working pin release behavior: the browser's actual event target
    // tells us whether the pointer was released on a pin.
    if (state.draftConnection) {
      const targetPin = e.target.closest?.('.pin');
      if (targetPin) completeConnection(targetPin.dataset.node, targetPin.dataset.pin);
      else {
        const p = screenToWorld(e.clientX, e.clientY);
        showAddNodeMenu(
          p,
          e.clientX,
          e.clientY,
          compatibleDefinitions(state.draftConnection.kind, state.draftConnection.node, state.draftConnection.pin),
          'Add Connected Node',
          { node: state.draftConnection.node, pin: state.draftConnection.pin, kind: state.draftConnection.kind }
        );
      }
      state.draftConnection = null;
      renderEdges();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (state.panning) {
      state.pan.x = state.panning.panX + (e.clientX - state.panning.startX);
      state.pan.y = state.panning.panY + (e.clientY - state.panning.startY);
      applyTransform();
      renderEdges();
      return;
    }
    if (state.selection) {
      updateGroupSelection(e);
      return;
    }
    if (state.dragging?.kind === 'nodes') {
      const p = screenToWorld(e.clientX, e.clientY);
      const dx = p.x - state.dragging.originX;
      const dy = p.y - state.dragging.originY;
      const moved = Math.abs(dx) > 1 || Math.abs(dy) > 1;
      state.dragging.moved = state.dragging.moved || moved;
      state.dragging.items.forEach(item => {
        item.node.position.x = item.startX + dx;
        item.node.position.y = item.startY + dy;
        const el = document.querySelector(`.node[data-node="${cssEscape(item.node.id)}"]`);
        if (el) {
          el.style.left = `${item.node.position.x}px`;
          el.style.top = `${item.node.position.y}px`;
        }
      });
      renderEdges();
      return;
    }
    if (state.rewire) {
      renderEdges({ x: e.clientX, y: e.clientY });
      return;
    }
    if (state.draftConnection) {
      renderEdges({ x: e.clientX, y: e.clientY });
    }
  });

  canvasWrap.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    const rect = canvasWrap.getBoundingClientRect();
    const before = {
      x: (e.clientX - rect.left - state.pan.x) / state.zoom,
      y: (e.clientY - rect.top - state.pan.y) / state.zoom
    };
    const scale = e.deltaY > 0 ? 0.9 : 1.1;
    state.zoom = Math.min(2.2, Math.max(0.45, state.zoom * scale));
    state.pan.x = e.clientX - rect.left - before.x * state.zoom;
    state.pan.y = e.clientY - rect.top - before.y * state.zoom;
    applyTransform();
    renderEdges();
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('resize', () => {
    renderEdges();
    if (!contextMenu.hidden) clampContextMenuToCanvas();
  });

  vscode.postMessage({ type: 'ready' });

  function setDefinitions(definitions) {
    state.definitions = definitions;
    state.defByType = new Map(definitions.map((d) => [d.type, d]));
    renderPalette();
  }

  function applySettings(message) {
    if (typeof message.saveDelay === 'number' && message.saveDelay >= 0) state.saveDelay = message.saveDelay;
  }

  function loadGraph(graph, preserveView = false) {
    state.graph = normalizeGraph(graph);
    graphName.textContent = state.graph.name;
    state.dirty = false;
    if (!preserveView) {
      state.pan = { x: 40, y: 40 };
      state.zoom = 1;
      state.selectedNodeIds.clear();
      state.selectedNodeId = null;
    }
    applyTransform();
    render();
  }

  function normalizeGraph(graph) {
    const g = JSON.parse(JSON.stringify(graph || {}));
    g.schemaVersion = g.schemaVersion || 1;
    g.name = g.name || 'NewGraph';
    g.language = g.language || 'javascript';
    g.variables = Array.isArray(g.variables) ? g.variables : [];
    g.nodes = Array.isArray(g.nodes) ? g.nodes : [];
    g.connections = Array.isArray(g.connections) ? g.connections : [];
    g.nodes.forEach(n => {
      n.properties = n.properties || {};
      n.position = n.position || { x: 0, y: 0 };
    });
    return g;
  }

  function render() {
    world.innerHTML = '';
    if (!state.graph) return;
    state.graph.nodes.forEach((node) => world.appendChild(renderNode(node)));
    applyTransform();
    renderEdges();
    renderInspector();
    syncSelectionClasses();
  }

  function renderNode(node) {
    const def = state.defByType.get(node.type) || fallbackDef(node);
    const el = document.createElement('div');
    el.className = 'node' + (state.selectedNodeIds.has(node.id) ? ' selected' : '') + (state.executedNodeIds.has(node.id) ? ' executing' : '');
    el.dataset.node = node.id;
    el.draggable = false;
    el.style.left = `${node.position.x}px`;
    el.style.top = `${node.position.y}px`;
    el.style.setProperty('--node-color', def.color || '#6b7280');

    const header = document.createElement('div');
    header.className = 'node-header';
    header.innerHTML = `<span class="node-title">${escapeHtml(def.displayName)}</span><span class="node-type">${escapeHtml(def.category)}</span>`;
    el.appendChild(header);

    const body = document.createElement('div');
    body.className = 'node-body';
    const left = document.createElement('div');
    left.className = 'pin-column left';
    const right = document.createElement('div');
    right.className = 'pin-column right';

    def.inputs.forEach(pin => left.appendChild(renderPin(node, pin)));
    def.outputs.forEach(pin => right.appendChild(renderPin(node, pin)));
    body.append(left, right);
    el.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'node-footer';
    if (def.description) footer.textContent = def.description;
    el.appendChild(footer);

    // The whole node body is draggable. Pin mousedown stops propagation and therefore
    // remains exclusively responsible for drawing a connection.
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.pin') || e.target.closest('input')) return;
      hideContextMenu();
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (additive && state.selectedNodeIds.has(node.id)) {
        // Modifier-click on a selected node removes it from the selection; no drag starts.
        selectNode(node.id, true);
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (additive) {
        state.selectedNodeIds.add(node.id);
        state.selectedNodeId = node.id;
      } else {
        if (!state.selectedNodeIds.has(node.id)) {
          state.selectedNodeIds = new Set([node.id]);
        }
        state.selectedNodeId = node.id;
      }
      syncSelectionClasses();
      renderInspector();
      beginNodeDrag(node, e);
      e.stopPropagation();
      e.preventDefault();
    });
    return el;
  }

  function startPinGesture(handle, node, pin, e) {
    if (e.button !== 0) return;

    // Keep the original working pin-drag path. Do not preventDefault here: the window-level
    // mousemove/mouseup listeners need the normal mouse event sequence.
    e.stopPropagation();
    state.selectedNodeId = node.id;
    if (!state.selectedNodeIds.has(node.id)) {
      state.selectedNodeIds = new Set([node.id]);
    }
    syncSelectionClasses();
    hideContextMenu();

    if (e.altKey) {
      disconnectPin(node.id, pin.id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      beginRewireFromPin(node.id, pin.id, e.clientX, e.clientY);
      return;
    }

    state.draftConnection = {
      node: node.id,
      pin: pin.id,
      kind: pin.kind,
      direction: pin.direction,
      startX: e.clientX,
      startY: e.clientY
    };
    renderEdges();
  }

  function renderPin(node, pin) {
    const row = document.createElement('div');
    row.className = `pin-row ${pin.kind} ${pin.direction}`;
    const label = document.createElement('span');
    label.className = 'pin-label';
    label.textContent = pin.name || (pin.kind === 'exec' ? '' : pin.id);

    const handle = document.createElement('span');
    handle.className = `pin ${pin.kind}`;
    handle.dataset.node = node.id;
    handle.dataset.pin = pin.id;
    handle.dataset.kind = pin.kind;
    handle.dataset.direction = pin.direction;
    handle.title = pin.kind === 'exec' ? 'Execution pin' : `${pin.name} (${pin.type?.id || 'any'})`;
    handle.addEventListener('mousedown', (e) => startPinGesture(handle, node, pin, e));
    handle.addEventListener('dragstart', (e) => e.preventDefault());

    if (pin.direction === 'input') row.append(handle, label);
    else row.append(label, handle);
    return row;
  }

  function renderEdges(pointer = null) {
    edges.innerHTML = '';
    if (!state.graph) return;
    const rect = canvasWrap.getBoundingClientRect();
    state.graph.connections.forEach((c) => {
      const source = document.querySelector(`.pin[data-node="${cssEscape(c.fromNode)}"][data-pin="${cssEscape(c.fromPin)}"]`);
      const target = document.querySelector(`.pin[data-node="${cssEscape(c.toNode)}"][data-pin="${cssEscape(c.toPin)}"]`);
      if (!source || !target) return;
      const a = centerOf(source, rect);
      const b = centerOf(target, rect);
      const ran = state.executedNodeIds.has(c.fromNode) && state.executedNodeIds.has(c.toNode);
      addPath(a, b, ran ? 'active' : '', c.id);
    });

    if (state.draftConnection) {
      const source = document.querySelector(`.pin[data-node="${cssEscape(state.draftConnection.node)}"][data-pin="${cssEscape(state.draftConnection.pin)}"]`);
      if (source) {
        const a = centerOf(source, rect);
        const b = pointer
          ? screenPointToWorld(pointer, rect)
          : screenPointToWorld({ x: state.draftConnection.startX, y: state.draftConnection.startY }, rect);
        addPath(a, b, 'draft');
      }
    }

    if (state.rewire) {
      const c = state.graph.connections.find(connection => connection.id === state.rewire.connectionId);
      if (c) {
        const source = document.querySelector(`.pin[data-node="${cssEscape(c.fromNode)}"][data-pin="${cssEscape(c.fromPin)}"]`);
        const target = document.querySelector(`.pin[data-node="${cssEscape(c.toNode)}"][data-pin="${cssEscape(c.toPin)}"]`);
        if (source && target) {
          const a = centerOf(source, rect);
          const b = centerOf(target, rect);
          const moving = pointer ? screenPointToWorld(pointer, rect) : screenPointToWorld({ x: state.rewire.startX, y: state.rewire.startY }, rect);
          if (state.rewire.side === 'from') addPath(moving, b, 'draft');
          else addPath(a, moving, 'draft');
        }
      }
    }
  }

  function addPath(a, b, className = '', connectionId = null) {
    const d = bezierPath(a, b);
    if (connectionId) {
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'edge-hit');
      hit.dataset.connectionId = connectionId;
      hit.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.button !== 0) return;
        if (e.altKey) {
          disconnectConnection(connectionId);
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          beginRewireFromConnection(connectionId, e.clientX, e.clientY);
        }
      });
      edges.appendChild(hit);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `edge ${className}`.trim());
    path.setAttribute('pointer-events', 'none');
    edges.appendChild(path);
  }

  function bezierPath(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.55);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  // DOM pin positions are screen pixels because #world is CSS transformed. Convert them back
  // to graph/world coordinates before drawing; the SVG receives the same transform.
  function centerOf(element, rect) {
    const r = element.getBoundingClientRect();
    return screenPointToWorld({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, rect);
  }

  function completeConnection(targetNodeId, targetPinId) {
    const draft = state.draftConnection;
    if (!draft) return;
    if (draft.node === targetNodeId && draft.pin === targetPinId) return;
    const sourceDef = pinDef(draft.node, draft.pin);
    const targetDef = pinDef(targetNodeId, targetPinId);
    if (!sourceDef || !targetDef) return;

    let fromNode = draft.node, fromPin = draft.pin, toNode = targetNodeId, toPin = targetPinId;
    if (draft.direction === 'input' && targetDef.direction === 'output') {
      fromNode = targetNodeId; fromPin = targetPinId; toNode = draft.node; toPin = draft.pin;
    }
    const okDirection = pinDef(fromNode, fromPin)?.direction === 'output' && pinDef(toNode, toPin)?.direction === 'input';
    if (!okDirection) return;

    const from = pinDef(fromNode, fromPin), to = pinDef(toNode, toPin);
    if (from?.kind !== to?.kind) return;
    if (from.kind === 'data' && !compatibleTypes(from.type?.id, to.type?.id)) return;

    state.graph.connections = state.graph.connections.filter(c => !(c.toNode === toNode && c.toPin === toPin));
    state.graph.connections.push({ id: newConnectionId(), fromNode, fromPin, toNode, toPin });
    markDirty();
    render();
  }

  function beginRewireFromPin(nodeId, pinId, clientX, clientY) {
    const pin = pinDef(nodeId, pinId);
    if (!pin) return;
    const candidates = state.graph.connections.filter(c =>
      (c.fromNode === nodeId && c.fromPin === pinId) || (c.toNode === nodeId && c.toPin === pinId)
    );
    if (!candidates.length) {
      setStatus('That pin has no connection to rewire.');
      return;
    }
    const selected = chooseNearestConnection(candidates, nodeId, pinId, clientX, clientY);
    const side = selected.fromNode === nodeId && selected.fromPin === pinId ? 'from' : 'to';
    state.rewire = { connectionId: selected.id, side, startX: clientX, startY: clientY };
    renderEdges({ x: clientX, y: clientY });
  }

  function beginRewireFromConnection(connectionId, clientX, clientY) {
    const connection = state.graph?.connections.find(c => c.id === connectionId);
    if (!connection) return;
    const rect = canvasWrap.getBoundingClientRect();
    const source = document.querySelector(`.pin[data-node="${cssEscape(connection.fromNode)}"][data-pin="${cssEscape(connection.fromPin)}"]`);
    const target = document.querySelector(`.pin[data-node="${cssEscape(connection.toNode)}"][data-pin="${cssEscape(connection.toPin)}"]`);
    if (!source || !target) return;
    const a = centerOf(source, rect);
    const b = centerOf(target, rect);
    const click = screenPointToWorld({ x: clientX, y: clientY }, rect);
    const side = distance(click, a) <= distance(click, b) ? 'from' : 'to';
    state.rewire = { connectionId, side, startX: clientX, startY: clientY };
    renderEdges({ x: clientX, y: clientY });
  }

  function chooseNearestConnection(connections, nodeId, pinId, clientX, clientY) {
    const rect = canvasWrap.getBoundingClientRect();
    let best = connections[0];
    let bestDistance = Infinity;
    connections.forEach(connection => {
      const oppositeNode = connection.fromNode === nodeId && connection.fromPin === pinId ? connection.toNode : connection.fromNode;
      const oppositePin = connection.fromNode === nodeId && connection.fromPin === pinId ? connection.toPin : connection.fromPin;
      const opposite = document.querySelector(`.pin[data-node="${cssEscape(oppositeNode)}"][data-pin="${cssEscape(oppositePin)}"]`);
      if (!opposite) return;
      const center = opposite.getBoundingClientRect();
      const d = Math.hypot(center.left + center.width / 2 - clientX, center.top + center.height / 2 - clientY);
      if (d < bestDistance) {
        bestDistance = d;
        best = connection;
      }
    });
    return best;
  }

  function finishRewire(e) {
    const rewire = state.rewire;
    if (!rewire) return;
    const targetPin = e.target.closest?.('.pin');
    if (!targetPin || !completeRewire(targetPin.dataset.node, targetPin.dataset.pin)) {
      disconnectConnection(rewire.connectionId);
    }
    state.rewire = null;
    renderEdges();
  }

  function completeRewire(targetNodeId, targetPinId) {
    const rewire = state.rewire;
    const connection = rewire && state.graph.connections.find(c => c.id === rewire.connectionId);
    if (!rewire || !connection) return false;
    const targetDef = pinDef(targetNodeId, targetPinId);
    if (!targetDef) return false;

    let fromNode = connection.fromNode;
    let fromPin = connection.fromPin;
    let toNode = connection.toNode;
    let toPin = connection.toPin;

    if (rewire.side === 'from') {
      fromNode = targetNodeId;
      fromPin = targetPinId;
    } else {
      toNode = targetNodeId;
      toPin = targetPinId;
    }

    if (fromNode === toNode && fromPin === toPin) return false;
    const from = pinDef(fromNode, fromPin);
    const to = pinDef(toNode, toPin);
    if (!from || !to || from.direction !== 'output' || to.direction !== 'input') return false;
    if (from.kind !== to.kind) return false;
    if (from.kind === 'data' && !compatibleTypes(from.type?.id, to.type?.id)) return false;

    state.graph.connections = state.graph.connections.filter(c => c.id === connection.id || !(c.toNode === toNode && c.toPin === toPin));
    connection.fromNode = fromNode;
    connection.fromPin = fromPin;
    connection.toNode = toNode;
    connection.toPin = toPin;
    markDirty();
    render();
    return true;
  }

  function disconnectPin(nodeId, pinId) {
    const before = state.graph.connections.length;
    state.graph.connections = state.graph.connections.filter(c =>
      !((c.fromNode === nodeId && c.fromPin === pinId) || (c.toNode === nodeId && c.toPin === pinId))
    );
    if (state.graph.connections.length !== before) {
      markDirty();
      render();
      setStatus('Pin disconnected.');
    }
  }

  function disconnectConnection(connectionId) {
    const before = state.graph.connections.length;
    state.graph.connections = state.graph.connections.filter(c => c.id !== connectionId);
    if (state.graph.connections.length !== before) {
      markDirty();
      renderEdges();
      setStatus('Connection removed.');
    }
  }

  function showAddNodeMenu(position, clientX, clientY, definitions, title, source = null) {
    if (!state.graph) return;
    const unique = [...new Map(definitions.map(def => [def.type, def])).values()];
    if (!unique.length) return;
    state.context = { kind: 'add-node', position, definitions: unique, title, source };
    contextMenu.innerHTML = `
      <div class="context-title">${escapeHtml(title)}</div>
      <input id="context-search" class="context-search" placeholder="Search nodes…" aria-label="Search nodes">
      <div id="context-results"></div>`;
    contextMenu.hidden = false;
    positionContextMenu(clientX, clientY);
    const input = contextMenu.querySelector('#context-search');
    input.addEventListener('input', () => renderContextNodeResults(input.value));
    renderContextNodeResults('');
    requestAnimationFrame(() => input.focus());
  }

  function renderContextNodeResults(query) {
    if (!state.context || state.context.kind !== 'add-node') return;
    const result = contextMenu.querySelector('#context-results');
    if (!result) return;
    const q = query.trim().toLowerCase();
    const defs = state.context.definitions.filter(def =>
      `${def.displayName} ${def.category} ${def.description || ''}`.toLowerCase().includes(q)
    ).slice(0, 18);
    result.innerHTML = '';
    if (!defs.length) {
      result.innerHTML = '<div class="context-empty">No matching nodes</div>';
      return;
    }
    defs.forEach(def => {
      const button = document.createElement('button');
      button.className = 'context-node';
      button.innerHTML = `<span class="palette-dot" style="--node-color:${escapeHtml(def.color || '#6b7280')}"></span><span><strong>${escapeHtml(def.displayName)}</strong><small>${escapeHtml(def.category)}</small></span>`;
      button.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const pos = state.context.position;
        const sourceContext = state.context.source;
        const id = addNode(def.type, pos);
        if (sourceContext) {
          const node = state.graph.nodes.find(n => n.id === id);
          const sourceDef = pinDef(sourceContext.node, sourceContext.pin);
          if (node && sourceDef) {
            const candidate = sourceDef.direction === 'output'
              ? def.inputs.find(p => p.kind === sourceContext.kind && (sourceContext.kind === 'exec' || compatibleTypes(sourceDef.type?.id, p.type?.id)))
              : def.outputs.find(p => p.kind === sourceContext.kind && (sourceContext.kind === 'exec' || compatibleTypes(p.type?.id, sourceDef.type?.id)));
            if (candidate) {
              if (sourceDef.direction === 'output') {
                state.graph.connections = state.graph.connections.filter(c => !(c.toNode === id && c.toPin === candidate.id));
                state.graph.connections.push({ id: newConnectionId(), fromNode: sourceContext.node, fromPin: sourceContext.pin, toNode: id, toPin: candidate.id });
              } else {
                state.graph.connections = state.graph.connections.filter(c => !(c.toNode === sourceContext.node && c.toPin === sourceContext.pin));
                state.graph.connections.push({ id: newConnectionId(), fromNode: id, fromPin: candidate.id, toNode: sourceContext.node, toPin: sourceContext.pin });
              }
              markDirty();
              render();
            }
          }
        }
        state.context = null;
        hideContextMenu();
      });
      result.appendChild(button);
    });
  }

  function showNodeContextMenu(nodeId, clientX, clientY) {
    const node = state.graph.nodes.find(n => n.id === nodeId);
    const def = node && (state.defByType.get(node.type) || fallbackDef(node));
    if (!node || !def) return;
    contextMenu.innerHTML = `
      <div class="context-title">${escapeHtml(def.displayName)}</div>
      <button data-action="duplicate">Duplicate</button>
      <button data-action="disconnect">Disconnect All Connections</button>
      <button data-action="select-connected">Select Connected Nodes</button>
      <button data-action="center">Center View</button>
      <div class="context-separator"></div>
      <button data-action="delete" class="context-danger">Delete Node</button>`;
    state.context = { kind: 'node', nodeId };
    contextMenu.hidden = false;
    positionContextMenu(clientX, clientY);
    contextMenu.querySelectorAll('button[data-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'duplicate') duplicateSelected();
        else if (action === 'disconnect') disconnectSelected();
        else if (action === 'select-connected') selectConnected(nodeId);
        else if (action === 'center') centerOnNode(nodeId);
        else if (action === 'delete') deleteSelected();
        hideContextMenu();
      });
    });
  }

  function positionContextMenu(clientX, clientY) {
    const rect = canvasWrap.getBoundingClientRect();
    contextMenu.style.left = `${Math.max(4, clientX - rect.left)}px`;
    contextMenu.style.top = `${Math.max(4, clientY - rect.top)}px`;
    requestAnimationFrame(clampContextMenuToCanvas);
  }

  function clampContextMenuToCanvas() {
    const rect = canvasWrap.getBoundingClientRect();
    const menu = contextMenu.getBoundingClientRect();
    const currentLeft = parseFloat(contextMenu.style.left || '0');
    const currentTop = parseFloat(contextMenu.style.top || '0');
    const maxLeft = Math.max(4, rect.width - menu.width - 4);
    const maxTop = Math.max(4, rect.height - menu.height - 4);
    contextMenu.style.left = `${Math.min(currentLeft, maxLeft)}px`;
    contextMenu.style.top = `${Math.min(currentTop, maxTop)}px`;
  }

  function hideContextMenu() {
    contextMenu.hidden = true;
    state.context = null;
  }

  function compatibleDefinitions(kind, fromNodeId, fromPinId) {
    const p = pinDef(fromNodeId, fromPinId);
    if (!p) return [];
    return state.definitions.filter(def => {
      const targets = p.direction === 'output' ? def.inputs : def.outputs;
      return targets.some(t => t.kind === kind && (kind === 'exec' || compatibleTypes(p.type?.id, t.type?.id)));
    });
  }

  function addNode(type, position) {
    if (!state.graph) return null;
    const def = state.defByType.get(type);
    const node = {
      id: `${slug(type)}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      position: { x: position.x, y: position.y },
      properties: {}
    };
    (def?.inputs || []).forEach(pin => {
      if (pin.kind === 'data' && pin.defaultValue !== undefined) node.properties[`pin:${pin.id}`] = pin.defaultValue;
    });
    state.graph.nodes.push(node);
    state.selectedNodeIds = new Set([node.id]);
    state.selectedNodeId = node.id;
    markDirty();
    render();
    return node.id;
  }

  function beginNodeDrag(node, e) {
    const p = screenToWorld(e.clientX, e.clientY);
    const selectedIds = state.selectedNodeIds.has(node.id) ? [...state.selectedNodeIds] : [node.id];
    if (!state.selectedNodeIds.has(node.id)) {
      state.selectedNodeIds = new Set([node.id]);
      state.selectedNodeId = node.id;
      renderInspector();
      syncSelectionClasses();
    }
    state.dragging = {
      kind: 'nodes',
      originX: p.x,
      originY: p.y,
      items: selectedIds.map(id => {
        const selected = state.graph.nodes.find(n => n.id === id);
        return { node: selected, startX: selected.position.x, startY: selected.position.y };
      }).filter(item => item.node),
      moved: false
    };
  }

  function beginGroupSelection(e) {
    if (!state.graph) return;
    state.draftConnection = null;
    state.rewire = null;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Set(state.selectedNodeIds) : new Set();
    if (!additive) {
      state.selectedNodeIds.clear();
      state.selectedNodeId = null;
      syncSelectionClasses();
    }
    state.selection = {
      startX: e.clientX,
      startY: e.clientY,
      additive,
      base
    };
    updateSelectionBox(e.clientX, e.clientY);
    e.preventDefault();
  }

  function updateGroupSelection(e) {
    if (!state.selection) return;
    const dx = e.clientX - state.selection.startX;
    const dy = e.clientY - state.selection.startY;
    const moved = Math.abs(dx) > 3 || Math.abs(dy) > 3;
    const box = selectionRectFromClients(state.selection.startX, state.selection.startY, e.clientX, e.clientY);
    state.selection.moved = moved;
    updateSelectionBox(e.clientX, e.clientY);
    if (!moved) return;

    const hits = new Set();
    state.graph.nodes.forEach(node => {
      const el = document.querySelector(`.node[data-node="${cssEscape(node.id)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (rectsIntersect(box, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })) hits.add(node.id);
    });
    state.selectedNodeIds = state.selection.additive ? new Set([...state.selection.base, ...hits]) : hits;
    state.selectedNodeId = state.selectedNodeIds.has(state.selectedNodeId) ? state.selectedNodeId : [...state.selectedNodeIds][0] || null;
    syncSelectionClasses();
    renderInspector();
  }

  function finishGroupSelection() {
    if (!state.selection) return;
    hideSelectionBox();
    const moved = state.selection.moved;
    state.selection = null;
    if (!moved) {
      renderInspector();
    } else {
      setStatus(`${state.selectedNodeIds.size} node${state.selectedNodeIds.size === 1 ? '' : 's'} selected`);
    }
  }

  function selectionRectFromClients(startX, startY, endX, endY) {
    return {
      left: Math.min(startX, endX),
      top: Math.min(startY, endY),
      right: Math.max(startX, endX),
      bottom: Math.max(startY, endY)
    };
  }

  function rectsIntersect(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  function updateSelectionBox(endX, endY) {
    if (!state.selection) return;
    const rect = canvasWrap.getBoundingClientRect();
    const left = Math.min(state.selection.startX, endX) - rect.left;
    const top = Math.min(state.selection.startY, endY) - rect.top;
    const width = Math.abs(endX - state.selection.startX);
    const height = Math.abs(endY - state.selection.startY);
    selectionBox.hidden = false;
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
  }

  function hideSelectionBox() {
    selectionBox.hidden = true;
  }

  function selectNode(nodeId, additive = false, primary = false) {
    if (additive) {
      if (state.selectedNodeIds.has(nodeId)) state.selectedNodeIds.delete(nodeId);
      else state.selectedNodeIds.add(nodeId);
    } else {
      state.selectedNodeIds = new Set([nodeId]);
    }
    if (primary || !state.selectedNodeId || !state.selectedNodeIds.has(state.selectedNodeId)) state.selectedNodeId = nodeId;
    if (!state.selectedNodeIds.size) state.selectedNodeId = null;
    syncSelectionClasses();
    renderInspector();
  }

  function selectAllNodes() {
    state.selectedNodeIds = new Set(state.graph?.nodes.map(n => n.id) || []);
    state.selectedNodeId = [...state.selectedNodeIds][0] || null;
    syncSelectionClasses();
    renderInspector();
  }

  function selectConnected(startNodeId) {
    const selected = new Set([startNodeId]);
    const queue = [startNodeId];
    while (queue.length) {
      const current = queue.shift();
      state.graph.connections.forEach(c => {
        let next = null;
        if (c.fromNode === current) next = c.toNode;
        else if (c.toNode === current) next = c.fromNode;
        if (next && !selected.has(next)) {
          selected.add(next);
          queue.push(next);
        }
      });
    }
    state.selectedNodeIds = selected;
    state.selectedNodeId = startNodeId;
    syncSelectionClasses();
    renderInspector();
    setStatus(`${selected.size} connected node${selected.size === 1 ? '' : 's'} selected`);
  }

  function duplicateSelected() {
    const selected = state.graph.nodes.filter(n => state.selectedNodeIds.has(n.id));
    if (!selected.length) return;
    const remap = new Map();
    const copies = selected.map(node => {
      const newId = `${slug(node.type)}_${Math.random().toString(36).slice(2, 8)}`;
      remap.set(node.id, newId);
      return {
        ...JSON.parse(JSON.stringify(node)),
        id: newId,
        position: { x: node.position.x + 35, y: node.position.y + 35 }
      };
    });
    const internalConnections = state.graph.connections
      .filter(c => remap.has(c.fromNode) && remap.has(c.toNode))
      .map(c => ({
        id: newConnectionId(),
        fromNode: remap.get(c.fromNode),
        fromPin: c.fromPin,
        toNode: remap.get(c.toNode),
        toPin: c.toPin
      }));
    state.graph.nodes.push(...copies);
    state.graph.connections.push(...internalConnections);
    state.selectedNodeIds = new Set(copies.map(n => n.id));
    state.selectedNodeId = copies[0].id;
    markDirty();
    render();
    setStatus(`${copies.length} node${copies.length === 1 ? '' : 's'} duplicated`);
  }

  function disconnectSelected() {
    const selected = state.selectedNodeIds;
    const before = state.graph.connections.length;
    state.graph.connections = state.graph.connections.filter(c => !selected.has(c.fromNode) && !selected.has(c.toNode));
    if (state.graph.connections.length !== before) {
      markDirty();
      render();
    }
  }

  function centerOnNode(nodeId) {
    const node = state.graph.nodes.find(n => n.id === nodeId);
    if (!node) return;
    const rect = canvasWrap.getBoundingClientRect();
    state.pan.x = rect.width / 2 - (node.position.x + 125) * state.zoom;
    state.pan.y = rect.height / 2 - (node.position.y + 80) * state.zoom;
    applyTransform();
    renderEdges();
  }

  function renderPalette() {
    categories.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const filtered = state.definitions.filter(d => `${d.displayName} ${d.category} ${d.description || ''}`.toLowerCase().includes(q));
    const grouped = new Map();
    filtered.forEach(d => {
      if (!grouped.has(d.category)) grouped.set(d.category, []);
      grouped.get(d.category).push(d);
    });
    [...grouped.entries()].sort().forEach(([category, defs]) => {
      const section = document.createElement('section');
      const title = document.createElement('div');
      title.className = 'category-title';
      title.textContent = category;
      section.appendChild(title);
      defs.forEach(def => {
        const button = document.createElement('button');
        button.className = 'palette-node';
        button.innerHTML = `<span class="palette-dot" style="--node-color:${escapeHtml(def.color || '#6b7280')}"></span><span><strong>${escapeHtml(def.displayName)}</strong><small>${escapeHtml(def.description || '')}</small></span>`;
        button.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const rect = canvasWrap.getBoundingClientRect();
          const p = screenToWorld(rect.left + canvasWrap.clientWidth / 2, rect.top + 120);
          addNode(def.type, p);
        });
        section.appendChild(button);
      });
      categories.appendChild(section);
    });
  }

  function renderInspector() {
    const node = state.graph?.nodes.find(n => n.id === state.selectedNodeId);
    if (!node) {
      inspector.innerHTML = state.selectedNodeIds.size > 1
        ? `<div class="muted">${state.selectedNodeIds.size} nodes selected.</div>`
        : '<div class="muted">Select a node to edit defaults.</div>';
      return;
    }
    const def = state.defByType.get(node.type) || fallbackDef(node);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<div class="inspector-name">${escapeHtml(def.displayName)}</div><div class="muted inspector-type">${escapeHtml(node.type)}</div>`;
    const group = document.createElement('div');
    group.className = 'inspector-fields';
    (def.inputs || []).filter(p => p.kind === 'data').forEach(pin => {
      const connected = state.graph.connections.some(c => c.toNode === node.id && c.toPin === pin.id);
      const row = document.createElement('label');
      row.className = 'field';
      const text = document.createElement('span');
      text.textContent = `${pin.name} (${pin.type?.id || 'any'})`;
      const input = document.createElement('input');
      input.disabled = connected;
      const value = node.properties[`pin:${pin.id}`] ?? '';
      if (pin.type?.id === 'bool') {
        input.type = 'checkbox'; input.checked = Boolean(value);
      } else if (pin.type?.id === 'number' || pin.type?.id === 'int' || pin.type?.id === 'float') {
        input.type = 'number'; input.value = String(value);
      } else {
        input.type = 'text'; input.value = String(value);
      }
      input.addEventListener('input', () => {
        node.properties[`pin:${pin.id}`] = input.type === 'checkbox' ? input.checked : (input.type === 'number' ? Number(input.value) : input.value);
        markDirty();
      });
      row.append(text, input);
      group.appendChild(row);
    });
    wrapper.appendChild(group);
    const deleteButton = document.createElement('button');
    deleteButton.className = 'danger';
    deleteButton.textContent = state.selectedNodeIds.size > 1 ? `Delete ${state.selectedNodeIds.size} Nodes` : 'Delete Node';
    deleteButton.addEventListener('click', deleteSelected);
    wrapper.appendChild(deleteButton);
    inspector.innerHTML = '';
    inspector.appendChild(wrapper);
  }

  function deleteSelected() {
    if (!state.graph || !state.selectedNodeIds.size) return;
    const ids = new Set(state.selectedNodeIds);
    state.graph.nodes = state.graph.nodes.filter(n => !ids.has(n.id));
    state.graph.connections = state.graph.connections.filter(c => !ids.has(c.fromNode) && !ids.has(c.toNode));
    state.selectedNodeIds.clear();
    state.selectedNodeId = null;
    markDirty();
    render();
  }

  function syncSelectionClasses() {
    document.querySelectorAll('.node').forEach(el => {
      const selected = state.selectedNodeIds.has(el.dataset.node);
      el.classList.toggle('selected', selected);
    });
  }

  function markDirty() {
    state.dirty = true;
    setStatus('Unsaved changes');
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, state.saveDelay);
  }

  function flushSave() {
    if (!state.graph || !state.dirty) return;
    clearTimeout(state.saveTimer);
    state.dirty = false;
    vscode.postMessage({ type: 'applyGraph', graph: state.graph });
    setStatus('Saved');
  }

  function setStatus(text) { status.textContent = text; }

  function pinDef(nodeId, pinId) {
    const node = state.graph?.nodes.find(n => n.id === nodeId);
    const def = node && (state.defByType.get(node.type) || fallbackDef(node));
    return def && [...def.inputs, ...def.outputs].find(p => p.id === pinId);
  }

  function compatibleTypes(a, b) {
    return a === b || a === 'any' || b === 'any' || (a === 'int' && b === 'number') || (a === 'float' && b === 'number') || (a === 'number' && ['int', 'float'].includes(b));
  }

  function screenToWorld(clientX, clientY) {
    const rect = canvasWrap.getBoundingClientRect();
    return { x: (clientX - rect.left - state.pan.x) / state.zoom, y: (clientY - rect.top - state.pan.y) / state.zoom };
  }

  function screenPointToWorld(point, rect = canvasWrap.getBoundingClientRect()) {
    return {
      x: (point.x - rect.left - state.pan.x) / state.zoom,
      y: (point.y - rect.top - state.pan.y) / state.zoom
    };
  }

  function applyTransform() {
    world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    edges.style.transformOrigin = '0 0';
    edges.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  }

  function fitGraph() {
    if (!state.graph?.nodes.length) return;
    const xs = state.graph.nodes.map(n => n.position.x), ys = state.graph.nodes.map(n => n.position.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs) + 260, minY = Math.min(...ys), maxY = Math.max(...ys) + 180;
    const rect = canvasWrap.getBoundingClientRect();
    state.zoom = Math.min(1.3, Math.max(0.6, Math.min(rect.width / (maxX - minX + 120), rect.height / (maxY - minY + 120))));
    state.pan.x = (rect.width - (maxX - minX) * state.zoom) / 2 - minX * state.zoom;
    state.pan.y = (rect.height - (maxY - minY) * state.zoom) / 2 - minY * state.zoom;
    applyTransform();
    renderEdges();
  }

  function handleRuntimeEvent(event) {
    if (!event) return;
    if (!state.runActive) {
      // First event of a new run (which may have been started from another panel).
      state.runActive = true;
      clearTimeout(state.runtimeClearTimer);
      state.executedNodeIds.clear();
    }
    if (event.kind === 'node.enter' && event.nodeId) state.executedNodeIds.add(event.nodeId);
    // A graph-level error (no nodeId) ends the run without a graph.complete event.
    if (event.kind === 'graph.complete' || (event.kind === 'error' && !event.nodeId)) {
      state.runActive = false;
      state.runtimeClearTimer = setTimeout(() => {
        state.executedNodeIds.clear();
        scheduleRuntimePaint();
      }, RUN_TRAIL_MS);
    }
    scheduleRuntimePaint();
    if (event.kind === 'log') setStatus(`Print: ${event.message}`);
    if (event.kind === 'error') setStatus(`Error: ${event.message}`);
    if (event.kind === 'graph.complete') setStatus('Run complete');
  }

  // Repaints only the run highlight, at most once per frame, instead of rebuilding the canvas.
  function scheduleRuntimePaint() {
    if (state.runtimePaintPending) return;
    state.runtimePaintPending = true;
    requestAnimationFrame(() => {
      state.runtimePaintPending = false;
      document.querySelectorAll('.node').forEach(el => el.classList.toggle('executing', state.executedNodeIds.has(el.dataset.node)));
      renderEdges();
    });
  }

  function fallbackDef(node) {
    return { type: node.type, version: 1, displayName: node.type, category: 'Unknown', inputs: [], outputs: [], color: '#6b7280' };
  }

  function newConnectionId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function slug(text) { return String(text).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
  function escapeHtml(text) { return String(text).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
  function cssEscape(text) { return String(text).replace(/(["\\#\.\[\]:])/g, '\\$1'); }
})();
