// A class from the project's code, used from graphs (docs/node-authoring.md, gap 2): its
// constructor, methods and property become nodes with a Target pin.

/** A running total. */
export class Tally {
  /**
   * The total so far.
   * @blueprint
   */
  total = 0;

  /** @blueprint */
  constructor(start: number) {
    this.total = start;
  }

  /**
   * Adds an amount to the total, and gives the new total.
   * @blueprint
   */
  add(amount: number): number {
    this.total += amount;
    return this.total;
  }

  /**
   * The total's tens and units, as two outputs (gap 3).
   * @blueprint
   */
  split(): { tens: number; units: number } {
    return { tens: Math.floor(this.total / 10), units: this.total % 10 };
  }

  /**
   * Waits a while, then gives the total: a latent node (gap 4).
   * @blueprint
   */
  async settle(seconds: number): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return this.total;
  }
}
