// The Tour (docs/release.md, step 4): New Project's other first graph. A class graph whose Start
// prints a welcome, counts in a For Loop through a pure function, keeps a total in a variable, prints
// a struct and branches on it, with a Test Case for the function; its comments say what to try. It
// is the same graph in every language, with a Summary structure beside it. Free of the vscode API.
import { GraphComment, GraphConnection, GraphDocument, GraphNode } from '../core/model';

export const TOUR_WELCOME = 'Welcome to the Tour of Blueprint Visual Scripting.';

// What the Tour's Start prints, in order.
export const TOUR_OUTPUT = [
  TOUR_WELCOME,
  '1 is odd', '2 is even', '3 is odd', '4 is even', '5 is odd',
  '{"Count":5,"Total":15}',
  'The total is more than 10.'
];

// The Tour's Test Case, as Run Tests reports it.
export const TOUR_TEST = 'Describe tells even from odd';

const node = (id: string, type: string, x: number, y: number, properties: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, position: { x, y }, properties });

// "a.pin -> b.pin" for each wire.
const wires = (...list: string[]): GraphConnection[] => list.map((wire) => {
  const [from, to] = wire.split(' -> ');
  const [fromNode, fromPin] = from.split('.');
  const [toNode, toPin] = to.split('.');
  return { id: `${fromNode}.${fromPin}->${toNode}.${toPin}`, fromNode, fromPin, toNode, toPin };
});

const comment = (id: string, text: string, x: number, y: number, width: number, height: number): GraphComment =>
  ({ id, text, position: { x, y }, size: { width, height } });

const describe = (id: string, x: number, y: number, value?: number) =>
  node(id, 'core:function.call', x, y, { graph: 'Describe', ...(value === undefined ? {} : { 'pin:value': value }) });

// The Tour's class graph, named Main so the project's entry point runs it.
export function tourGraph(language: string, name = 'Main'): GraphDocument {
  return {
    schemaVersion: 3, name, kind: 'class', language,
    metadata: { description: 'The Tour: events, a variable, a loop, a function, a struct, Branch and a test.' },
    variables: [{ id: 'v_total', name: 'Total', type: { id: 'int' }, defaultValue: 0 }],
    graphs: [
      {
        id: 'EventGraph', name: 'EventGraph', kind: 'event',
        nodes: [
          node('start', 'core:event.start', 0, 0),
          node('welcome', 'core:console.print', 260, 0, { 'pin:value': TOUR_WELCOME }),
          node('loop', 'core:flow.for-loop', 540, 0, { 'pin:firstIndex': 1, 'pin:lastIndex': 5 }),
          describe('describe', 700, 190),
          node('printEach', 'core:console.print', 840, 0),
          node('getTotal', 'core:variable.get', 990, 170, { variable: 'v_total' }),
          node('add', 'core:math.add', 1100, 0),
          node('setTotal', 'core:variable.set', 1360, 0, { variable: 'v_total' }),
          node('getTotal2', 'core:variable.get', 560, 520, { variable: 'v_total' }),
          node('summary', 'struct:Summary.make', 820, 480, { 'pin:count': 5 }),
          node('printSummary', 'core:console.print', 1100, 400),
          node('getTotal3', 'core:variable.get', 880, 620, { variable: 'v_total' }),
          node('more', 'core:math.greater', 1100, 560, { 'pin:b': 10 }),
          node('branch', 'core:flow.branch', 1360, 400),
          node('printMore', 'core:console.print', 1640, 340, { 'pin:value': 'The total is more than 10.' }),
          node('printLess', 'core:console.print', 1640, 500, { 'pin:value': 'The total is 10 or less.' }),
          node('test', 'core:test.case', 0, 860, { name: TOUR_TEST }),
          describe('describe4', 20, 980, 4),
          node('even', 'core:test.assert-equal', 300, 860, { wildcards: { wildcard: 'string' }, 'pin:expected': '4 is even' }),
          describe('describe7', 340, 1020, 7),
          node('odd', 'core:test.assert-equal', 640, 860, { wildcards: { wildcard: 'string' }, 'pin:expected': '7 is odd' })
        ],
        connections: wires(
          'start.execOut -> welcome.execIn',
          'welcome.execOut -> loop.execIn',
          'loop.loopBody -> printEach.execIn',
          'loop.index -> describe.value',
          'describe.text -> printEach.value',
          'printEach.execOut -> add.execIn',
          'getTotal.value -> add.a',
          'loop.index -> add.b',
          'add.execOut -> setTotal.execIn',
          'add.result -> setTotal.value',
          'loop.completed -> printSummary.execIn',
          'getTotal2.value -> summary.total',
          'summary.struct -> printSummary.value',
          'printSummary.execOut -> branch.execIn',
          'getTotal3.value -> more.a',
          'more.returnValue -> branch.condition',
          'branch.true -> printMore.execIn',
          'branch.false -> printLess.execIn',
          'test.execOut -> even.execIn',
          'describe4.text -> even.actual',
          'even.execOut -> odd.execIn',
          'describe7.text -> odd.actual'
        ),
        comments: [
          comment('c_start', 'Start runs when a Main is made. Press Run, or Simulate to run it here.', -40, -80, 520, 240),
          comment('c_loop', 'Select this Print, press F9, then Simulate: hover a pin for its value, F10 steps, F5 goes on. Debug stops here too.', 500, -80, 1120, 360),
          comment('c_summary', 'Summary is a Structure, in Summary.vgraph beside this graph. Print shows it with its fields.', 520, 320, 1400, 400),
          comment('c_test', 'A Test Case is a test: Run Tests runs it in your language, Simulate Tests here.', -40, 780, 960, 360)
        ]
      },
      {
        id: 'Describe', name: 'Describe', kind: 'function',
        signature: {
          pure: true,
          inputs: [{ id: 'value', name: 'Value', kind: 'data', type: { id: 'int' } }],
          outputs: [{ id: 'text', name: 'Text', kind: 'data', type: { id: 'string' } }]
        },
        nodes: [
          node('entry', 'core:function.entry', 0, 0, { graph: 'Describe' }),
          node('rest', 'core:math.modulo', 0, 160, { 'pin:b': 2 }),
          node('isEven', 'core:math.equal', 240, 160, { 'pin:b': 0 }),
          node('branch', 'core:flow.branch', 480, 0),
          node('text', 'core:convert.to-string', 480, 200),
          node('evenText', 'core:string.append', 740, 160, { 'pin:b': ' is even' }),
          node('oddText', 'core:string.append', 740, 300, { 'pin:b': ' is odd' }),
          node('returnEven', 'core:function.return', 1000, -40, { graph: 'Describe' }),
          node('returnOdd', 'core:function.return', 1000, 120, { graph: 'Describe' })
        ],
        connections: wires(
          'entry.execOut -> branch.execIn',
          'entry.value -> rest.a',
          'rest.returnValue -> isEven.a',
          'isEven.returnValue -> branch.condition',
          'entry.value -> text.value',
          'text.result -> evenText.a',
          'text.result -> oddText.a',
          'branch.true -> returnEven.execIn',
          'evenText.returnValue -> returnEven.text',
          'branch.false -> returnOdd.execIn',
          'oddText.returnValue -> returnOdd.text'
        ),
        comments: [
          comment('c_pure', 'A pure function: its node has no exec pins, and runs whenever its output is read. Double-click a Describe node to come back here.', -40, -120, 1300, 520)
        ]
      }
    ]
  };
}

// The structure the Tour prints, in its own file beside the graph.
export function tourSummary(language: string): GraphDocument {
  return {
    schemaVersion: 3, name: 'Summary', kind: 'structure', language,
    variables: [
      { id: 'count', name: 'Count', type: { id: 'int' }, defaultValue: 0 },
      { id: 'total', name: 'Total', type: { id: 'int' }, defaultValue: 0 }
    ],
    graphs: []
  };
}
