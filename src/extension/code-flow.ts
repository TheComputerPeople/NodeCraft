// Reading a function's body into flowchart statements (docs/codebase-map.md, Part 2), in the
// parsing worker: each language's node types are named in one table, and one walker reads them all.
// The flowchart itself is built in core (src/core/codemap/flow.ts).
import type { Node } from 'web-tree-sitter';
import { Flowchart, Statement, buildFlowchart } from '../core/codemap/flow';
import { GrammarId } from '../core/parsing/grammars';

interface Rules {
  functions: string[];
  // Nodes whose named children are statements, run in order.
  blocks: string[];
  ifs: string[];
  // An if's alternatives: else-if clauses (with their own condition), and else clauses.
  elseIfs: string[];
  elses: string[];
  // Ruby's unless and until test the opposite.
  negated?: string[];
  loops: string[];
  // Tested after the body (do-while, repeat-until).
  testedAfter: string[];
  // Loops with no test (Rust's loop; Go's for with no clause).
  forever?: string[];
  switches: string[];
  // Cases fall through to the next one unless they end.
  fallsThrough?: boolean;
  // Case kinds that don't fall through even where others do (Java's `case ->`).
  ruleCases?: string[];
  tries: string[];
  catches: string[];
  finallies: string[];
  returns: string[];
  throws: string[];
  breaks: string[];
  continues: string[];
  // Statements holding a body that runs once (with, using, lock, unsafe).
  groups: string[];
  labeled: string[];
  // Wrappers to look through (Rust's expression statements around `if`, `loop` and `match`).
  wrappers?: string[];
  // Simple statements that throw (panic, raise, error) or wait (await, yield).
  throwing?: RegExp;
  waits?: RegExp;
}

const C_LIKE: Omit<Rules, 'functions'> = {
  blocks: ['compound_statement'], ifs: ['if_statement'], elseIfs: [], elses: ['else_clause'],
  loops: ['for_statement', 'while_statement', 'for_range_loop', 'do_statement'], testedAfter: ['do_statement'],
  switches: ['switch_statement'], fallsThrough: true, tries: ['try_statement'], catches: ['catch_clause'], finallies: [],
  returns: ['return_statement'], throws: ['throw_statement'], breaks: ['break_statement'], continues: ['continue_statement'],
  groups: [], labeled: ['labeled_statement']
};

const JS_LIKE: Rules = {
  functions: ['function_declaration', 'generator_function_declaration', 'method_definition', 'function_expression', 'arrow_function', 'function', 'generator_function'],
  blocks: ['statement_block'], ifs: ['if_statement'], elseIfs: [], elses: ['else_clause'],
  loops: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'], testedAfter: ['do_statement'],
  switches: ['switch_statement'], fallsThrough: true, tries: ['try_statement'], catches: ['catch_clause'], finallies: ['finally_clause'],
  returns: ['return_statement'], throws: ['throw_statement'], breaks: ['break_statement'], continues: ['continue_statement'],
  groups: [], labeled: ['labeled_statement'], waits: /\b(await|yield)\b/
};

const RULES: Record<GrammarId, Rules> = {
  typescript: JS_LIKE,
  tsx: JS_LIKE,
  javascript: JS_LIKE,
  python: {
    functions: ['function_definition'], blocks: ['block'], ifs: ['if_statement'], elseIfs: ['elif_clause'], elses: ['else_clause'],
    loops: ['for_statement', 'while_statement'], testedAfter: [], switches: ['match_statement'],
    tries: ['try_statement'], catches: ['except_clause', 'except_group_clause'], finallies: ['finally_clause'],
    returns: ['return_statement'], throws: ['raise_statement'], breaks: ['break_statement'], continues: ['continue_statement'],
    groups: ['with_statement'], labeled: [], waits: /\b(await|yield)\b/
  },
  c_sharp: {
    functions: ['method_declaration', 'constructor_declaration', 'local_function_statement', 'operator_declaration', 'destructor_declaration', 'accessor_declaration'],
    blocks: ['block'], ifs: ['if_statement'], elseIfs: [], elses: [],
    loops: ['for_statement', 'foreach_statement', 'while_statement', 'do_statement'], testedAfter: ['do_statement'],
    switches: ['switch_statement'], tries: ['try_statement'], catches: ['catch_clause'], finallies: ['finally_clause'],
    returns: ['return_statement'], throws: ['throw_statement'], breaks: ['break_statement'], continues: ['continue_statement'],
    groups: ['using_statement', 'lock_statement', 'fixed_statement', 'unsafe_statement', 'checked_statement'], labeled: ['labeled_statement'],
    waits: /\b(await|yield)\b/
  },
  c: { ...C_LIKE, functions: ['function_definition'] },
  cpp: { ...C_LIKE, functions: ['function_definition', 'lambda_expression'], waits: /\bco_(await|yield)\b/ },
  rust: {
    functions: ['function_item'], blocks: ['block', 'unsafe_block', 'async_block'], ifs: ['if_expression'], elseIfs: [], elses: ['else_clause'],
    loops: ['for_expression', 'while_expression', 'loop_expression'], testedAfter: [], forever: ['loop_expression'],
    switches: ['match_expression'], tries: [], catches: [], finallies: [],
    returns: ['return_expression'], throws: [], breaks: ['break_expression'], continues: ['continue_expression'],
    groups: [], labeled: [], wrappers: ['expression_statement'],
    throwing: /^(panic|unreachable|todo|unimplemented)!/, waits: /\.await\b/
  },
  java: {
    functions: ['method_declaration', 'constructor_declaration', 'lambda_expression'], blocks: ['block', 'constructor_body'], ifs: ['if_statement'], elseIfs: [], elses: [],
    loops: ['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement'], testedAfter: ['do_statement'],
    switches: ['switch_expression', 'switch_statement'], fallsThrough: true, ruleCases: ['switch_rule'],
    tries: ['try_statement', 'try_with_resources_statement'], catches: ['catch_clause'], finallies: ['finally_clause'],
    returns: ['return_statement'], throws: ['throw_statement'], breaks: ['break_statement'], continues: ['continue_statement'],
    groups: ['synchronized_statement'], labeled: ['labeled_statement'], waits: /\byield\b/
  },
  go: {
    functions: ['function_declaration', 'method_declaration', 'func_literal'], blocks: ['block', 'statement_list'], ifs: ['if_statement'], elseIfs: [], elses: [],
    loops: ['for_statement'], testedAfter: [], forever: ['for_statement'],
    switches: ['expression_switch_statement', 'type_switch_statement', 'select_statement'], tries: [], catches: [], finallies: [],
    returns: ['return_statement'], throws: [], breaks: ['break_statement'], continues: ['continue_statement'],
    groups: [], labeled: ['labeled_statement'], throwing: /^panic\(/
  },
  lua: {
    functions: ['function_declaration', 'function_definition'], blocks: ['block'], ifs: ['if_statement'], elseIfs: ['elseif_statement'], elses: ['else_statement'],
    loops: ['for_statement', 'while_statement', 'repeat_statement'], testedAfter: ['repeat_statement'], switches: [], tries: [], catches: [], finallies: [],
    returns: ['return_statement'], throws: [], breaks: ['break_statement'], continues: [], groups: ['do_statement'], labeled: [],
    throwing: /^error\s*\(/, waits: /\bcoroutine\.yield\b/
  },
  gdscript: {
    functions: ['function_definition', 'constructor_definition'], blocks: ['body'], ifs: ['if_statement'], elseIfs: ['elif_clause'], elses: ['else_clause'],
    loops: ['for_statement', 'while_statement'], testedAfter: [], switches: ['match_statement'], tries: [], catches: [], finallies: [],
    returns: ['return_statement'], throws: [], breaks: ['break_statement'], continues: ['continue_statement'], groups: [], labeled: [],
    waits: /\bawait\b/
  },
  ruby: {
    functions: ['method', 'singleton_method'], blocks: ['body_statement', 'then', 'else', 'do', 'begin_block'], ifs: ['if', 'unless', 'if_modifier', 'unless_modifier'],
    elseIfs: ['elsif'], elses: ['else'], negated: ['unless', 'unless_modifier', 'until', 'until_modifier'],
    loops: ['while', 'until', 'for', 'while_modifier', 'until_modifier'], testedAfter: [], switches: ['case', 'case_match'],
    tries: ['begin'], catches: ['rescue'], finallies: ['ensure'],
    returns: ['return'], throws: [], breaks: ['break'], continues: ['next', 'redo'], groups: [], labeled: [],
    throwing: /^(raise|fail)\b/, waits: /\byield\b/
  },
  php: {
    functions: ['function_definition', 'method_declaration', 'anonymous_function', 'arrow_function'], blocks: ['compound_statement'],
    ifs: ['if_statement'], elseIfs: ['else_if_clause'], elses: ['else_clause'],
    loops: ['for_statement', 'foreach_statement', 'while_statement', 'do_statement'], testedAfter: ['do_statement'],
    switches: ['switch_statement', 'match_expression'], fallsThrough: true, tries: ['try_statement'], catches: ['catch_clause'], finallies: ['finally_clause'],
    returns: ['return_statement'], throws: [], breaks: ['break_statement'], continues: ['continue_statement'], groups: [], labeled: [],
    throwing: /^throw\b/, waits: /\byield\b/
  }
};

const COMMENTS = /comment/;
// A case's statements (its label's patterns aren't): anything statement-like.
const STATEMENT_LIKE = /statement|^block$|_block$|^body$|^then$|^else$|^do$|statement_list|_expression$|^return$|^break$|^next$|^call$/;

const line = (n: Node) => n.startPosition.row + 1;
const endLine = (n: Node) => n.endPosition.row + 1;
const oneLine = (text: string, max = 120) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// A node's text before `child` (a loop's head before its body, a case's label before its statements).
function textBefore(node: Node, child: Node | null | undefined): string {
  return child ? node.text.slice(0, child.startIndex - node.startIndex) : node.text;
}

export function flowchartAt(grammar: GrammarId, root: Node, atLine: number): Flowchart | undefined {
  const rules = RULES[grammar];
  // The innermost function around the line.
  let fn: Node | undefined;
  const visit = (node: Node): void => {
    if (node.startPosition.row + 1 > atLine || node.endPosition.row + 1 < atLine) return;
    if (rules.functions.includes(node.type)) fn = node;
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  if (!fn) return undefined;
  const name = nameOf(fn);
  const body = fn.childForFieldName('body');
  const statements = body ? reader(rules).body(body) : [];
  return buildFlowchart(name, line(fn), endLine(fn), statements);
}

// A function's name: its name field, or (C and C++) the name inside its declarator.
function nameOf(fn: Node): string {
  const own = fn.childForFieldName('name');
  if (own) return own.text;
  let declarator = fn.childForFieldName('declarator');
  while (declarator) {
    if (declarator.type === 'function_declarator') return declarator.childForFieldName('declarator')?.text ?? '(anonymous)';
    declarator = declarator.childForFieldName('declarator') ?? declarator.namedChildren.find((c) => c?.type === 'function_declarator') ?? null;
  }
  return '(anonymous)';
}

// The same node (web-tree-sitter gives a new object for each access).
const same = (a: Node | null | undefined, b: Node | null | undefined) => !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

function reader(rules: Rules) {
  const is = (n: Node, kinds: string[] | undefined) => !!kinds?.includes(n.type);
  const named = (n: Node) => n.namedChildren.filter((c): c is Node => !!c && !COMMENTS.test(c.type));

  // A function's body: a block, or a single expression (an arrow function's).
  const body = (node: Node): Statement[] => {
    // Ruby's method body with rescue or ensure is a try.
    if (node.type === 'body_statement' && named(node).some((c) => is(c, rules.catches) || is(c, rules.finallies))) return [tryOf(node)];
    return is(node, rules.blocks) ? list(node) : [statement(node)].flat();
  };

  const list = (node: Node): Statement[] => named(node).flatMap((child) => statement(child));

  const simple = (node: Node): Statement => {
    const text = oneLine(node.text);
    if (rules.throwing?.test(text) || /^throw\b/.test(text)) return { kind: 'throw', text, line: line(node) };
    const waits = rules.waits?.exec(node.text)?.[1] ?? rules.waits?.exec(node.text)?.[0];
    return { kind: 'simple', text: node.text.trim(), line: line(node), endLine: endLine(node), ...(waits ? { waits: /yield/.test(waits) ? 'yield' as const : 'await' as const } : {}) };
  };

  // What a block, or a single statement in its place, holds.
  const inner = (node: Node | null | undefined): Statement[] => {
    if (!node) return [];
    if (is(node, rules.blocks) || is(node, rules.elses)) return list(node);
    return statement(node);
  };

  const statement = (node: Node, label?: string): Statement[] => {
    if (is(node, rules.wrappers) && node.namedChildCount === 1) {
      const only = named(node)[0];
      if (only && isControl(only)) return statement(only, label);
    }
    if (is(node, rules.blocks)) return [{ kind: 'group', line: line(node), body: list(node) }];
    if (is(node, rules.labeled)) {
      const target = named(node).at(-1);
      const name = (node.childForFieldName('label') ?? named(node)[0])?.text.replace(/:$/, '');
      return target ? statement(target, name) : [];
    }
    // Go's and C++'s `if x := f(); x != nil` and `switch v := g(); v`: the initializer runs first.
    const initializer = is(node, rules.ifs) || is(node, rules.switches) ? node.childForFieldName('initializer') : null;
    const before = initializer ? [simple(initializer)] : [];
    if (is(node, rules.ifs)) return [...before, ifOf(node)];
    if (is(node, rules.loops)) return [loopOf(node, label)];
    if (is(node, rules.switches)) return [...before, switchOf(node)];
    if (is(node, rules.tries)) return [tryOf(node)];
    if (is(node, rules.groups)) {
      const b = node.childForFieldName('body') ?? named(node).at(-1);
      return [{ kind: 'group', header: oneLine(textBefore(node, b)), line: line(node), body: inner(b) }];
    }
    if (is(node, rules.returns)) return [{ kind: 'return', text: oneLine(node.text), line: line(node) }];
    if (is(node, rules.throws)) return [{ kind: 'throw', text: oneLine(node.text), line: line(node) }];
    if (is(node, rules.breaks) || is(node, rules.continues)) {
      const target = node.childForFieldName('label') ?? named(node).find((c) => /label|identifier/.test(c.type));
      return [{ kind: is(node, rules.breaks) ? 'break' : 'continue', text: oneLine(node.text), line: line(node), ...(target ? { label: target.text.replace(/^'/, '') } : {}) }];
    }
    return [simple(node)];
  };

  const isControl = (n: Node) => [rules.ifs, rules.loops, rules.switches, rules.tries, rules.returns, rules.throws, rules.breaks, rules.continues].some((k) => is(n, k));

  const ifOf = (node: Node): Statement => {
    const negate = is(node, rules.negated);
    const condition = node.childForFieldName('condition');
    const conditionText = oneLine(condition?.text ?? '');
    // Modifiers (Ruby's `x if y`): the body is the statement before the condition.
    const then = node.childForFieldName('consequence') ?? node.childForFieldName('body');
    const alternatives = node.children.filter((c, i): c is Node => !!c && node.fieldNameForChild(i) === 'alternative');
    return { kind: 'if', condition: negate ? `not (${conditionText})` : conditionText, line: line(node), then: inner(then), ...(alternatives.length ? { else: alternativesOf(alternatives) } : {}) };
  };

  // An if's alternatives, in order: else-ifs become nested ifs, an else its body.
  const alternativesOf = (alternatives: Node[]): Statement[] => {
    const [first, ...rest] = alternatives;
    if (is(first, rules.elseIfs)) {
      const nested = ifOf(first) as Extract<Statement, { kind: 'if' }>;
      // Ruby's elsif holds its own alternative; Python's, PHP's and Lua's are siblings.
      if (!nested.else && rest.length) nested.else = alternativesOf(rest);
      return [nested];
    }
    if (is(first, rules.elses)) {
      const wrapped = first.childForFieldName('body') ?? (named(first).length === 1 && !is(first, rules.blocks) ? named(first)[0] : null);
      return wrapped ? inner(wrapped) : list(first);
    }
    return inner(first);
  };

  const loopOf = (node: Node, givenLabel?: string): Statement => {
    // Rust's loops carry their label ('outer:) themselves.
    const label = givenLabel ?? named(node).find((c) => c.type === 'label')?.text.replace(/^'/, '').replace(/:$/, '');
    const b = node.childForFieldName('body') ?? named(node).find((c) => is(c, rules.blocks));
    const after = is(node, rules.testedAfter);
    // Go's `for {}` has nothing but its body; Rust's `loop` never tests.
    const forever = is(node, rules.forever) && (node.type !== 'for_statement' || named(node).length === 1);
    const negate = is(node, rules.negated);
    let head = after ? oneLine(node.childForFieldName('condition')?.text ?? '') : oneLine(textBefore(node, b));
    if (after) head = node.type === 'repeat_statement' ? `until ${head}` : `while ${head}`;
    if (negate && !after) head = oneLine(head);
    // Modifier loops (Ruby's `x while y`): the body is the statement before the condition.
    const statements = b ? inner(b) : [];
    return { kind: 'loop', head: head || node.type.replace(/_/g, ' '), line: line(node), body: statements, ...(after ? { test: 'after' as const } : forever ? { test: 'forever' as const } : {}), ...(label ? { label } : {}) };
  };

  const switchOf = (node: Node): Statement => {
    const subject = node.childForFieldName('value') ?? node.childForFieldName('condition') ?? node.childForFieldName('subject');
    const holder = node.childForFieldName('body');
    // The cases: the body's children (or the switch's own, after its subject).
    const caseNodes = (holder ? named(holder) : named(node).filter((c) => !same(c, subject))).filter((c) => !is(c, rules.blocks) || holder === null);
    const cases = caseNodes.map((c) => caseOf(c));
    const fallsThrough = !!rules.fallsThrough && !caseNodes.some((c) => is(c, rules.ruleCases));
    const keyword = node.type.startsWith('match') ? 'match' : node.type.startsWith('case') ? 'case' : node.type.startsWith('select') ? 'select' : 'switch';
    return { kind: 'switch', subject: oneLine(`${keyword} ${subject?.text ?? ''}`), line: line(node), cases, fallsThrough, ...(node.type === 'match_expression' ? { exhaustive: true } : {}) };
  };

  const caseOf = (node: Node): { label: string; line: number; body: Statement[] } => {
    // Ruby's `else` in a case holds its statements itself.
    if (is(node, rules.blocks) || is(node, rules.elses)) return { label: 'default', line: line(node), body: list(node) };
    const parts = named(node);
    // Rust's arm: its value is its body. Python's, Ruby's and GDScript's: their consequence or body.
    const value = node.type === 'match_arm' ? node.childForFieldName('value') : null;
    const bodyNode = value ?? node.childForFieldName('consequence') ?? (node.type === 'switch_case' || node.type === 'switch_default' ? null : node.childForFieldName('body'));
    let statements: Statement[];
    let firstStatement: Node | null | undefined;
    if (bodyNode) {
      firstStatement = bodyNode;
      statements = node.type === 'match_arm' && !is(bodyNode, rules.blocks) ? [simple(bodyNode)] : inner(bodyNode);
    } else {
      // The statements after the label (C, C#, Java, JavaScript, PHP, Go): skipping the label's
      // patterns and values.
      const valueNode = node.childForFieldName('value');
      const stmts = parts.filter((c) => !same(c, valueNode) && STATEMENT_LIKE.test(c.type) && !/pattern|label/.test(c.type));
      firstStatement = stmts[0];
      statements = stmts.flatMap((s) => (is(s, rules.blocks) ? list(s) : statement(s)));
    }
    const label = oneLine(textBefore(node, firstStatement)).replace(/\s*(:|=>|->|then)$/, '').trim();
    return { label: /^(default|else|case _|_)$/.test(label) || node.type.includes('default') ? 'default' : label || 'case', line: line(node), body: statements };
  };

  const tryOf = (node: Node): Statement => {
    const parts = named(node);
    const b = node.childForFieldName('body');
    // The body: its field, or (Ruby's begin and method body) the children before the first rescue.
    const bodyStatements = b ? inner(b) : parts.filter((c) => !is(c, rules.catches) && !is(c, rules.finallies) && !is(c, rules.elses)).flatMap((c) => statement(c));
    // Python's and Ruby's try-else runs after the body when nothing was thrown.
    const otherwise = parts.filter((c) => is(c, rules.elses)).flatMap((c) => inner(c.childForFieldName('body') ?? c));
    const catches = parts.filter((c) => is(c, rules.catches)).map((c) => {
      const cb = c.childForFieldName('body') ?? named(c).at(-1);
      return { label: oneLine(textBefore(c, cb)).replace(/:$/, '') || 'catch', line: line(c), body: cb ? inner(cb) : [] };
    });
    const fin = parts.find((c) => is(c, rules.finallies));
    const finBody = fin ? (fin.childForFieldName('body') ? inner(fin.childForFieldName('body')) : list(fin)) : undefined;
    return { kind: 'try', line: line(node), body: [...bodyStatements, ...otherwise], catches, ...(fin ? { finally: finBody } : {}) };
  };

  return { body };
}
