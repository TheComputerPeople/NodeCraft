# universal-utils

A node package of everyday utilities: text, numbers, parsing, arrays, maps and the system. Each node works the same in Simulate and in every graph language: TypeScript, JavaScript, Python, C#, C++, Rust, Java and Go. It's adapted from [Common Utility Snippets](LICENSE) v0.1.0 (MIT), which implements one function catalog separately in each language.

## Use it

Copy this folder into your workspace. Blueprint Visual Scripting loads `universal-utils.vgraph-package.json` as a package (version 0.1.0), and its nodes appear in the palette under **Utilities**. Graphs remember the version they were made with: a later 1.x changes nothing, and a 2.0 marks their nodes for **Refresh Node**.

## The nodes

| Category | Nodes |
|---|---|
| Text | Is Empty, Is Blank, Normalize Whitespace, Truncate, Capitalize, To Camel Case, To Snake Case, To Kebab Case, Slugify, Pad Left, Pad Right, Word Count, Mask |
| Numbers | In Range, Round To, Format Bytes |
| Parsing | Parse Boolean, Parse Integer Strict |
| Arrays | Unique, Difference, Intersection (any element type), Average, Median |
| Maps | Pick, Omit |
| System | Get Environment Variable, Normalize Path |

## How they behave

The original library leaves some behavior to each language. Here it's one contract, so a graph prints the same wherever it runs:

- **Characters.** Text is measured in characters (Unicode code points), as the standard library's nodes measure it, never in bytes or UTF-16 units. Truncate's maximum includes its suffix.
- **Words.** The case conversions and Slugify split text into ASCII words: runs of letters and digits, split where a lower-case letter or digit meets a capital (`userID` → user, id) and before the last capital of a run that starts a word (`HTTPServer` → http, server). Other characters, accented letters included, separate words.
- **Errors.** A broken rule stops the run with a message, as Divide by zero does. Examples are a negative length, Parse Boolean on an unknown word, Parse Integer Strict on `12.0`, or Average of nothing. The original returns errors as values in Go and Rust.
- **Rounding.** Round To rounds halves away from zero, with the original's small correction for values just below a half (2.675 rounds to 2.68). Format Bytes rounds halves up, the same in every language; `toFixed` and `printf` disagree on exact halves.
- **Paths.** Normalize Path works on the text alone, the same on every system: `/` and `\` both separate folders, `.` and empty parts go, `..` removes the folder before it, and the result uses `/`. The original used each platform's own rules.
- **Limits.** Parse Integer Strict accepts numbers up to 2^53 (C# graphs: their 32-bit ints). Format Bytes takes sizes up to 2^53 and up to 10 decimals. Round To takes 0 to 15 digits.
- **Upper case.** Capitalize uses each language's upper-casing for the first character, so non-ASCII letters can differ (C++ changes ASCII letters only).

## Not included

Of the original's 36 functions, these 9 don't fit graphs yet:
- **Group By, Count By and Sum By** take a function, and graphs have no function values.
- **Chunk, Flatten, Flatten One Level and Zip** return nested arrays, which pin types can't express.
- **Coalesce** takes any number of arguments of any type; the standard library's Select covers two.
- **Clamp** duplicates the standard library's Clamp.

The original's PHP and Ruby versions aren't used: graphs can't target those languages yet.

## Change it

`generate.js` is the source: each node's pins and its code in every language. After changing it, run `node libraries/universal-utils/generate.js` to rewrite `nodes/`.

The fixtures in `fixtures/` print a case of every node. The repository's tests run them in Simulate, and in each language through the published conformance suite (`test/conformance/universal-utils.test.ts`), and check that they print the same.
