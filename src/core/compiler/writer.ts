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
  }

  indent(): void {
    this.depth++;
  }

  dedent(): void {
    this.depth = Math.max(0, this.depth - 1);
  }

  // Removes trailing blank lines, e.g. after the last member of a class.
  trimTrailingBlank(): void {
    while (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}
