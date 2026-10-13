// A small menu at the pointer, usable anywhere in the editor (the canvas's action menu lives inside
// the canvas). Used for My Blueprint items and for choosing Get or Set when dropping a variable.
import { dom } from './dom';

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

export function showFloatingMenu(items: MenuItem[], clientX: number, clientY: number): void {
  const menu = dom.floatingMenu;
  menu.innerHTML = '';
  for (const item of items) {
    const button = document.createElement('button');
    button.textContent = item.label;
    if (item.danger) button.className = 'danger-item';
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideFloatingMenu();
      item.action();
    });
    menu.appendChild(button);
  }
  menu.hidden = false;
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  // Keep it on screen.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - rect.height - 4))}px`;
}

export function hideFloatingMenu(): void {
  dom.floatingMenu.hidden = true;
}

window.addEventListener('mousedown', (e) => {
  if (!dom.floatingMenu.hidden && !(e.target instanceof Node && dom.floatingMenu.contains(e.target))) hideFloatingMenu();
});
