# Your code as nodes

Phase 3 of the [roadmap](roadmap.md): the equivalent of Unreal's `UFUNCTION(BlueprintCallable)`. Functions written by hand in the project appear in the palette as nodes, graphs call them, and the generated code imports them. This document is the design; [unreal-conventions.md](unreal-conventions.md) covers how the nodes look and behave in the editor.

## Exposing a function

As in Unreal, a function becomes a node only when its author says so, so the palette isn't flooded with every helper in the project. The marker is a `@blueprint` tag in the function's documentation comment: JSDoc in TypeScript and JavaScript, the docstring in Python, and the `///` XML documentation comment in C# (where the marked functions are `public` or `internal` static methods; see [program-structure.md](program-structure.md)). A comment costs nothing at run time and needs no package, so code with markers runs and builds exactly as before.

```ts
/**
 * Doubles a number.
 * @blueprint pure
 * @category Math|Scaling
 */
export function double(value: number): number {
  return value * 2;
}
```

```python
def apply_damage(health: float, amount: float = 10) -> float:
    """Subtracts damage from health, never going below zero.

    @blueprint
    @category Combat
    """
    return max(0.0, health - amount)
```

| Tag | Unreal equivalent | Effect |
|---|---|---|
| `@blueprint` | `BlueprintCallable` | A node with exec pins: it runs when execution reaches it. |
| `@blueprint pure` | `BlueprintPure` | A node without exec pins, evaluated wherever its output is used ([semantics.md](semantics.md), "Data flow"). |
| `@category A\|B` | `Category = "A\|B"` | Palette category; `\|` nests. Default: the module's file name, under "Project". |
| `@displayName Text` | `meta = (DisplayName = "Text")` | Node title. Default: the function name in words, as Unreal shows it (`applyDamage` and `apply_damage` both become "Apply Damage"). |
| `@keywords a b` | `meta = (Keywords = "a b")` | Extra words the action menu matches. |

The rest of the comment becomes the node's description (its tooltip). `@param name text` describes a pin.

The setting `blueprintVisualScripting.exposeAllFunctions` exposes every exported TypeScript or JavaScript function and every public (not `_`-prefixed) top-level Python function, as callable nodes, for small projects where marking each one is a chore. Markers still choose `pure`, category and title.

## What becomes a node

- **Which functions:** exported top-level function declarations, and exported `const` arrow functions or function expressions, in TypeScript and JavaScript. Top-level `def` in Python. Methods and classes arrive with Phase 4's classes.
- **Pins:** each parameter becomes an input pin, named in words like the title. A literal default value (number, string, boolean) becomes the pin's default. The return value becomes an output pin named "Return Value", as in Unreal; a function returning `void` or `None` has none.
- **Types** map to canonical types ([semantics.md](semantics.md), "Values"):

| Canonical | TypeScript / JavaScript (JSDoc) | Python |
|---|---|---|
| `bool` | `boolean` | `bool` |
| `int` | (none; TypeScript has no integer type) | `int` |
| `float` | `number` | `float` |
| `string` | `string` | `str` |
| array of T | `T[]`, `Array<T>`, `readonly T[]` | `list[T]`, `List[T]`, `Sequence[T]` |
| set of T | `Set<T>` | `set[T]`, `Set[T]` |
| map of K to V | `Map<K, V>`, `Record<K, V>` | `dict[K, V]`, `Dict[K, V]`, `Mapping[K, V]` |
| `any` | `any`, `unknown`, no annotation | `Any`, `object`, no annotation |
| `native:<name>` | any other type, by its text | any other type, by its text |

  `T | null`, `T | undefined`, `Optional[T]` and `T | None` are T, nullable. A `native` type connects only to the same type (or `any`) and passes through untouched.
- **Not exposed, with the reason shown in the output channel:** `async` functions and functions returning a `Promise` or `Awaitable` (they become latent nodes with Phase 4's latent actions), generators, rest parameters (`...args`, `*args`, `**kwargs`), destructured parameters, generic functions, TypeScript overloads, and marked TypeScript or JavaScript functions that aren't exported. Python keyword-only parameters with defaults are left off the node, so they keep their defaults; one without a default makes the function unexposable.

### How declarations are read

The roadmap planned to read TypeScript with the TypeScript compiler API and Python with its `ast` module. Neither fits: TypeScript 7's compiler API is unstable and runs a native binary, and `ast` means running a Python interpreter from the workspace, which Restricted Mode must not do. Instead, each language pack has a small declaration scanner in `src/core`, written in TypeScript. It reads only what a node needs (names, parameters, annotations, defaults and the documentation comment) and skips everything else by matching brackets. The tests check its results against the real tools: generated code that calls the imported functions must type-check under `tsc --strict` and run under Node.js and Python.

## Node identity

An imported function's node type is `fn:<language>:<path>#<name>`, for example `fn:typescript:src/combat.ts#applyDamage`. The path is relative to the workspace folder, with `/` separators. The language is that of the module: `typescript` for `.ts`, `.mts` and `.cts`, `javascript` for `.js`, `.mjs` and `.cjs`, and `python` for `.py`. TSX/JSX modules are left out for now.

A graph calls functions in its own language. A TypeScript graph may also call JavaScript modules, since TypeScript imports them directly. The palette shows only the functions a graph can call. The compiler reports the others.

## Generated imports

The generated file imports each module it calls, using the import spelling the project already uses:

- **TypeScript:** a relative specifier from the generated file. The extension follows the nearest `tsconfig.json`. `.ts` is used when `allowImportingTsExtensions` or `rewriteRelativeImportExtensions` is set, or when there is no `tsconfig.json`; that is Node.js's own convention for running TypeScript. Projects using `moduleResolution` `bundler` get no extension. Other projects get `.js`, the `node16`/`nodenext` convention. **Run** resolves each of these to the `.ts` file, so every project runs from the editor.
- **JavaScript:** a relative specifier with the module's real extension: `import` for ES modules, `require` for CommonJS (the project's module system, as in Phase 1).
- **Python:** an absolute import, `from combat import apply_damage` or `from game.combat import apply_damage`. The module's name is its path from its import root: the folder above the outermost package (a folder with `__init__.py`) that contains it, or the module's own folder when it isn't in a package. That root is where Python puts a script's folder on `sys.path`, so the import works when the project runs normally. **Run** adds the roots to `sys.path`.

Names that clash with the generated class or with each other are aliased (`import { double as double_1 }`, `from a import f as f_1`).

## Simulate

Simulate runs graphs inside the editor and can't run the project's own code, so a graph that reaches an imported function stops with an error that points to **Run**. Every other node, including the standard library nodes, still runs in Simulate.

## When the code changes

A node keeps the signature it was created with. The graph file stores the last known signature of each function it calls (`importedFunctions`, keyed by node type), as Unreal stores a node's pins with the node. So a graph still opens and shows its wires when the code has changed. When the code and the stored signature disagree:

| Change in code | Editor | Compiler |
|---|---|---|
| Parameter or return type changed, parameter added or removed | Warning badge on the node; **Refresh Node** in its context menu updates the pins, keeping wires whose pin still exists with a compatible type | Error until refreshed |
| Function renamed, or moved to another module | Error badge. When the module has exactly one new function with the same parameters and return type, or another module has a function with the same name and signature, the node menu offers **Replace with …** | Error naming the candidate |
| Function deleted, or no longer marked `@blueprint` | Error badge | Error |

**Refresh All Nodes** (Unreal's File menu command) refreshes every node in the graph file at once, and is a VS Code command.

## Standard library nodes

Each language's basics are available as built-in nodes with Unreal's names and categories, implemented in every language pack, so graphs stay portable between languages:

- **Math:** Subtract, Multiply, Divide, Modulo (%), Min, Max, Clamp, Abs, Round, Floor, Ceil, Sqrt, Power, Random Float in Range, Random Integer in Range, comparisons (`<`, `<=`, `>`, `>=`, `==`, `!=`), and the boolean operators AND, OR, NOT. (Add predates the library and keeps its exec pins, so existing graphs don't change.)
- **String:** Append, Len, Contains, To Upper, To Lower, Trim, Replace, Substring, String To Float and String To Int (To String already converts the other way).
- **Utilities:** Is Valid, Select.
- **File:** Load File to String and Save String to File, as `UFileHelper` offers them.

Operators are compact nodes showing their symbol (`-`, `×`, `÷`, `%`, `<`, `==`, AND, …), and the rest are pure nodes with a title bar, as in Unreal; the file nodes run when execution reaches them. Where languages disagree, the nodes follow one rule everywhere, checked by the conformance suite:

- Dividing (or taking a remainder) by zero stops the run with an error.
- `%` takes the sign of A, as in C++ and JavaScript (Python's `%` follows B).
- Round rounds halves up (toward positive infinity), as Unreal's Round does; Round, Floor and Ceil return integers.
- Sqrt of a negative number, and a Power with no real result, give NaN.
- String lengths and positions count characters (code points), not UTF-16 units.
- String To Float and String To Int accept plain decimal numbers only; anything else gives 0, as in Unreal. Replace with an empty From leaves the text unchanged.
- Load File to String and Save String to File use UTF-8 and paths relative to the working directory; a file that can't be read or written stops the run with an error. (Unreal's versions return a success flag instead; nodes with several outputs arrive with Phase 4.)

Collection nodes (Make Array, Length, Get, Add, Contains, Remove) arrive with Phase 4, with the wildcard pins they need.

### More of Unreal's library

More of Unreal's own nodes, with its names and categories, implemented in every language pack (and the C example pack, where C has the types):

| Category | Nodes |
|---|---|
| Math | Lerp, Map Range Clamped, Map Range Unclamped, Sign, Wrap (Integer), Nearly Equal, Truncate, Fraction, Exp, Loge, Log |
| Math / Trig | Sin, Cos, Tan, Asin, Acos, Atan, Atan2 (all in radians), Degrees To Radians, Radians To Degrees, Get PI |
| Math / Boolean | XOR, NAND, NOR |
| Math / Random | Random Bool |

Their rules, where languages would disagree:

- **Ranges.** Lerp doesn't clamp Alpha. Map Range with an empty in range (In Range A equal to B) gives Out Range B at or past it and Out Range A before it, as Unreal does. Wrap (Integer) includes both Min and Max: one past Max is Min again; Min greater than Max stops the run.
- **Domains.** Asin and Acos take values outside -1 to 1 as the nearest end, as Unreal (and Godot) do. Loge and Log of a value that isn't positive, or Log in a base that isn't positive or is 1, stop the run with an error (languages would otherwise give -Infinity, NaN or an error of their own).
- **Precision.** Log is `ln(A) / ln(Base)` in every language (no `log10` shortcut), so Log of 1000 in base 10 is 2.9999999999999996 everywhere. Math libraries can differ in the last digit of trigonometry and logarithms; the conformance fixture rounds those results to 10 places.
- **Parts.** Truncate rounds toward zero and returns an integer; Fraction keeps A's sign (-1.25 gives -0.25), as Unreal's does.

### More utilities

Beyond Unreal's set, the library has everyday utilities adapted from Common Utility Snippets v0.1.0 (MIT; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)):

| Category | Nodes |
|---|---|
| String | Is Empty, Is Blank, Normalize Whitespace, Truncate, Capitalize, To Camel Case, To Snake Case, To Kebab Case, Slugify, Pad Left, Pad Right, Word Count, Mask, Format Bytes, Parse Boolean, Parse Integer Strict |
| Math | In Range, Round To |
| Utilities / Array | Unique, Difference, Intersection (any element type), Average, Median |
| Utilities / Map | Pick, Omit |
| Utilities | Get Environment Variable |
| File | Normalize Path |

The original leaves some behavior to each language. Here it's one contract, checked by the `utilities-*` fixtures in the conformance suite:

- **Characters.** Text is measured in code points, as above. Truncate's maximum includes its suffix.
- **Words.** The case conversions and Slugify split text into ASCII words: runs of letters and digits, split where a lower-case letter or digit meets a capital (`userID` → user, id) and before the last capital of a run that starts a word (`HTTPServer` → http, server). Other characters, accented letters included, separate words.
- **Errors.** A broken rule stops the run with a message, as dividing by zero does: a negative length, Parse Boolean on an unknown word, Parse Integer Strict on `12.0`, or Average of nothing.
- **Rounding.** Round To rounds halves away from zero, with a small correction for values just below a half (2.675 rounds to 2.68). Format Bytes rounds halves up in every language, where `toFixed` and `printf` disagree on exact halves.
- **Paths.** Normalize Path works on the text alone, the same on every system: `/` and `\` both separate folders, `.` and empty parts go, `..` removes the folder before it, and the result uses `/`.
- **Limits.** Parse Integer Strict accepts numbers up to 2^53 (in C#, its 32-bit ints). Format Bytes takes sizes up to 2^53 and up to 10 decimals. Round To takes 0 to 15 digits.
- **Upper case and spaces.** Capitalize uses each language's upper-casing for the first character, so non-ASCII letters can differ: C++ and Lua change ASCII letters only. In C++ and Lua, too, only ASCII spaces count as whitespace (Is Blank, Normalize Whitespace, Word Count, Trim).

Nine of the original's 36 functions aren't included. Group By, Count By and Sum By take a function, which graphs can't pass. Chunk, Flatten, Flatten One Level and Zip return nested arrays, which pin types can't express. Coalesce takes any number of arguments of any type, and Select covers two. Clamp is already in the library.
