/**
 * @blueprint pure
 * @param {string} name
 * @returns {string}
 */
export function title(name) {
  return name.slice(0, 1).toUpperCase() + name.slice(1);
}
