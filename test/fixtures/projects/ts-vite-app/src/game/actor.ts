// A class of the app's that graph classes extend: a template method (turn) calling an overridable
// method (hit) and an abstract one (describe).
/** @blueprint */
export abstract class Actor {
  /** @blueprint */
  health = 100;
  readonly name: string;

  /** @blueprint */
  protected constructor(name: string) {
    this.name = name;
  }

  /** @blueprint */
  greet(): string {
    return `${this.name} has ${String(this.health)}`;
  }

  /** @blueprint overridable */
  hit(damage: number): void {
    this.health -= damage;
    console.log(`${this.name} takes ${String(damage)}`);
  }

  /** @blueprint */
  abstract describe(): string;

  /** @blueprint */
  turn(): void {
    console.log(`${this.name} is ${this.describe()}`);
    this.hit(3);
    console.log(this.greet());
  }
}
