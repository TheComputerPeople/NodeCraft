# Your code as nodes

Mark a function with `@blueprint` in its documentation comment, and it's a node in the palette. Its
parameters are input pins, and its return value is **Return Value**:

```ts
/**
 * Subtracts an amount from a value, never going below zero.
 * @blueprint
 */
export function subtractToZero(value: number, amount = 10): number {
  return Math.max(0, value - amount);
}
```

```python
def is_positive(value: float) -> bool:
    """@blueprint pure"""
    return value > 0
```

Classes, methods, properties and async functions work too, in all twelve languages. **Expose
Functions as Nodes...**, on a source file, marks the ones you pick. A graph class can also extend a
class from your code.
