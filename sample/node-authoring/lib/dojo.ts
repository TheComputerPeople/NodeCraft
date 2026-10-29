// A class from the project's code, used from graphs (docs/node-authoring.md, gap 2): its
// constructor, methods and property become nodes with a Target pin.

/** Someone training at the dojo. */
export class Trainee {
  /**
   * How much health the trainee has.
   * @blueprint
   */
  health = 0;

  /** @blueprint */
  constructor(start: number) {
    this.health = start;
  }

  /**
   * Trains for some hours, gaining a point of health an hour.
   * @blueprint
   */
  train(hours: number): number {
    this.health += hours;
    return this.health;
  }

  /**
   * The health's tens and units, as two outputs (gap 3).
   * @blueprint
   */
  split(): { tens: number; units: number } {
    return { tens: Math.floor(this.health / 10), units: this.health % 10 };
  }

  /**
   * Rests a while, then gives the health: a latent node (gap 4).
   * @blueprint
   */
  async rest(seconds: number): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return this.health;
  }
}
