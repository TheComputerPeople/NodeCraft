// A class of the library's that graph classes extend: a template method (turn) calling overridable
// methods (hit, and describe, which a subclass replaces).
/** @blueprint */
export class Actor {
  /**
   * @blueprint
   * @type {number}
   */
  health = 100;
  /** @type {string} */
  name;

  /**
   * @blueprint
   * @param {string} name
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * @blueprint
   * @returns {string}
   */
  greet() {
    return `${this.name} has ${this.health}`;
  }

  /**
   * @blueprint overridable
   * @param {number} damage
   */
  hit(damage) {
    this.health -= damage;
    console.log(`${this.name} takes ${damage}`);
  }

  /**
   * @blueprint overridable
   * @returns {string}
   */
  describe() {
    return 'someone';
  }

  /** @blueprint */
  turn() {
    console.log(`${this.name} is ${this.describe()}`);
    this.hit(3);
    console.log(this.greet());
  }
}
