// Compile state in the toolbar, the Compiler Results panel and node badges, modeled on Unreal's
// Compile button and Compiler Results tab.
import { CompileDiagnostic } from '../core/compiler/diagnostics';
import { definitionFor } from '../core/editing';
import { CompileReport } from '../core/model';
import { lookupDefinition, markDirty } from './document';
import { dom, setStatus } from './dom';
import { render } from './render';
import { selectNode } from './selection';
import { state } from './state';
import { centerOnNode } from './view';

const BUTTON_TITLES: Record<typeof state.compileState, string> = {
  unknown: 'Compile the graph to its target language',
  dirty: 'The graph changed since it was last compiled. Compile it.',
  compiling: 'Compiling…',
  ok: 'Compiled and up to date',
  warnings: 'Compiled with warnings',
  errors: 'Compile failed; see Compiler Results'
};

export function showCompileResult(report: CompileReport): void {
  state.compile = report;
  state.compileState = report.status;
  renderCompileButton();
  renderResults();
  // Redraw so node badges reflect the new diagnostics.
  render();
  const errors = report.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = report.diagnostics.length - errors;
  if (errors) setStatus(`Compile failed: ${count(errors, 'error')}`);
  else if (warnings) setStatus(`Compiled to ${report.outputFile ?? 'code'} with ${count(warnings, 'warning')}`);
  else setStatus(`Compiled to ${report.outputFile ?? 'code'}`);
}

export function markCompileDirty(): void {
  if (state.compileState === 'dirty') return;
  state.compileState = 'dirty';
  renderCompileButton();
}

export function markCompiling(): void {
  state.compileState = 'compiling';
  renderCompileButton();
}

export function renderCompileButton(): void {
  dom.compileButton.dataset.state = state.compileState;
  dom.compileButton.title = BUTTON_TITLES[state.compileState];
}

// Diagnostics about `nodeId` in the graph on screen.
export function nodeDiagnostics(nodeId: string): CompileDiagnostic[] {
  return state.compile?.diagnostics.filter((d) => d.nodeId === nodeId && (!d.graphId || d.graphId === state.graph?.id)) ?? [];
}

export function hideResults(): void {
  dom.results.hidden = true;
}

function renderResults(): void {
  const diagnostics = state.compile?.diagnostics ?? [];
  dom.resultsList.innerHTML = '';
  // Like Unreal, the panel opens when there is something to report and stays out of the way otherwise.
  dom.results.hidden = diagnostics.length === 0;
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  dom.resultsTitle.textContent = `Compiler Results: ${count(errors, 'error')}, ${count(diagnostics.length - errors, 'warning')}`;
  for (const d of [...diagnostics].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))) {
    const item = document.createElement('li');
    const severity = document.createElement('span');
    severity.className = `result-severity ${d.severity}`;
    severity.textContent = d.severity === 'error' ? 'Error' : 'Warning';
    item.appendChild(severity);
    const node = d.nodeId && (!d.graphId || d.graphId === state.graph?.id) ? state.graph?.nodes.find((n) => n.id === d.nodeId) : undefined;
    if (node) {
      const label = document.createElement('span');
      label.className = 'result-node';
      label.textContent = `[${definitionFor(node, lookupDefinition).displayName}]`;
      item.appendChild(label);
      item.classList.add('has-node');
      item.title = 'Select this node';
      item.addEventListener('click', () => {
        selectNode(node.id, false, true);
        centerOnNode(node.id);
      });
    }
    const message = document.createElement('span');
    message.textContent = d.message;
    item.appendChild(message);
    dom.resultsList.appendChild(item);
  }
}

export function renderLanguagePicker(): void {
  const select = dom.languageSelect;
  const current = state.document?.language ?? '';
  select.innerHTML = '';
  const options = [...state.languages];
  if (current && !options.some((o) => o.id === current)) options.push({ id: current, displayName: `${current} (not available)` });
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.displayName;
    select.appendChild(el);
  }
  select.value = current;
  select.disabled = !state.document;
}

export function setLanguage(language: string): void {
  if (!state.document || state.document.language === language) return;
  state.document.language = language;
  markDirty();
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
