// A function's control flow as a flowchart (docs/codebase-map.md, Part 2). The parsing worker reads
// a function's body into the language-neutral statements below (src/extension/code-flow.ts, with
// each language's rules); buildFlowchart turns them into boxes and arrows, top to bottom: runs of
// plain statements are one box, decisions branch, loops return to their head, and return, throw,
// break and continue go where they go.

export type Statement =
  | { kind: 'simple'; text: string; line: number; endLine: number; waits?: 'await' | 'yield' }
  | { kind: 'if'; condition: string; line: number; then: Statement[]; else?: Statement[] }
  // A loop: test first (while, for), or after its body (do-while, repeat-until); `forever` has no
  // test (Rust's loop, Go's bare for).
  | { kind: 'loop'; head: string; line: number; body: Statement[]; test?: 'before' | 'after' | 'forever'; label?: string }
  // Cases fall through to the next one unless they end (C, C++, Java, C#, JavaScript, PHP's switch).
  // `exhaustive`: some case always matches (Rust's match), so there's no way past them all.
  | { kind: 'switch'; subject: string; line: number; cases: { label: string; line: number; body: Statement[] }[]; fallsThrough: boolean; exhaustive?: boolean }
  | { kind: 'try'; line: number; body: Statement[]; catches: { label: string; line: number; body: Statement[] }[]; finally?: Statement[] }
  | { kind: 'return' | 'throw' | 'break' | 'continue'; text: string; line: number; label?: string }
  // A statement holding others that run once, in order (with, using, lock, unsafe, a bare block).
  | { kind: 'group'; header?: string; line: number; body: Statement[] };

export type FlowNodeKind = 'start' | 'end' | 'block' | 'await' | 'decision' | 'loop' | 'switch' | 'catch' | 'finally' | 'return' | 'throw' | 'break' | 'continue';

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  // The code it stands for (a condition, a loop's head, a block's statements), trimmed.
  label: string;
  // 1-based lines it covers.
  line: number;
  endLine: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  // true/false out of a decision, a case's label, "loop" into a loop's body, "done" out of it,
  // "exception" into a catch.
  label?: string;
  // An arrow going back up: a loop's return to its head, continue.
  back?: boolean;
}

export interface Flowchart {
  name: string;
  line: number;
  endLine: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// A box shows this many lines of a block at most; the rest is "…".
export const MAX_BLOCK_LINES = 6;

interface Exit {
  from: string;
  label?: string;
}

interface Targets {
  // Where break and continue go, innermost loop (or switch, for break) first, with its label.
  breaks: { label?: string; exits: Exit[]; isLoop: boolean }[];
  continues: { label?: string; head: string }[];
  // Where a throw goes inside a try: its catches; outside one, the end.
  throws: string[] | undefined;
  // Inside a try with a finally: returns and uncaught throws leave through it, so they're collected
  // here to go through it.
  viaFinally?: Exit[];
}

export function buildFlowchart(name: string, line: number, endLine: number, body: Statement[]): Flowchart {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let next = 0;
  const node = (kind: FlowNodeKind, label: string, from: number, to = from): string => {
    const id = `n${next++}`;
    nodes.push({ id, kind, label: label.trim(), line: from, endLine: to });
    return id;
  };
  const link = (exits: Exit[], to: string, back = false): void => {
    for (const exit of exits) edges.push({ from: exit.from, to, ...(exit.label ? { label: exit.label } : {}), ...(back ? { back } : {}) });
  };

  const start = node('start', name, line);
  const end = node('end', 'End', endLine);
  const returns: Exit[] = [];
  const thrown: Exit[] = [];

  // Builds `statements` after `incoming`; returns the exits still open after them.
  const build = (statements: Statement[], incoming: Exit[], targets: Targets): Exit[] => {
    let open = incoming;
    let run: Extract<Statement, { kind: 'simple' }>[] = [];
    const flush = (): void => {
      if (!run.length) return;
      const lines = run.map((s) => s.text.trim()).filter(Boolean);
      const shown = lines.length > MAX_BLOCK_LINES ? [...lines.slice(0, MAX_BLOCK_LINES), '…'] : lines;
      const id = node('block', shown.join('\n'), run[0].line, run[run.length - 1].endLine);
      link(open, id);
      open = [{ from: id }];
      run = [];
    };
    for (const statement of statements) {
      // Nothing reaches what follows a return, throw, break or continue.
      if (!open.length && !run.length) break;
      if (statement.kind === 'simple' && !statement.waits) {
        run.push(statement);
        continue;
      }
      flush();
      open = step(statement, open, targets);
    }
    flush();
    return open;
  };

  const step = (s: Statement, open: Exit[], targets: Targets): Exit[] => {
    switch (s.kind) {
      case 'simple': {
        const id = node('await', s.text, s.line, s.endLine);
        link(open, id);
        return [{ from: id }];
      }
      case 'group': {
        let inner = open;
        if (s.header) {
          const id = node('block', s.header, s.line);
          link(open, id);
          inner = [{ from: id }];
        }
        return build(s.body, inner, targets);
      }
      case 'if': {
        const id = node('decision', s.condition, s.line);
        link(open, id);
        const thenExits = build(s.then, [{ from: id, label: 'true' }], targets);
        const elseExits = s.else ? build(s.else, [{ from: id, label: 'false' }], targets) : [{ from: id, label: 'false' }];
        return [...thenExits, ...elseExits];
      }
      case 'loop': {
        const exits: Exit[] = [];
        if (s.test === 'after') {
          // do { body } while (test): the body first, then the test back up.
          const entry = node('block', 'do', s.line);
          link(open, entry);
          const test = node('loop', s.head, s.line);
          const inner: Targets = { ...targets, breaks: [{ label: s.label, exits, isLoop: true }, ...targets.breaks], continues: [{ label: s.label, head: test }, ...targets.continues] };
          link(build(s.body, [{ from: entry }], inner), test);
          edges.push({ from: test, to: entry, label: 'loop', back: true });
          return [...exits, { from: test, label: 'done' }];
        }
        const head = node('loop', s.head, s.line);
        link(open, head);
        const inner: Targets = { ...targets, breaks: [{ label: s.label, exits, isLoop: true }, ...targets.breaks], continues: [{ label: s.label, head }, ...targets.continues] };
        link(build(s.body, [{ from: head, label: 'loop' }], inner), head, true);
        return s.test === 'forever' ? exits : [...exits, { from: head, label: 'done' }];
      }
      case 'switch': {
        const id = node('switch', s.subject, s.line);
        link(open, id);
        const exits: Exit[] = [];
        const inner: Targets = { ...targets, breaks: [{ exits, isLoop: false }, ...targets.breaks] };
        let carried: Exit[] = [];
        let hasDefault = false;
        for (const c of s.cases) {
          if (/^(default|else|_)$/.test(c.label)) hasDefault = true;
          const caseExits = build(c.body, [{ from: id, label: c.label }, ...carried], inner);
          carried = s.fallsThrough ? caseExits : [];
          if (!s.fallsThrough) exits.push(...caseExits);
        }
        exits.push(...carried);
        return hasDefault || s.exhaustive ? exits : [...exits, { from: id, label: 'no match' }];
      }
      case 'try': {
        const catchIds = s.catches.map((c) => node('catch', c.label, c.line));
        // With a finally, returns and uncaught throws inside go through it.
        const via: Exit[] = [];
        const leaving = s.finally ? { viaFinally: via } : {};
        const inner: Targets = { ...targets, ...leaving, throws: catchIds.length ? catchIds : s.finally ? undefined : targets.throws };
        const first = nodes.length;
        const bodyExits = build(s.body, open, inner);
        // Anything in the body may throw: each catch is reached from the body's first box (from
        // before the try when the body is empty).
        const from = nodes.length > first ? [{ from: nodes[first].id }] : open;
        for (const id of catchIds) link(from.map((e) => ({ from: e.from, label: 'exception' })), id);
        const catchExits = s.catches.flatMap((c, i) => build(c.body, [{ from: catchIds[i] }], { ...targets, ...leaving, throws: s.finally ? undefined : targets.throws }));
        if (!s.finally) return [...bodyExits, ...catchExits];
        const fin = node('finally', 'finally', s.finally[0]?.line ?? s.line);
        link([...bodyExits, ...catchExits], fin);
        link(via, fin);
        const finExits = build(s.finally, [{ from: fin }], targets);
        // After the finally, the returns and throws that came through it go on leaving.
        if (via.length) {
          const leave = finExits.map((e) => ({ from: e.from, label: via.every((v) => v.label === 'throws') ? 'throws' : 'return' }));
          if (targets.viaFinally) targets.viaFinally.push(...leave);
          else returns.push(...leave);
        }
        return bodyExits.length || catchExits.length ? finExits : [];
      }
      case 'return':
      case 'throw': {
        const id = node(s.kind, s.text, s.line);
        link(open, id);
        if (s.kind === 'return') (targets.viaFinally ?? returns).push({ from: id });
        else if (targets.throws) for (const c of targets.throws) edges.push({ from: id, to: c, label: 'exception' });
        else (targets.viaFinally ?? thrown).push({ from: id, label: 'throws' });
        return [];
      }
      case 'break': {
        const id = node('break', s.text, s.line);
        link(open, id);
        const target = s.label ? targets.breaks.find((b) => b.label === s.label) : targets.breaks[0];
        target?.exits.push({ from: id });
        return [];
      }
      case 'continue': {
        const id = node('continue', s.text, s.line);
        link(open, id);
        const target = s.label ? targets.continues.find((c) => c.label === s.label) : targets.continues[0];
        if (target) edges.push({ from: id, to: target.head, back: true });
        return [];
      }
    }
  };

  const fallsOff = build(body, [{ from: start }], { breaks: [], continues: [], throws: undefined });
  link([...fallsOff, ...returns, ...thrown], end);
  return { name, line, endLine, nodes, edges };
}
