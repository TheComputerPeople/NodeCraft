// Project functions exposed as nodes: the @blueprint tag puts them in the palette
// (docs/code-as-nodes.md). Try them in a JavaScript or TypeScript graph.

/**
 * Subtracts damage from health, never going below zero.
 * @blueprint
 * @category Combat
 * @param {number} health
 * @param {number} amount
 * @returns {number}
 */
export function applyDamage(health, amount = 10) {
  return Math.max(0, health - amount);
}

/**
 * True while health is above zero.
 * @blueprint pure
 * @category Combat
 * @param {number} health
 * @returns {boolean}
 */
export function isAlive(health) {
  return health > 0;
}
