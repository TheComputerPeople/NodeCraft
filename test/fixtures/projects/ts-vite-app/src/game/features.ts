// The app's own classes and functions its graphs use: a class with a subclass, a function with
// several results, a generic one and an async one.
export class Counter {
  /** @blueprint */
  count = 0;

  /** @blueprint */
  constructor(start: number) {
    this.count = start;
  }

  /** @blueprint */
  add(amount: number): number {
    this.count += amount;
    return this.count;
  }

  /** @blueprint pure */
  get doubled(): number {
    return this.count * 2;
  }
}

export class BigCounter extends Counter {
  /** @blueprint */
  constructor(start: number) {
    super(start * 10);
  }
}

/** @blueprint */
export function divide(a: number, b: number): { quotient: number; remainder: number } {
  return { quotient: Math.floor(a / b), remainder: a % b };
}

/** @blueprint */
export function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('first of an empty list');
  return item;
}

/** @blueprint */
export async function fetchDouble(value: number): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return value * 2;
}
