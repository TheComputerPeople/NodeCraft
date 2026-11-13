// A small menu at the pointer, usable anywhere in the editor (the canvas's action menu lives inside
// the canvas). Used for My Blueprint items and for choosing Get or Set when dropping a variable.
import { dom } from './dom';

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

// Where focus was when the menu opened, to go back to when it closes.
let returnFocus: HTMLElement | null = null;

export function showFloatingMenu(items: MenuItem[], clientX: number, clientY: number): void {
  const menu = dom.floatingMenu;
  menu.innerHTML = '';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Actions');
  returnFocus = document.activeElement instanceof HTMLElement && !menu.contains(document.activeElement) ? document.activeElement : null;
  for (const item of items) {
    const button = document.createElement('button');
    button.textContent = item.label;
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    if (item.danger) button.className = 'danger-item';
    const choose = () => {
      hideFloatingMenu();
      item.action();
    };
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      choose();
    });
    // Enter and Space (a click with no pointer: docs/release.md, step 6).
    button.addEventListener('click', (e) => {
      if (e.detail === 0) choose();
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
  menu.querySelector<HTMLButtonElement>('button')?.focus();
}

export function hideFloatingMenu(): void {
  const hadFocus = dom.floatingMenu.contains(document.activeElement);
  dom.floatingMenu.hidden = true;
  if (hadFocus && returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}

// The arrow keys, Home and End move through the items; Escape and Tab close the menu.
dom.floatingMenu.addEventListener('keydown', (e) => {
  const items = [...dom.floatingMenu.querySelectorAll<HTMLButtonElement>('button')];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length
    : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
    : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : undefined;
  if (next !== undefined && items.length) {
    items[next].focus();
    e.preventDefault();
    e.stopPropagation();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    hideFloatingMenu();
    e.preventDefault();
    e.stopPropagation();
  }
});

window.addEventListener('mousedown', (e) => {
  if (!dom.floatingMenu.hidden && !(e.target instanceof Node && dom.floatingMenu.contains(e.target))) hideFloatingMenu();
});
