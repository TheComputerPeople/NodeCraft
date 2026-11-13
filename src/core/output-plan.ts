// Output plans (docs/output-placement.md, "Architecture"): what a language pack's placement strategy
// asks for besides the generated file itself. Files the extension owns are rewritten freely; a
// user's file gets at most a fenced block, added once with consent and only edited inside after.
import { CompileDiagnostic } from './compiler/diagnostics';

export interface OutputPlan {
  // Files the extension owns (a CMake include listing the generated sources, a Rust module file),
  // relative to the workspace folder with "/" separators. An empty `text` deletes the file.
  ownedFiles?: { path: string; text: string }[];
  // One-time edits to the user's files that register the generated code with the build.
  hooks?: OutputHook[];
  diagnostics?: CompileDiagnostic[];
}

export interface OutputHook {
  // Stable across compiles, e.g. "cmake-include:CMakeLists.txt": the user's answer is remembered by it.
  id: string;
  // The user's file, relative to the workspace folder.
  file: string;
  // What it does and why, for the prompt: "Add include(vgraph.cmake) to CMakeLists.txt so CMake
  // builds the generated C++ files".
  description: string;
  block: FencedBlock;
}

// Lines the extension manages inside a user's file, between a begin and an end marker line.
export interface FencedBlock {
  begin: string;
  end: string;
  // The lines between the markers.
  text: string;
  // Where a new block goes: at the end (the default), at the start, after the last line that
  // matches the pattern (a regular expression's source), or before the last line that matches it
  // (a .vcxproj's </Project>).
  anchor?: 'end' | 'start' | { after: string } | { before: string };
}

// What placement knows about the project (read-only, static: nothing runs project tooling).
export interface PlacementContext {
  // The generated file just written, relative to the workspace folder; absent when the plan is
  // refreshed because a graph was deleted or renamed.
  outputFile?: string;
  // Every generated file of the pack's language in the workspace folder, relative, sorted.
  generatedFiles: string[];
  readFile(path: string): string | undefined;
  exists(path: string): boolean;
  // The names of a folder's files (relative to the workspace folder, "" for it), when the host can
  // list them: placement finds a project file whose name it can't know (a .vcxproj).
  list?(dir: string): string[];
}

// The block's place in the text, if the text has it.
// Whether a path a plan names, relative to the workspace folder, stays inside it: no absolute path
// or drive, and no ".." above the folder.
export function isInsideFolder(file: string): boolean {
  if (/^([A-Za-z]:|[/\\])/.test(file)) return false;
  let depth = 0;
  for (const part of file.split(/[/\\]+/)) {
    if (part === '..') depth--;
    else if (part && part !== '.') depth++;
    if (depth < 0) return false;
  }
  return depth > 0;
}

// The plan without the files and hooks it names outside the workspace folder, which a compile never
// writes (a Rust workspace's member crate outside it, say), each with a warning (docs/audit.md,
// second pass).
export function confinePlan(plan: OutputPlan): OutputPlan {
  const outside = [...(plan.ownedFiles ?? []).map((f) => f.path), ...(plan.hooks ?? []).map((h) => h.file)].filter((f) => !isInsideFolder(f));
  if (!outside.length) return plan;
  return {
    ...plan,
    ownedFiles: plan.ownedFiles?.filter((f) => isInsideFolder(f.path)),
    hooks: plan.hooks?.filter((h) => isInsideFolder(h.file)),
    diagnostics: [...(plan.diagnostics ?? []), ...[...new Set(outside)].map((file): CompileDiagnostic => ({ severity: 'warning', code: 'build-registration', message: `${file} is outside the workspace folder, so compiling doesn't write it. Open the folder that holds it to register the generated code there.` }))]
  };
}

// The name the extension had before NodeCraft, in the begin markers of blocks it added then.
const FORMER_NAME = 'Blueprint Visual Scripting';

export function findBlock(text: string, block: Pick<FencedBlock, 'begin' | 'end'>): { start: number; end: number; inner: string } | undefined {
  // A block added under the former name is the same block: it's found, and rewritten with the new
  // marker, rather than a second one added.
  const former = block.begin.replace('NodeCraft', FORMER_NAME);
  let begin = block.begin;
  let start = text.indexOf(begin);
  if (start < 0 && former !== begin) {
    begin = former;
    start = text.indexOf(begin);
  }
  if (start < 0) return undefined;
  const endMarker = text.indexOf(block.end, start + begin.length);
  if (endMarker < 0) return undefined;
  const innerStart = text.indexOf('\n', start) + 1;
  const innerEnd = text.lastIndexOf('\n', endMarker) + 1;
  return { start, end: endMarker + block.end.length, inner: innerStart <= innerEnd ? text.slice(innerStart, innerEnd) : '' };
}

// The text with the block in place: its lines replaced when the markers are there, else the whole
// block inserted at its anchor. Keeps the file's line endings.
export function withBlock(text: string, block: FencedBlock): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const inner = block.text ? `${block.text.replace(/\r?\n$/, '').split(/\r?\n/).join(eol)}${eol}` : '';
  const found = findBlock(text, block);
  if (found) {
    // The begin line is written again, so a block found by the former name gets the new one.
    const innerEnd = text.lastIndexOf('\n', text.indexOf(block.end, found.start)) + 1;
    return text.slice(0, found.start) + block.begin + eol + inner + text.slice(innerEnd);
  }
  const whole = `${block.begin}${eol}${inner}${block.end}${eol}`;
  const anchor = block.anchor ?? 'end';
  if (anchor === 'start') return whole + text;
  if (anchor !== 'end') {
    const lines = text.split(/(?<=\n)/);
    const pattern = new RegExp('after' in anchor ? anchor.after : anchor.before);
    const last = lines.map((line) => pattern.test(line)).lastIndexOf(true);
    if (last >= 0 && !('after' in anchor)) return `${lines.slice(0, last).join('')}${whole}${lines.slice(last).join('')}`;
    if (last >= 0) {
      const before = lines.slice(0, last + 1).join('');
      return `${before}${before.endsWith('\n') ? '' : eol}${whole}${lines.slice(last + 1).join('')}`;
    }
  }
  return `${text}${text && !text.endsWith('\n') ? eol : ''}${whole}`;
}

// Whether the user's file has the block with this content already.
export function hasBlock(text: string, block: FencedBlock): boolean {
  return withBlock(text, block) === text;
}
