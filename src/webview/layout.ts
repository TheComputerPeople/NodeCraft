// The side panels' layout (docs/roadmap.md, Phase 5's narrow-editor issue). My Blueprint with the
// Palette, and Details, each collapse to a strip, by their buttons or, while the user hasn't chosen,
// when the editor is too narrow for them: Details first, as the canvas matters most.
import { loadViewState, saveViewState } from './host';

type Panel = 'left' | 'details';

// Below these editor widths a panel collapses unless the user opened it.
const AUTO_COLLAPSE: Record<Panel, number> = { details: 760, left: 540 };

const app = document.getElementById('app')!;
// The user's choice for each panel (true: collapsed), kept with the webview's state.
const chosen: Partial<Record<Panel, boolean>> = loadViewState<Partial<Record<Panel, boolean>>>('panels') ?? {};

export function isCollapsed(panel: Panel): boolean {
  return app.classList.contains(`${panel}-collapsed`);
}

function apply(): void {
  for (const panel of ['left', 'details'] as const) {
    const collapsed = chosen[panel] ?? window.innerWidth < AUTO_COLLAPSE[panel];
    app.classList.toggle(`${panel}-collapsed`, collapsed);
    for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-panel-toggle="${panel}"]`)) button.setAttribute('aria-expanded', String(!collapsed));
  }
}

function toggle(panel: Panel): void {
  chosen[panel] = !isCollapsed(panel);
  saveViewState('panels', chosen);
  apply();
  // The canvas changed size: wires and menus are placed in its coordinates.
  window.dispatchEvent(new Event('resize'));
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-panel-toggle]')) {
  button.addEventListener('click', () => toggle(button.dataset.panelToggle as Panel));
}
window.addEventListener('resize', apply);
apply();
