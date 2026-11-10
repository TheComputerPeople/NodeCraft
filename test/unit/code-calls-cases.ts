// Snippets for each language's calls, base types, decorators and framework handlers, with what they
// give (test/unit/code-facts.test.ts). Each call is "in > receiver.callee" ("new" when it constructs).
import { GrammarId } from '../../src/core/parsing/grammars';

export interface CallCase {
  grammar: GrammarId;
  code: string;
  calls: string[];
  bases: string[];
  decorators: string[];
  handlers: string[];
}

export const CALL_CASES: CallCase[] = [
  {
    grammar: 'typescript',
    code: `import G from './g';
@Controller('cats')
export class A extends B<T> implements I {
  @Get()
  m(): void { this.n(); f(1); new C(); obj.k(); G.make(); new G().go(); }
  n(): void {}
}
interface K extends L {}
f();
`,
    calls: [' > Controller', 'A > Get', 'A.m > self.n', 'A.m > f', 'A.m > new C', 'A.m > obj.k', 'A.m > G.make', 'A.m > G.go', 'A.m > new G', ' > f'],
    bases: ['A extends B', 'A implements I', 'K extends L'],
    decorators: ['A: Controller', 'm: Get'],
    handlers: ['m', 'n']
  },
  {
    grammar: 'javascript',
    code: `const r = require('./r');
class A extends B { m() { super.m(); r.go(); } }
`,
    calls: [' > require', 'A.m > super.m', 'A.m > r.go'],
    bases: ['A extends B'],
    decorators: [],
    handlers: []
  },
  {
    grammar: 'python',
    code: `@app.route("/x")
def view():
    helper()
    Greeting().start()

class A(B, mod.C):
    @staticmethod
    def s():
        A.t()
        super().u()
`,
    calls: [' > app.route', 'view > helper', 'view > Greeting', 'view > Greeting.start', 'A.s > A.t', 'A.s > super', 'A.s > super.u'],
    bases: ['A extends B', 'A extends mod.C'],
    decorators: ['view: app.route', 's: staticmethod'],
    handlers: ['view']
  },
  {
    grammar: 'c_sharp',
    code: `[ApiController]
class A : B, I { [HttpGet("x")] void F() { G(); this.H(); C.K<int>(); new D(); new List<int>(); base.F(); new E().Go(); } }
class P(int x) : B(x) {}
`,
    calls: ['A.F > G', 'A.F > self.H', 'A.F > C.K', 'A.F > new D', 'A.F > new List', 'A.F > super.F', 'A.F > E.Go', 'A.F > new E'],
    bases: ['A extends B', 'A extends I', 'P extends B'],
    decorators: ['A: ApiController', 'F: HttpGet'],
    handlers: ['F']
  },
  {
    grammar: 'c',
    code: 'int f(void) { return g(1) + s.op(2) + p->q(); }\n',
    calls: ['f > g', 'f > s.op', 'f > p.q'],
    bases: [],
    decorators: [],
    handlers: []
  },
  {
    grammar: 'cpp',
    code: 'class A : public B, private ns::C<int> { void f() { g(); this->h(); o.k(); ns::s(); T::make<int>(); new D(); } };\n',
    calls: ['A.f > g', 'A.f > self.h', 'A.f > o.k', 'A.f > ns.s', 'A.f > T.make', 'A.f > new D'],
    bases: ['A extends B', 'A extends ns::C'],
    decorators: [],
    handlers: []
  },
  {
    grammar: 'rust',
    code: `struct S;
impl Tr for S { fn t(&self) { helper(); Self::new(); self.go(); crate::a::b(); println!("{}", m::f(1)); } }
trait Tr: Base {}
#[get("/x")]
fn index() {}
`,
    calls: ['S.t > helper', 'S.t > self.new', 'S.t > self.go', 'S.t > crate::a.b', 'S.t > m.f'],
    bases: ['S implements Tr', 'Tr extends Base'],
    decorators: ['index: get'],
    handlers: ['index']
  },
  {
    grammar: 'java',
    code: `package a;
@RestController
class A extends B implements I {
  @GetMapping("/x") String m() { n(); this.o(); C.s(); new D<>(); obj.p(); super.q(); return ""; }
}
`,
    calls: ['A.m > n', 'A.m > self.o', 'A.m > C.s', 'A.m > new D', 'A.m > obj.p', 'A.m > super.q'],
    bases: ['A extends B', 'A implements I'],
    decorators: ['A: RestController', 'm: GetMapping'],
    handlers: ['m']
  },
  {
    grammar: 'go',
    code: 'package p\ntype S struct {\n\tBase\n\t*Other\n\tx int\n}\nfunc (s *S) M() { f(); s.N(); pkg.G() }\n',
    calls: ['S.M > f', 'S.M > s.N', 'S.M > pkg.G'],
    bases: ['S extends Base', 'S extends Other'],
    decorators: [],
    handlers: []
  },
  {
    grammar: 'lua',
    code: 'local g = require("g")\nlocal M = {}\nfunction M.f() h(); M.k(); obj:m(); g.go() end\nreturn M\n',
    calls: [' > require', 'M.f > h', 'M.f > M.k', 'M.f > obj.m', 'M.f > g.go'],
    bases: [],
    decorators: [],
    handlers: []
  },
  {
    grammar: 'gdscript',
    code: 'extends Node\nconst G = preload("res://g.gd")\nclass B extends A:\n\tfunc z(): pass\nfunc f():\n\tg(1)\n\tself.h()\n\tG.new().go()\n',
    calls: [' > preload', 'f > g', 'f > self.h', 'f > G.new', 'f > G.go'],
    bases: [' extends Node', 'B extends A'],
    decorators: [],
    handlers: []
  },
  {
    grammar: 'ruby',
    code: 'class UsersController < ApplicationController\n  include M\n  def index\n    g(1)\n    self.h(2)\n    Greeting.new.start\n  end\n  def _x; end\nend\n',
    calls: ['UsersController > include', 'UsersController.index > g', 'UsersController.index > self.h', 'UsersController.index > Greeting.new', 'UsersController.index > Greeting.start'],
    bases: ['UsersController extends ApplicationController', 'UsersController implements M'],
    decorators: [],
    handlers: ['index']
  },
  {
    grammar: 'php',
    code: '<?php\nclass A extends B implements I { #[Route("/x")] public function f() { g(1); $this->h(); C::k(); self::j(); parent::p(); new D(); (new E())->go(); } }\n',
    calls: ['A.f > g', 'A.f > self.h', 'A.f > C.k', 'A.f > self.j', 'A.f > super.p', 'A.f > new D', 'A.f > E.go', 'A.f > new E'],
    bases: ['A extends B', 'A implements I'],
    decorators: ['f: Route'],
    handlers: ['f']
  }
];
