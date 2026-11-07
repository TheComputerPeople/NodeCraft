// Builds generated source text line by line, tracking indentation and where each node's code starts.
import { SourceRef } from './ir';

// The line (1-based) where a node's code begins in a generated file.
export interface NodeLine {
  graphId: string;
  nodeId: string;
  line: number;
}

export class CodeWriter {
  private readonly lines: string[] = [];
  private depth = 0;
  // The node whose comment was written last, so its following statements don't repeat it.
  private currentNode: string | undefined;
  readonly nodeLines: NodeLine[] = [];
  // Lines (1-based) where code that belongs to no node starts: a method's opening, after the last
  // node of the one before.
  readonly breaks: number[] = [];

  constructor(private readonly indentUnit: string) {}

  line(text = ''): void {
    this.lines.push(text ? this.indentUnit.repeat(this.depth) + text : '');
  }

  // Writes a comment naming the node and records the next line as the start of its code, unless
  // the previous statement came from the same node.
  node(source: SourceRef, comment: (text: string) => string): void {
    const key = JSON.stringify([source.graphId, source.nodeId]);
    if (key === this.currentNode) return;
    this.currentNode = key;
    this.line(comment(`${source.title} (${source.nodeId})`));
    this.nodeLines.push({ graphId: source.graphId, nodeId: source.nodeId, line: this.lines.length + 1 });
  }

  // Code that follows doesn't continue the last node's (a new method, a call to a shared block).
  endNode(): void {
    this.currentNode = undefined;
    if (this.breaks.at(-1) !== this.lines.length + 1) this.breaks.push(this.lines.length + 1);
  }

  indent(): void {
    this.depth++;
  }

  dedent(): void {
    this.depth = Math.max(0, this.depth - 1);
  }

  // How many lines are written.
  get length(): number {
    return this.lines.length;
  }

  // The text of the lines from `start` (0-based) on.
  textFrom(start: number): string {
    return this.lines.slice(start).join('\n');
  }

  // Replaces `count` lines from `start` (0-based) with `replacement`, which are written as they are
  // (indented already). The node lines and breaks after them move with them.
  splice(start: number, count: number, replacement: string[]): void {
    this.lines.splice(start, count, ...replacement);
    const shift = replacement.length - count;
    if (!shift) return;
    for (const n of this.nodeLines) if (n.line > start) n.line += shift;
    for (let i = 0; i < this.breaks.length; i++) if (this.breaks[i] > start) this.breaks[i] += shift;
  }

  // Removes trailing blank lines, e.g. after the last member of a class.
  trimTrailingBlank(): void {
    while (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}
