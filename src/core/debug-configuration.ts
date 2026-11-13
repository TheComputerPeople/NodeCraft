// A launch configuration for a language's debugger (src/extension/code-debug.ts), after VS Code
// has resolved it.

// The configuration VS Code resolved, with the strings that were written with ${...} as they were
// written: Run passes paths, arguments and code as they are, and so does Debug. (A debugger's own
// placeholders, such as PHP Debug's ${port}, are left for it as written.)
export function unsubstituted(resolved: Record<string, unknown>, written: Record<string, unknown>): Record<string, unknown> {
  const put = (into: Record<string, unknown> | unknown[], from: Record<string, unknown> | unknown[]): void => {
    for (const [key, value] of Object.entries(from)) {
      const at = (into as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.includes('${') && typeof at === 'string') (into as Record<string, unknown>)[key] = value;
      else if (value && typeof value === 'object' && at && typeof at === 'object' && Array.isArray(value) === Array.isArray(at)) put(at as Record<string, unknown>, value as Record<string, unknown>);
    }
  };
  put(resolved, written);
  return resolved;
}
