// The project's own classes and functions its graphs use: a class with a subclass, a function with
// several results, a generic one and an async one.
export class Counter {
  /**
   * @blueprint
   * @type {number}
   */
  count = 0;

  /**
   * @blueprint
   * @param {number} start
   */
  constructor(start) {
    this.count = start;
  }

  /**
   * @blueprint
   * @param {number} amount
   * @returns {number}
   */
  add(amount) {
    this.count += amount;
    return this.count;
  }

  /**
   * @blueprint pure
   * @returns {number}
   */
  get doubled() {
    return this.count * 2;
  }
}

export class BigCounter extends Counter {
  /**
   * @blueprint
   * @param {number} start
   */
  constructor(start) {
    super(start * 10);
  }
}

/**
 * @blueprint
 * @param {number} a
 * @param {number} b
 * @returns {[number, number]}
 * @outputs quotient remainder
 */
export function divide(a, b) {
  return [Math.floor(a / b), a % b];
}

/**
 * @blueprint
 * @template T
 * @param {T[]} items
 * @returns {T}
 */
export function first(items) {
  return items[0];
}

/**
 * @blueprint
 * @param {number} value
 * @returns {Promise<number>}
 */
export function fetchDouble(value) {
  return new Promise((resolve) => setTimeout(() => resolve(value * 2), 10));
}
