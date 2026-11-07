/** @blueprint pure */
export function title(name: string): string {
  return name.slice(0, 1).toUpperCase() + name.slice(1);
}
