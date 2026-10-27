// Java pack (docs/language-breadth.md, "Java"): a class per graph, generated from Visual IR, run by
// a small launcher compiled with it. Close to the C# pack; where Java differs: functions with several
// outputs return them as an Object[], ints are longs, strings compare with equals, and a method's
// end must be reachable before it returns a default.
import { IrCallee, IrCodeHelper, IrExpr, IrFunction, IrProgram, IrStatement, calleeSignature, classInfo, exprType, interfaceInfo, programClassSpec, userTypes } from '../compiler/ir';
import { ClassMemberNames, ClassMemberStyles, InheritedMembers, NameScope, claimClassMembers, dedent } from '../compiler/names';
import { CodeWriter } from '../compiler/writer';
import { CodeGenerator, GenerateOptions, GeneratedCode, LanguagePack, PinExpression, RunContext } from '../language-pack';
import type { ClassInfo, InterfaceInfo } from '../objects';
import { TypeRef, parseTypeId } from '../types';
import { EnumInfo, StructInfo, UserType, isUserTypeId } from '../user-types';

const RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface',
  'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch',
  'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null', 'var', 'record',
  'yield', 'sealed', 'permits', 'non', '_',
  // Not keywords, but a member with these names would hide what generated code uses.
  'java', 'Math', 'String', 'Object', 'System', 'Long', 'Double', 'Boolean', 'Runnable', 'results'
]);

// Helper methods emitted into the generated class on demand. They implement docs/semantics.md
// ("Values") exactly as Simulate does, so output matches the other targets.
const HELPER_NAMES = ['formatValue', 'formatNumber', 'toJson', 'jsonString', 'toNumber', 'toBoolean', 'asLong', 'asDouble', 'asBoolean', 'asString', 'mapOf', 'delay', 'latentQueue', 'latentClock', 'runLatentActions', 'EventDispatcher'];

function helpers(className: string, enums: boolean, structs: boolean): Record<'format' | 'number' | 'boolean' | 'as' | 'map' | 'latent', string[]> {
  return {
    latent: [
      '// Latent actions of every class run from one queue (kept in the system properties), in the',
      '// order they fall due, once start() has returned: runLatentActions() runs them.',
      '@SuppressWarnings("unchecked")',
      'private static java.util.List<Object[]> latentQueue() {',
      '    var properties = System.getProperties();',
      '    var queue = (java.util.List<Object[]>) properties.get("blueprint.latent");',
      '    if (queue == null) {',
      '        queue = new ArrayList<>();',
      '        properties.put("blueprint.latent", queue);',
      '        properties.put("blueprint.latent.clock", System.nanoTime());',
      `        properties.put("blueprint.latent.run", (Runnable) ${className}::runLatentActions);`,
      '    }',
      '    return queue;',
      '}',
      '',
      'private static double latentClock() {',
      '    return (System.nanoTime() - (long) System.getProperties().get("blueprint.latent.clock")) / 1e9;',
      '}',
      '',
      'private static void delay(double seconds, Runnable then) {',
      '    var queue = latentQueue();',
      '    long order = 0;',
      '    for (var entry : queue) order = Math.max(order, (long) entry[1] + 1);',
      '    queue.add(new Object[] { latentClock() + Math.max(0, seconds), order, then });',
      '}',
      '',
      'public static void runLatentActions() {',
      '    var queue = latentQueue();',
      '    while (!queue.isEmpty()) {',
      '        var next = queue.get(0);',
      '        for (var entry : queue) {',
      '            if ((double) entry[0] < (double) next[0] || ((double) entry[0] == (double) next[0] && (long) entry[1] < (long) next[1])) next = entry;',
      '        }',
      '        queue.remove(next);',
      '        double wait = (double) next[0] - latentClock();',
      '        if (wait > 0) {',
      '            try {',
      '                Thread.sleep((long) Math.ceil(wait * 1000));',
      '            } catch (InterruptedException error) {',
      '                Thread.currentThread().interrupt();',
      '            }',
      '        }',
      '        ((Runnable) next[2]).run();',
      '    }',
      '}'
    ],
    format: [
      'private static String formatValue(Object value) {',
      '    if (value == null) return "";',
      '    if (value instanceof Boolean b) return b ? "true" : "false";',
      '    if (value instanceof String s) return s;',
      '    if (value instanceof Number n) return formatNumber(n.doubleValue());',
      ...(enums ? ['    if (value instanceof Enum<?> e) return e.toString();'] : []),
      '    return toJson(value);',
      '}',
      '',
      '// Containers print as JSON, numbers by the rules below: sets in ascending order (they have no',
      '// order of their own), maps in the order their keys were added.',
      '@SuppressWarnings("unchecked")',
      'private static String toJson(Object value) {',
      '    if (value == null) return "null";',
      '    if (value instanceof Boolean b) return b ? "true" : "false";',
      '    if (value instanceof String s) return jsonString(s);',
      '    if (value instanceof Number n) return Double.isFinite(n.doubleValue()) ? formatNumber(n.doubleValue()) : "null";',
      ...(enums ? ['    if (value instanceof Enum<?> e) return jsonString(e.toString());'] : []),
      '    if (value instanceof java.util.Map<?, ?> map) {',
      '        var entries = new ArrayList<String>();',
      '        for (var entry : map.entrySet()) entries.add(jsonString(entry.getKey() instanceof String key ? key : formatValue(entry.getKey())) + ":" + toJson(entry.getValue()));',
      '        return "{" + String.join(",", entries) + "}";',
      '    }',
      '    if (value instanceof java.util.Collection<?> items) {',
      '        var list = new ArrayList<Object>(items);',
      '        if (value instanceof java.util.Set<?>) list.sort((a, b) -> ((Comparable<Object>) a).compareTo(b));',
      '        var parts = new ArrayList<String>();',
      '        for (var item : list) parts.add(toJson(item));',
      '        return "[" + String.join(",", parts) + "]";',
      '    }',
      ...(structs ? [
        '    try {',
        '        var fields = (Object[][]) value.getClass().getMethod("blueprintFields").invoke(value);',
        '        var parts = new ArrayList<String>();',
        '        for (var field : fields) parts.add(jsonString((String) field[0]) + ":" + toJson(field[1]));',
        '        return "{" + String.join(",", parts) + "}";',
        '    } catch (ReflectiveOperationException error) {',
        '        // Not a struct.',
        '    }'
      ] : []),
      '    return jsonString(value.toString());',
      '}',
      '',
      'private static String jsonString(String text) {',
      '    var json = new StringBuilder("\\"");',
      '    for (char c : text.toCharArray()) {',
      '        switch (c) {',
      '            case \'"\' -> json.append("\\\\\\"");',
      '            case \'\\\\\' -> json.append("\\\\\\\\");',
      '            case \'\\n\' -> json.append("\\\\n");',
      '            case \'\\r\' -> json.append("\\\\r");',
      '            case \'\\t\' -> json.append("\\\\t");',
      '            case \'\\b\' -> json.append("\\\\b");',
      '            case \'\\f\' -> json.append("\\\\f");',
      '            default -> {',
      '                if (c < 0x20) json.append(String.format("\\\\u%04x", (int) c));',
      '                else json.append(c);',
      '            }',
      '        }',
      '    }',
      '    return json.append(\'"\').toString();',
      '}',
      '',
      '// JavaScript\'s number-to-text rules, so every target language prints numbers the same way.',
      'private static String formatNumber(double x) {',
      '    if (Double.isNaN(x)) return "NaN";',
      '    if (Double.isInfinite(x)) return x > 0 ? "Infinity" : "-Infinity";',
      '    if (x == 0) return "0";',
      '    String sign = x < 0 ? "-" : "";',
      '    String text = Double.toString(Math.abs(x));',
      '    int e = text.indexOf(\'E\');',
      '    String mantissa = e < 0 ? text : text.substring(0, e);',
      '    int exponent = e < 0 ? 0 : Integer.parseInt(text.substring(e + 1));',
      '    int dot = mantissa.indexOf(\'.\');',
      '    String whole = dot < 0 ? mantissa : mantissa.substring(0, dot);',
      '    String all = whole + (dot < 0 ? "" : mantissa.substring(dot + 1));',
      '    String digits = all.replaceFirst("^0+", "");',
      '    int point = whole.length() + exponent - (all.length() - digits.length());',
      '    digits = digits.replaceFirst("0+$", "");',
      '    if (digits.length() <= point && point <= 21) return sign + digits + "0".repeat(point - digits.length());',
      '    if (0 < point && point <= 21) return sign + digits.substring(0, point) + "." + digits.substring(point);',
      '    if (-6 < point && point <= 0) return sign + "0." + "0".repeat(-point) + digits;',
      '    String rest = digits.length() > 1 ? "." + digits.substring(1) : "";',
      '    return sign + digits.charAt(0) + rest + "e" + (point > 0 ? "+" : "-") + Math.abs(point - 1);',
      '}'
    ],
    number: [
      'private static double toNumber(Object value) {',
      '    if (value == null) return 0;',
      '    if (value instanceof Boolean b) return b ? 1 : 0;',
      '    if (value instanceof Number n) return n.doubleValue();',
      '    if (value instanceof String s) {',
      '        String text = s.strip();',
      '        if (text.isEmpty()) return 0;',
      '        if (text.equals("Infinity") || text.equals("+Infinity")) return Double.POSITIVE_INFINITY;',
      '        if (text.equals("-Infinity")) return Double.NEGATIVE_INFINITY;',
      '        return text.matches("[+-]?([0-9]+\\\\.?[0-9]*|\\\\.[0-9]+)([eE][+-]?[0-9]+)?") ? Double.parseDouble(text) : Double.NaN;',
      '    }',
      '    return Double.NaN;',
      '}'
    ],
    boolean: [
      'private static boolean toBoolean(Object value) {',
      '    if (value == null) return false;',
      '    if (value instanceof Boolean b) return b;',
      '    if (value instanceof String s) return !s.isEmpty();',
      '    if (value instanceof Number n) return n.doubleValue() != 0 && !Double.isNaN(n.doubleValue());',
      '    return true;',
      '}'
    ],
    // A value of unknown type, used where a typed one is needed.
    as: [
      'private static long asLong(Object value) {',
      '    return value instanceof Number n ? n.longValue() : value instanceof Boolean b ? (b ? 1 : 0) : 0;',
      '}',
      '',
      'private static double asDouble(Object value) {',
      '    return value instanceof Number n ? n.doubleValue() : toNumber(value);',
      '}',
      '',
      'private static boolean asBoolean(Object value) {',
      '    return toBoolean(value);',
      '}',
      '',
      'private static String asString(Object value) {',
      '    return value instanceof String s ? s : formatValue(value);',
      '}'
    ],
    map: [
      '@SuppressWarnings("unchecked")',
      'private static <K, V> LinkedHashMap<K, V> mapOf(Object... items) {',
      '    var map = new LinkedHashMap<K, V>();',
      '    for (int i = 0; i + 1 < items.length; i += 2) map.put((K) items[i], (V) items[i + 1]);',
      '    return map;',
      '}'
    ]
  };
}

// Unreal's event dispatcher, emitted when the class declares one: handlers are kept with the object
// and function they call, so binding twice adds one and Unbind finds it; they run in the order they
// were bound.
const DISPATCHER_CLASS = [
  'public static final class EventDispatcher {',
  '    private final java.util.List<Object[]> handlers = new ArrayList<>();',
  '',
  '    public void bind(Object owner, String name, java.util.function.Consumer<Object[]> run) {',
  '        for (var handler : handlers) if (handler[0] == owner && handler[1].equals(name)) return;',
  '        handlers.add(new Object[] { owner, name, run });',
  '    }',
  '',
  '    public void unbind(Object owner, String name) {',
  '        handlers.removeIf(handler -> handler[0] == owner && handler[1].equals(name));',
  '    }',
  '',
  '    public void clear() {',
  '        handlers.clear();',
  '    }',
  '',
  '    // A copy, so events that bind or unbind while running don\'t disturb the loop.',
  '    @SuppressWarnings("unchecked")',
  '    public java.util.List<java.util.function.Consumer<Object[]>> handlers() {',
  '        var copy = new ArrayList<java.util.function.Consumer<Object[]>>();',
  '        for (var handler : handlers) copy.add((java.util.function.Consumer<Object[]>) handler[2]);',
  '        return copy;',
  '    }',
  '}'
];

const PRIMITIVES: Record<string, string> = { bool: 'boolean', int: 'long', float: 'double', string: 'String', any: 'Object', wildcard: 'Object' };
const BOXED: Record<string, string> = { boolean: 'Boolean', long: 'Long', double: 'Double' };

// Types from project code (native) are passed on as Object.
function mapType(type: TypeRef): string {
  const { category, name } = parseTypeId(type.id);
  const element = PRIMITIVES[type.id] ?? (category === 'native' ? 'Object' : name);
  const boxed = (text: string) => BOXED[text] ?? text;
  if (type.container === 'array') return `ArrayList<${boxed(element)}>`;
  if (type.container === 'set') return `LinkedHashSet<${boxed(element)}>`;
  if (type.container === 'map') return `LinkedHashMap<${boxed(element)}, ${boxed(type.valueType ? mapType(type.valueType) : 'Object')}>`;
  return type.nullable ? boxed(element) : element;
}

// The class a graph file generates: Java requires a public class's file to carry its name.
export function javaClassName(name: string): string {
  return new NameScope(RESERVED).claim(name, 'pascal');
}

export function javaOutputFileName(graphFileName: string): string {
  return `${javaClassName(graphFileName.replace(/\.vgraph$/i, ''))}.java`;
}

// The launcher Run compiles with the generated file: it calls the class's start() (the class is the
// first argument), then the Main method the second names (if any) with the rest, then the latent
// actions. With --test first: each test, given as name and method, on a new object.
export const JAVA_LAUNCHER = [
  '// Built by Blueprint Visual Scripting to run generated Java. Safe to delete.',
  'import java.lang.reflect.InvocationTargetException;',
  'import java.lang.reflect.Method;',
  'import java.util.ArrayList;',
  'import java.util.Arrays;',
  '',
  'public final class BlueprintRun {',
  '    public static void main(String[] args) throws Exception {',
  '        if (args.length > 0 && args[0].equals("--test")) System.exit(test(args));',
  '        Class<?> type = Class.forName(args[0]);',
  '        try {',
  '            Object instance = construct(type);',
  '            find(type, "start").invoke(instance);',
  '            if (args.length > 1 && !args[1].isEmpty()) find(type, args[1]).invoke(instance, new ArrayList<>(Arrays.asList(args).subList(2, args.length)));',
  '            runLatentActions();',
  '        } catch (InvocationTargetException error) {',
  '            System.out.flush();',
  '            error.getCause().printStackTrace();',
  '            System.exit(1);',
  '        }',
  '    }',
  '',
  '    private static int test(String[] args) throws Exception {',
  '        Class<?> type = Class.forName(args[1]);',
  '        int failed = 0;',
  '        for (int i = 2; i + 1 < args.length; i += 2) {',
  '            try {',
  '                find(type, args[i + 1]).invoke(construct(type));',
  '                runLatentActions();',
  '                System.out.println("PASS " + args[i]);',
  '            } catch (InvocationTargetException error) {',
  '                failed++;',
  '                System.out.println("FAIL " + args[i] + ": " + error.getCause().getMessage());',
  '            }',
  '        }',
  '        System.out.println(failed == 0 ? "All tests passed." : failed + " test(s) failed.");',
  '        return failed == 0 ? 0 : 1;',
  '    }',
  '',
  '    private static Object construct(Class<?> type) throws Exception {',
  '        var constructor = type.getDeclaredConstructor();',
  '        constructor.setAccessible(true);',
  '        return constructor.newInstance();',
  '    }',
  '',
  '    // The nearest declaration of the method: a subclass\'s, else an ancestor\'s.',
  '    private static Method find(Class<?> type, String name) {',
  '        for (Class<?> t = type; t != null; t = t.getSuperclass()) {',
  '            for (Method method : t.getDeclaredMethods()) {',
  '                if (method.getName().equals(name)) {',
  '                    method.setAccessible(true);',
  '                    return method;',
  '                }',
  '            }',
  '        }',
  '        throw new IllegalStateException("No method named " + name);',
  '    }',
  '',
  '    private static void runLatentActions() {',
  '        if (System.getProperties().get("blueprint.latent.run") instanceof Runnable run) run.run();',
  '    }',
  '}',
  ''
].join('\n');

const classes = (context: RunContext | undefined) => `${context?.scaffoldDir}/classes`;
const JAVA_ARGS = ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'];

const javaBuild = (file: { path: string }, _className: string, context: RunContext) => [
  '-d', classes(context), '-encoding', 'UTF-8', '-g', '-nowarn', '-Xlint:none', `${context.scaffoldDir}/BlueprintRun.java`, file.path, ...(context.sources ?? [])
];

// A function library's class and the names its functions are defined as (camelCase, unique in the
// class). The library's own generated file and every file that calls it use these.
export function javaLibraryExports(libraryName: string, functions: { id: string; name: string }[]): { names: Map<string, string>; container: string } {
  const container = javaClassName(libraryName);
  const scope = new NameScope(RESERVED, [container, ...HELPER_NAMES]);
  return { names: new Map(functions.map((f) => [f.id, scope.claim(f.name, 'camel')])), container };
}

// Component names of a struct's record and constant names of an enum, the same in the type's own
// file and in every file that uses it.
export function javaFieldNames(type: StructInfo): Map<string, string> {
  const scope = new NameScope(RESERVED, ['blueprintFields', 'equals', 'hashCode', 'toString']);
  return new Map(type.fields.map((f) => [f.id, scope.claim(f.name, 'camel')]));
}

export function javaEnumMembers(type: EnumInfo): Map<string, string> {
  const scope = new NameScope(RESERVED, ['text', 'values', 'valueOf']);
  return new Map(type.enumerators.map((e) => [e.id, scope.claim(e.name, 'pascal')]));
}

// How a class's public members are named (src/core/compiler/names.ts).
const CLASS_STYLES: ClassMemberStyles = { functions: 'camel', variables: 'camel', dispatchers: 'camel' };

function classScope(className: string): NameScope {
  return new NameScope(RESERVED, ['start', className, ...HELPER_NAMES]);
}

const javaGenerator: CodeGenerator = {
  libraryExports: javaLibraryExports,
  snippetLanguages: ['java'],
  importLanguages: ['java'],
  outputFileName: javaOutputFileName,
  moduleName: (_generatedFileName, options) => options.namespace,
  generate: (program, options) => new JavaEmitter(program, options).emit(),
  runner: {
    commands: () => [['javac']],
    scaffold: () => ({ 'BlueprintRun.java': JAVA_LAUNCHER }),
    build: javaBuild,
    executable: () => 'java',
    args: (_file, className, context) => [...JAVA_ARGS, '-cp', classes(context), 'BlueprintRun', className, context?.mainMethod ?? '', ...(context?.args ?? [])],
    testArgs: (_file, className, context) => [...JAVA_ARGS, '-cp', classes(context), 'BlueprintRun', '--test', className, ...context.tests.flatMap((t) => [t.name, t.method])],
    missingToolMessage: 'The JDK was not found. Install a JDK (17 or later) and make sure `javac` and `java` are on the PATH.'
  },
  // Microsoft's Debugger for Java runs the launcher, built with debug information first.
  debugger: {
    type: 'java',
    extension: { id: 'vscjava.vscode-java-debug', name: 'Debugger for Java' },
    build: javaBuild,
    configuration: (_file, className, context) => ({
      type: 'java', request: 'launch', mainClass: 'BlueprintRun', classPaths: [classes(context)], args: [className, context.mainMethod ?? '', ...(context.args ?? [])],
      vmArgs: JAVA_ARGS.join(' '), cwd: context.cwd, console: 'internalConsole', stopOnEntry: false
    })
  }
};

export const javaPack: LanguagePack = {
  id: 'java',
  displayName: 'Java',
  generatedFileExtension: '.java',
  workspaceMarkers: ['**/pom.xml', '**/build.gradle', '**/build.gradle.kts'],
  capabilities: { staticTyping: true, classes: true, inheritance: true, interfaces: true, generics: true, async: true, exceptions: true, containers: ['array', 'set', 'map'], delegates: true },
  mapType,
  generator: javaGenerator
};

class JavaEmitter {
  private tests: { name: string; method: string }[] = [];
  private readonly out = new CodeWriter('    ');
  private readonly names: NameScope;
  private readonly memberNames = new Map<string, string>();
  private readonly slotNames = new Map<string, string>();
  private readonly helperNames = new Map<string, string>();
  private readonly blockNames = new Map<string, string>();
  private readonly functionNames = new Map<string, string>();
  private readonly dispatcherNames = new Map<string, string>();
  private readonly paramNames = new Map<string, string>();
  private readonly className: string;
  private readonly helpersUsed = new Set<'format' | 'number' | 'boolean' | 'as' | 'map' | 'latent'>();
  private readonly library: boolean;
  private readonly types: Map<string, UserType>;
  private readonly classNames = new Map<string, ClassMemberNames>();
  // The function graph being written, whose outputs Return Nodes give.
  private currentFunction: IrFunction | undefined;

  constructor(private readonly program: IrProgram, private readonly options: GenerateOptions) {
    this.library = !!program.library;
    this.className = javaClassName(program.className);
    this.types = userTypes(program);
    if (program.declaration) this.types.set(program.declaration.type.id, program.declaration.type);
    // A library's functions are claimed first, exactly as javaLibraryExports claims them.
    this.names = this.library ? new NameScope(RESERVED, [this.className, ...HELPER_NAMES]) : classScope(this.className);
    const own = claimClassMembers(this.names, programClassSpec(program), CLASS_STYLES, this.inheritedMembers(program.classInfo));
    this.classNames.set(`object:${program.className}`, own);
    for (const f of program.functions) this.functionNames.set(f.id, (f.event ? own.events : own.functions).get(f.id)!);
    for (const [id, name] of own.variables) this.memberNames.set(id, name);
    for (const [id, name] of own.dispatchers) this.dispatcherNames.set(id, name);
    for (const s of program.slots) if (!s.function) this.slotNames.set(s.id, this.names.claim(s.name, 'keep', '_'));
    for (const b of program.blocks) this.blockNames.set(b.id, this.names.claim(b.name, 'camel'));
    for (const h of program.helpers) this.helperNames.set(h.id, this.names.claim(h.name, 'camel'));
  }

  emit(): GeneratedCode {
    const body = this.out;
    if (this.program.declaration) return this.emitDeclaration();
    body.indent();
    const members = this.program.members.filter((m) => !m.function);
    const slots = this.program.slots.filter((x) => !x.function);
    const dispatchers = this.program.dispatchers ?? [];
    for (const m of members) body.line(`${m.access ?? 'public'} ${this.typeName(m.type)} ${this.memberNames.get(m.id)} = ${this.coerce(m.initial, m.type)};`);
    for (const d of dispatchers) body.line(`public final EventDispatcher ${this.dispatcherNames.get(d.id)} = new EventDispatcher();`);
    for (const x of slots) body.line(`private ${this.typeName(x.type)} ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)};`);
    if (members.length || slots.length || dispatchers.length) body.line();
    // A subclass without Start nodes keeps its parent's start, as Unreal keeps BeginPlay.
    const parent = this.program.classInfo?.parent;
    if (!this.library && (!parent || this.program.hasStart)) this.method('public', 'start', [], undefined, () => this.statements(this.program.start));
    for (const fn of this.program.functions) this.functionMethod(fn);
    // The interface functions the class gives no body: they do nothing and return defaults.
    for (const { type, stubs } of this.program.interfaces ?? []) {
      for (const fn of stubs) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => ({ name: scope.claim(p.name, 'camel'), type: p.type }));
        const outputs = fn.outputs.filter((p) => p.kind === 'data');
        this.method('public', this.interfaceNames(type).functions.get(fn.id)!, params, outputs.length > 1 ? 'Object[]' : outputs[0]?.type, () => {
          if (outputs.length === 1) this.out.line(`return ${this.defaultFor(outputs[0].type)};`);
          else if (outputs.length) this.out.line(`return new Object[] { ${outputs.map((o) => this.defaultFor(o.type)).join(', ')} };`);
        });
      }
    }
    // Test Case events: methods Run Tests calls, named after every other member.
    this.tests = (this.program.tests ?? []).map((t) => ({ name: t.name, method: this.names.claim(`test ${t.name}`, 'camel') }));
    this.program.tests?.forEach((t, i) => this.method('public', this.tests[i].method, [], undefined, () => this.statements(t.body)));
    for (const block of this.program.blocks) this.method('private', this.blockNames.get(block.id)!, [], undefined, () => this.statements(block.body));
    for (const helper of this.program.helpers) this.helperMethod(helper);
    if (dispatchers.length) {
      body.line("// Unreal's event dispatcher: bound events run in the order they were bound, each event once.");
      for (const line of DISPATCHER_CLASS) body.line(line);
      body.line();
    }
    this.writeHelpers();
    body.trimTrailingBlank();
    body.dedent();

    const header = this.header();
    const parentClass = this.program.classInfo?.parent;
    const interfaces = (this.program.interfaces ?? []).map((i) => this.userTypeName(i.type.id));
    header.line(`${this.access()}${this.library ? 'final ' : ''}class ${this.className}${parentClass ? ` extends ${this.userTypeName(parentClass)}` : ''}${interfaces.length ? ` implements ${interfaces.join(', ')}` : ''} {`);
    return this.finish(header, body);
  }

  // A public class must be in a file named after it; a graph whose name differs from its file's
  // generates a class of its package only.
  private access(): string {
    return javaOutputFileName(this.options.sourceFileName) === `${this.className}.java` ? 'public ' : '';
  }

  private writeHelpers(): void {
    const kinds = [...this.types.values()].map((t) => t.kind);
    const all = helpers(this.className, kinds.includes('enum'), kinds.includes('struct'));
    if (this.helpersUsed.has('as')) this.helpersUsed.add('format').add('number').add('boolean');
    for (const helper of ['format', 'number', 'boolean', 'as', 'map', 'latent'] as const) {
      if (!this.helpersUsed.has(helper)) continue;
      for (const line of all[helper]) this.out.line(line);
      this.out.line();
    }
  }

  // The file's header: what it is, its package and imports.
  private header(): CodeWriter {
    const header = new CodeWriter('    ');
    header.line(`// Generated by Blueprint Visual Scripting from ${this.options.sourceFileName}.`);
    header.line('// Do not edit: changes are overwritten when the graph is compiled.');
    if (this.options.namespace) {
      header.line();
      header.line(`package ${this.options.namespace};`);
    }
    header.line();
    header.line('import java.util.ArrayList;');
    header.line('import java.util.LinkedHashMap;');
    header.line('import java.util.LinkedHashSet;');
    header.line();
    return header;
  }

  // A structure (a record: immutable, so Set Members makes a new one, as Unreal copies structs), an
  // enumeration (an enum whose values print their names) or an interface.
  private emitDeclaration(): GeneratedCode {
    const header = this.header();
    const body = this.out;
    const declaration = this.program.declaration!;
    body.indent();
    if (declaration.kind === 'interface') {
      const names = this.interfaceNames(declaration.type);
      header.line(`${this.access()}interface ${this.className} {`);
      for (const fn of declaration.type.functions) {
        const scope = new NameScope(RESERVED);
        const params = fn.inputs.filter((p) => p.kind === 'data').map((p) => `${this.typeName(p.type)} ${scope.claim(p.name, 'camel')}`).join(', ');
        body.line(`${this.interfaceResult(fn)} ${names.functions.get(fn.id)}(${params});`);
      }
    } else if (declaration.kind === 'enum') {
      const members = javaEnumMembers(declaration.type);
      header.line(`${this.access()}enum ${this.className} {`);
      declaration.type.enumerators.forEach((e, i) => body.line(`${members.get(e.id)}(${literal(e.name)})${i < declaration.type.enumerators.length - 1 ? ',' : ';'}`));
      if (!declaration.type.enumerators.length) body.line(';');
      body.line();
      body.line('private final String text;');
      body.line();
      body.line(`${this.className}(String text) {`);
      body.line('    this.text = text;');
      body.line('}');
      body.line();
      body.line('@Override');
      body.line('public String toString() {');
      body.line('    return text;');
      body.line('}');
    } else {
      const type = declaration.type;
      const fields = javaFieldNames(type);
      header.line(`${this.access()}record ${this.className}(${type.fields.map((f) => `${this.typeName(f.type)} ${fields.get(f.id)}`).join(', ')}) {`);
      body.line(`public ${this.className}() {`);
      body.line(`    this(${type.fields.map((f, i) => this.coerce(declaration.initial[i], f.type)).join(', ')});`);
      body.line('}');
      body.line();
      body.line('// As Print shows it: each field by name, in order.');
      body.line('public Object[][] blueprintFields() {');
      body.line(`    return new Object[][] { ${type.fields.map((f) => `{ ${literal(f.name)}, ${fields.get(f.id)} }`).join(', ')} };`);
      body.line('}');
    }
    this.writeHelpers();
    body.trimTrailingBlank();
    body.dedent();
    return this.finish(header, body);
  }

  private finish(header: CodeWriter, body: CodeWriter): GeneratedCode {
    const headerText = header.toString();
    const offset = headerText.split('\n').length - 1;
    const importedFiles = [...new Set(this.program.imports.map((i) => i.path).filter((path) => path))].sort();
    const main = this.program.functions.find((f) => f.event?.entry === 'Main');
    return {
      text: `${headerText}${body.toString()}}\n`,
      className: this.options.namespace ? `${this.options.namespace}.${this.className}` : this.className,
      nodeLines: body.nodeLines.map((n) => ({ ...n, line: n.line + offset })),
      codeBreaks: body.breaks.map((line) => line + offset),
      ...(importedFiles.length ? { importedFiles } : {}),
      ...(main ? { mainMethod: this.functionNames.get(main.id) } : {}),
      ...this.pinExpressions(),
      ...(this.tests.length ? { tests: this.tests } : {})
    };
  }

  private pinExpressions(): { pinExpressions?: PinExpression[] } {
    const pins = (this.program.pinValues ?? []).map((p) => ({ graphId: p.graphId, nodeId: p.nodeId, pinId: p.pinId, expression: this.expr(p.value) }));
    return pins.length ? { pinExpressions: pins } : {};
  }

  // ---- Class members ------------------------------------------------------------------------

  // `returns` is a type, or the text of one (Object[] for several outputs).
  private method(access: string, name: string, params: { name: string; type?: TypeRef }[], returns: TypeRef | string | undefined, body: () => void): void {
    this.out.endNode();
    const list = params.map((p) => `${this.typeName(p.type)} ${p.name}`).join(', ');
    this.out.line(`${access}${this.library ? ' static' : ''} ${typeof returns === 'string' ? returns : returns ? this.typeName(returns) : 'void'} ${name}(${list}) {`);
    this.out.indent();
    body();
    this.out.dedent();
    this.out.line('}');
    this.out.line();
  }

  private functionMethod(fn: IrFunction): void {
    const scope = new NameScope(RESERVED);
    const params = fn.params.map((p) => {
      const name = scope.claim(p.name, 'camel');
      this.paramNames.set(`${fn.id}\u0000${p.id}`, name);
      return { name, type: p.type };
    });
    const locals = this.program.members.filter((m) => m.function === fn.id);
    for (const m of locals) this.memberNames.set(m.id, scope.claim(m.name, 'camel'));
    const slots = this.program.slots.filter((x) => x.function === fn.id);
    for (const x of slots) this.slotNames.set(x.id, scope.claim(x.name, 'keep', '_'));
    const returns = fn.outputs.length > 1 ? 'Object[]' : fn.outputs[0]?.type ?? undefined;
    if (fn.description) this.out.line(`/** ${fn.description.replace(/\*\//g, '* /').replace(/\s+/g, ' ')} */`);
    const access = this.library ? 'public' : fn.access ?? 'public';
    this.method(access, this.functionNames.get(fn.id)!, params, returns, () => {
      for (const store of fn.event?.stores ?? []) this.out.line(`${this.slotNames.get(store.slot)} = ${this.paramNames.get(`${fn.id}\u0000${store.param}`)};`);
      for (const m of locals) this.out.line(`${this.typeName(m.type)} ${this.memberNames.get(m.id)} = ${this.coerce(m.initial, m.type)};`);
      for (const x of slots) this.out.line(`${this.typeName(x.type)} ${this.slotNames.get(x.id)} = ${this.defaultFor(x.type)};`);
      this.currentFunction = fn;
      this.statements(fn.body);
      this.currentFunction = undefined;
      // Reaching the end without a Return Node returns the outputs' defaults; Java refuses the
      // return when the end can't be reached.
      if (fn.outputs.length && canComplete(fn.body)) this.out.line(`return ${this.result(fn, fn.outputs.map((o) => this.defaultFor(o.type)))};`);
    });
  }

  private result(fn: IrFunction, values: string[]): string {
    return fn.outputs.length === 1 ? values[0] : `new Object[] { ${values.join(', ')} }`;
  }

  // A code node's snippet as a method; inputs that are valid identifiers keep their ids.
  private helperMethod(helper: IrCodeHelper): void {
    const scope = new NameScope(RESERVED);
    const params = helper.params.map((p, i) => ({
      pinId: p.pinId,
      name: /^[A-Za-z_]\w*$/.test(p.pinId) && !RESERVED.has(p.pinId) ? scope.claim(p.pinId) : scope.claim(`pin${i}`),
      type: p.type
    }));
    const byPin = new Map(params.map((p) => [p.pinId, p.name]));
    const code = helper.code.replace(/\$\{([^}]+)\}/g, (_m, pin: string) => byPin.get(pin) ?? pin);
    this.method('private', this.helperNames.get(helper.id)!, params, helper.returns, () => {
      for (const line of dedent(code)) this.out.line(line);
    });
  }

  // ---- Statements ---------------------------------------------------------------------------

  private statements(statements: IrStatement[]): void {
    for (const s of statements) this.statement(s);
  }

  private statement(s: IrStatement): void {
    const { out } = this;
    if (s.kind === 'callBlock') out.endNode();
    else out.node(s.source, (text) => `// ${text}`);
    switch (s.kind) {
      case 'print':
        out.line(`System.out.println(${this.text(s.value)});`);
        break;
      case 'assert':
        out.line(`if (!(${this.expr(s.condition)})) throw new RuntimeException(${this.text(s.message)});`);
        break;
      case 'store': {
        const slot = this.program.slots.find((x) => x.id === s.slot);
        out.line(`${this.slotNames.get(s.slot)} = ${this.coerce(s.value, slot?.type)};`);
        break;
      }
      case 'setMember': {
        const member = this.program.members.find((m) => m.id === s.member);
        out.line(`${this.memberNames.get(s.member)} = ${this.coerce(s.value, member?.type)};`);
        break;
      }
      case 'if': {
        out.line(`if (${this.expr(s.condition)}) {`);
        this.block(s.then);
        // An if in the else branch from the same node (a Switch's cases) reads as `else if`.
        let rest = s.else;
        while (rest.length === 1 && rest[0].kind === 'if' && sameSource(rest[0], s)) {
          const inner: Extract<IrStatement, { kind: 'if' }> = rest[0];
          out.line(`} else if (${this.expr(inner.condition)}) {`);
          this.block(inner.then);
          rest = inner.else;
        }
        if (rest.length) {
          out.line('} else {');
          this.block(rest);
        }
        out.line('}');
        break;
      }
      case 'for': {
        const counter = this.slotNames.get(s.counter)!;
        const stop = s.stop ? ` && !${this.slotNames.get(s.stop)}` : '';
        out.line(`for (${counter} = ${this.coerce(s.first, INT)}; ${counter} <= ${this.coerce(s.last, INT)}${stop}; ${counter}++) {`);
        this.block(s.body);
        out.line('}');
        break;
      }
      case 'while':
        // A constant condition would make Java reject the code after an endless loop.
        out.line(`while (${s.condition.kind === 'literal' ? `Boolean.valueOf(${this.expr(s.condition)})` : this.expr(s.condition)}) {`);
        this.block(s.body);
        out.line('}');
        break;
      case 'forEach': {
        // The array is read before each pass, as Unreal's For Each Loop reads it.
        const index = this.slotNames.get(s.index)!;
        const element = this.program.slots.find((x) => x.id === s.element);
        const array = this.coerce(s.array, element?.type ? { ...element.type, container: 'array' } : undefined);
        const stop = s.stop ? ` && !${this.slotNames.get(s.stop)}` : '';
        out.line(`for (${index} = 0; ${index} < ${array}.size()${stop}; ${index}++) {`);
        out.indent();
        out.line(`${this.slotNames.get(s.element)} = ${array}.get((int) ${index});`);
        this.statements(s.body);
        out.dedent();
        out.line('}');
        break;
      }
      case 'call': {
        const call = this.call(s.callee, s.args);
        if (s.results) {
          // A library function with several outputs returns them as an Object[].
          const imported = this.program.imports.find((i) => i.id === s.callee.id);
          this.results(call, s.results.map((r) => ({ slot: r.slot, index: imported?.outputs?.findIndex((o) => o.id === r.output) ?? 0 })));
          break;
        }
        if (!s.resultSlot) {
          out.line(`${call};`);
          break;
        }
        const slot = this.program.slots.find((x) => x.id === s.resultSlot);
        const returns = calleeSignature(s.callee, this.program)?.returns;
        out.line(`${this.slotNames.get(s.resultSlot)} = ${sameType(returns, slot?.type) ? call : this.cast(call, returns, slot?.type)};`);
        break;
      }
      case 'callBlock':
        out.line(`${this.blockNames.get(s.block)}();`);
        break;
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === s.function)!;
        const call = this.functionCall(fn, s.args);
        if (!s.results.length) out.line(`${call};`);
        else if (fn.outputs.length === 1) out.line(`${this.slotNames.get(s.results[0].slot)} = ${call};`);
        else this.results(call, s.results.map((r) => ({ slot: r.slot, index: fn.outputs.findIndex((o) => o.id === r.output) })));
        break;
      }
      case 'bindEvent': {
        const event = this.functionNames.get(s.event)!;
        if (s.bind) out.line(`${this.dispatcherRef(s)}.bind(this, ${literal(event)}, ${this.handler(s.event)});`);
        else out.line(`${this.dispatcherRef(s)}.unbind(this, ${literal(event)});`);
        break;
      }
      case 'unbindAll':
        out.line(`${this.dispatcherRef(s)}.clear();`);
        break;
      case 'broadcast': {
        const other = s.target && s.type ? classInfo(this.program, s.type)?.dispatchers.find((d) => d.id === s.dispatcher)?.inputs.filter((p) => p.kind === 'data') : undefined;
        const params = other ?? this.program.dispatchers?.find((d) => d.id === s.dispatcher)?.params ?? [];
        out.line(`for (var handler : ${this.dispatcherRef(s)}.handlers()) handler.accept(new Object[] { ${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')} });`);
        break;
      }
      case 'delay': {
        this.helpersUsed.add('latent');
        if (s.generation) {
          // Retriggerable: only the latest start's countdown runs Completed.
          const generation = this.slotNames.get(s.generation)!;
          const started = `${generation}Started`;
          out.line(`var ${started} = ++${generation};`);
          out.line(`delay(${this.expr(s.duration)}, () -> {`);
          out.indent();
          out.line(`if (${started} != ${generation}) return;`);
          this.statements(s.then);
          out.dedent();
          out.line('});');
          break;
        }
        const pending = this.slotNames.get(s.pending!)!;
        out.line(`if (!${pending}) {`);
        out.indent();
        out.line(`${pending} = true;`);
        out.line(`delay(${this.expr(s.duration)}, () -> {`);
        out.indent();
        out.line(`${pending} = false;`);
        this.statements(s.then);
        out.dedent();
        out.line('});');
        out.dedent();
        out.line('}');
        break;
      }
      case 'cast': {
        const type = this.userTypeName(s.type);
        out.line(`if (${this.operand(s.value)} instanceof ${type}) {`);
        out.indent();
        out.line(`${this.slotNames.get(s.slot)} = (${type}) ${this.operand(s.value)};`);
        this.statements(s.succeeded);
        out.dedent();
        if (s.failed.length) {
          out.line('} else {');
          this.block(s.failed);
        }
        out.line('}');
        break;
      }
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, s.type);
        const fn = iface?.functions.find((f) => f.id === s.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(s.target)}.${iface ? this.interfaceNames(iface).functions.get(s.function) : s.function}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        this.callResults(call, outputs, s.results);
        break;
      }
      case 'parentCall': {
        if (s.start) {
          out.line('super.start();');
          break;
        }
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === s.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const outputs = fn?.outputs.filter((p) => p.kind === 'data') ?? [];
        const call = `super.${this.parentFunctionName(s.function!)}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        this.callResults(call, outputs, s.results);
        break;
      }
      case 'construct':
        out.line(`${this.slotNames.get(s.slot)} = new ${this.userTypeName(s.type)}();`);
        out.line(`${this.slotNames.get(s.slot)}.start();`);
        break;
      case 'setObjectVariable':
        out.line(`${this.targetRef(s.target)}.${this.membersOf(s.type)?.variables.get(s.variable)} = ${this.coerce(s.value, classInfo(this.program, s.type)?.variables.find((v) => v.id === s.variable)?.type)};`);
        break;
      case 'objectCall': {
        const info = classInfo(this.program, s.type);
        const names = this.membersOf(s.type);
        const fn = s.function !== undefined ? info?.functions.find((f) => f.id === s.function) : undefined;
        const params = (fn ? fn.inputs : info?.events.find((e) => e.id === s.event)?.inputs ?? []).filter((p) => p.kind === 'data');
        const name = s.function !== undefined ? names?.functions.get(s.function) : names?.events.get(s.event!);
        const call = `${this.targetRef(s.target)}.${name}(${s.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        this.callResults(call, fn?.outputs.filter((p) => p.kind === 'data') ?? [], s.results);
        break;
      }
      case 'return': {
        const fn = this.currentFunction ?? this.program.functions.find((f) => f.id === s.source.graphId);
        if (!fn || !fn.outputs.length) out.line('return;');
        else out.line(`return ${this.result(fn, fn.outputs.map((o, i) => this.coerce(s.values[i] ?? { kind: 'default', type: o.type }, o.type)))};`);
        break;
      }
    }
  }

  // A call of another class's or an interface's function: no outputs, one, or several in an Object[].
  private callResults(call: string, outputs: { id: string; type?: TypeRef }[], results: { output: string; slot: string }[]): void {
    if (!results.length) this.out.line(`${call};`);
    else if (outputs.length === 1) this.out.line(`${this.slotNames.get(results[0].slot)} = ${call};`);
    else this.results(call, results.map((r) => ({ slot: r.slot, index: outputs.findIndex((o) => o.id === r.output) })));
  }

  // Each output of an Object[] result into its slot.
  private results(call: string, results: { slot: string; index: number }[]): void {
    this.out.line('{');
    this.out.indent();
    this.out.line(`Object[] results = ${call};`);
    for (const r of results) this.out.line(`${this.slotNames.get(r.slot)} = ${this.fromObject(`results[${r.index}]`, this.program.slots.find((x) => x.id === r.slot)?.type)};`);
    this.out.dedent();
    this.out.line('}');
  }

  // A bound event: a handler taking the dispatcher's arguments as an Object[].
  private handler(eventId: string): string {
    const fn = this.program.functions.find((f) => f.id === eventId);
    const args = (fn?.params ?? []).map((p, i) => this.fromObject(`args[${i}]`, p.type));
    return `args -> ${this.functionNames.get(eventId)}(${args.join(', ')})`;
  }

  private block(statements: IrStatement[]): void {
    this.out.indent();
    this.statements(statements);
    this.out.dedent();
  }

  // ---- Expressions --------------------------------------------------------------------------

  private expr(e: IrExpr): string {
    switch (e.kind) {
      case 'literal':
        return literal(e.value);
      case 'default':
        return this.defaultFor(e.type);
      case 'member':
        return this.memberNames.get(e.member)!;
      case 'output':
        return this.slotNames.get(e.slot)!;
      case 'add':
        return `${this.operand(e.left)} + ${this.operand(e.right)}`;
      case 'toNumber':
        if (isNumeric(this.typeOf(e.value))) return this.typeOf(e.value)?.id === 'int' ? `(double) ${this.operand(e.value)}` : this.expr(e.value);
        this.helpersUsed.add('number');
        return `toNumber(${this.expr(e.value)})`;
      case 'toText':
        return this.text(e.value);
      case 'concat':
        return e.parts.map((part) => this.operand(part)).join(' + ');
      case 'toBoolean': {
        const type = this.typeOf(e.value);
        if (type?.id === 'bool' && !type.container && !type.nullable) return this.expr(e.value);
        this.helpersUsed.add('boolean');
        return `toBoolean(${this.expr(e.value)})`;
      }
      case 'call': {
        const call = this.call(e.callee, e.args);
        if (!e.output) return call;
        const imported = this.program.imports.find((i) => i.id === e.callee.id);
        const index = imported?.outputs?.findIndex((o) => o.id === e.output) ?? 0;
        return this.fromObject(`${call}[${index}]`, imported?.outputs?.[index]?.type);
      }
      case 'binary': {
        const type = e.op === '&&' || e.op === '||' ? BOOL : this.typeOf(e.left) ?? this.typeOf(e.right);
        const side = (x: IrExpr) => (type ? this.cast(this.operand(x), this.typeOf(x), type, x.kind === 'literal') : this.operand(x));
        // Strings, containers, structs and untyped values compare by value.
        if ((e.op === '==' || e.op === '!=') && !comparesByIdentity(type, this.types)) return `${e.op === '!=' ? '!' : ''}java.util.Objects.equals(${side(e.left)}, ${side(e.right)})`;
        return `${side(e.left)} ${e.op} ${side(e.right)}`;
      }
      case 'not':
        return `!${this.operand(e.value)}`;
      case 'param':
        return this.paramNames.get(`${e.function}\u0000${e.id}`) ?? 'null';
      case 'callFunction': {
        const fn = this.program.functions.find((f) => f.id === e.function)!;
        const call = this.functionCall(fn, e.args);
        if (fn.outputs.length === 1) return call;
        const index = fn.outputs.findIndex((o) => o.id === e.output);
        return this.fromObject(`${call}[${index}]`, fn.outputs[index]?.type);
      }
      case 'makeStruct': {
        const type = this.types.get(e.type);
        if (type?.kind !== 'struct') return 'null';
        return `new ${this.userTypeName(type.id)}(${type.fields.map((f, i) => this.coerce(e.fields[i], f.type)).join(', ')})`;
      }
      case 'structField': {
        const type = this.types.get(e.type);
        return `${this.operand(e.value)}.${type?.kind === 'struct' ? javaFieldNames(type).get(e.field) : e.field}()`;
      }
      case 'enumValue': {
        const type = this.types.get(e.type);
        return `${this.userTypeName(e.type)}.${type?.kind === 'enum' ? javaEnumMembers(type).get(e.value) : e.value}`;
      }
      case 'self':
        return 'this';
      case 'interfaceCall': {
        const iface = interfaceInfo(this.program, e.type);
        const fn = iface?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${iface ? this.interfaceNames(iface).functions.get(e.function) : e.function}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return this.output(call, fn?.outputs.filter((p) => p.kind === 'data') ?? [], e.output);
      }
      case 'parentCall': {
        const fn = this.program.ancestors?.flatMap((a) => a.functions).find((f) => f.name === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `super.${this.parentFunctionName(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return this.output(call, fn?.outputs.filter((p) => p.kind === 'data') ?? [], e.output);
      }
      case 'isValid':
        return `${this.operand(e.value)} != null`;
      case 'objectVariable':
        return `${this.targetRef(e.target)}.${this.membersOf(e.type)?.variables.get(e.variable)}`;
      case 'objectCall': {
        const fn = classInfo(this.program, e.type)?.functions.find((f) => f.id === e.function);
        const params = fn?.inputs.filter((p) => p.kind === 'data') ?? [];
        const call = `${this.targetRef(e.target)}.${this.membersOf(e.type)?.functions.get(e.function)}(${e.args.map((a, i) => this.coerce(a, params[i]?.type)).join(', ')})`;
        return this.output(call, fn?.outputs.filter((p) => p.kind === 'data') ?? [], e.output);
      }
      case 'makeContainer': {
        const element = { id: e.type.id };
        const type = this.typeName({ ...e.type, nullable: false });
        if (e.type.container === 'map') {
          this.helpersUsed.add('map');
          return this.mapOf(type, e.items.map((item, i) => this.coerce(item, i % 2 === 0 ? element : e.type.valueType)));
        }
        const items = e.items.map((item) => this.coerce(item, element));
        return items.length ? `new ${type}(java.util.List.of(${items.join(', ')}))` : `new ${type}()`;
      }
    }
  }

  // One output of a call: the value, or (of several) its element of the Object[].
  private output(call: string, outputs: { id: string; type?: TypeRef }[], output: string | undefined): string {
    if (outputs.length <= 1) return call;
    const index = Math.max(0, outputs.findIndex((o) => o.id === output));
    return this.fromObject(`${call}[${index}]`, outputs[index]?.type);
  }

  // A map of keys and values, in order: mapOf with the map's type arguments.
  private mapOf(type: string, items: string[]): string {
    if (!items.length) return `new ${type}()`;
    this.helpersUsed.add('map');
    return `${this.className}.${type.replace(/^LinkedHashMap/, '')}mapOf(${items.join(', ')})`;
  }

  private operand(e: IrExpr): string {
    const text = this.expr(e);
    return e.kind === 'add' || e.kind === 'binary' || e.kind === 'not' ? `(${text})` : text;
  }

  private functionCall(fn: IrFunction, args: IrExpr[]): string {
    return `${this.functionNames.get(fn.id)}(${args.map((a, i) => this.coerce(a, fn.params[i]?.type)).join(', ')})`;
  }

  private call(callee: IrCallee, args: IrExpr[]): string {
    const signature = calleeSignature(callee, this.program);
    const list = args.map((a, i) => this.coerce(a, signature?.params[i]?.type)).join(', ');
    if (callee.kind === 'helper') return `${this.helperNames.get(callee.id)}(${list})`;
    const imported = this.program.imports.find((i) => i.id === callee.id)!;
    return `${imported.module ? `${imported.module}.` : ''}${imported.name}(${list})`;
  }

  // The value as text, per docs/semantics.md ("Values").
  private text(e: IrExpr): string {
    const type = this.typeOf(e);
    if (type && !type.container && !type.nullable) {
      if (type.id === 'string') return this.expr(e);
      if (type.id === 'bool') return `(${this.expr(e)} ? "true" : "false")`;
      if (isNumeric(type)) {
        this.helpersUsed.add('format');
        return `formatNumber(${this.expr(e)})`;
      }
    }
    this.helpersUsed.add('format');
    return `formatValue(${this.expr(e)})`;
  }

  // An expression for a slot, member or parameter of type `target`. A container default (JSON: an
  // array, or a map's [key, value] pairs) becomes the container.
  private coerce(e: IrExpr, target: TypeRef | undefined): string {
    if (e.kind === 'literal' && target?.container && Array.isArray(e.value)) {
      const type = this.typeName({ ...target, nullable: false });
      const element = (v: unknown, t: TypeRef | undefined) => this.cast(literal(v), literalTypeOf(v), t, true);
      if (target.container === 'map') {
        const pairs = e.value.filter((p): p is unknown[] => Array.isArray(p) && p.length === 2);
        return this.mapOf(type, pairs.flatMap(([k, v]) => [element(k, { id: target.id }), element(v, target.valueType)]));
      }
      return e.value.length ? `new ${type}(java.util.List.of(${e.value.map((v) => element(v, { id: target.id })).join(', ')}))` : `new ${type}()`;
    }
    return this.cast(this.expr(e), this.typeOf(e), target, e.kind === 'literal');
  }

  private cast(text: string, from: TypeRef | undefined, target: TypeRef | undefined, isLiteral = false): string {
    if (!target || target.id === 'any' || target.id === 'wildcard') return text;
    if (sameType(from, target)) return text;
    if (from && !from.container && !target.container) {
      if (from.id === 'int' && target.id === 'float') return isLiteral ? (text.endsWith('L') ? `${text.slice(0, -1)}.0` : text) : `(double) ${text}`;
      if (from.id === 'float' && target.id === 'int') return isLiteral && Number.isInteger(Number(text)) ? `${text}L` : `(long) (${text})`;
      if (from.id === target.id) return text;
    }
    if (isLiteral && text === 'null') return target.nullable || this.defaultFor(target) === 'null' ? text : this.defaultFor(target);
    return this.fromObject(text, target);
  }

  // A value of unknown type as `target`.
  private fromObject(text: string, target: TypeRef | undefined): string {
    if (!target || target.id === 'any' || target.id === 'wildcard') return text;
    if (!target.container && !target.nullable) {
      const helper = { int: 'asLong', float: 'asDouble', bool: 'asBoolean', string: 'asString' }[target.id];
      if (helper) {
        this.helpersUsed.add('as');
        return `${helper}(${text})`;
      }
    }
    return `(${this.typeName(target)}) ${text}`;
  }

  private defaultFor(type: TypeRef | undefined): string {
    if (type?.nullable) return 'null';
    if (type?.container) return `new ${this.typeName({ ...type, nullable: false })}()`;
    const user = type && this.types.get(type.id);
    if (user?.kind === 'struct') return `new ${this.userTypeName(user.id)}()`;
    if (user?.kind === 'enum' && user.enumerators[0]) return `${this.userTypeName(user.id)}.${javaEnumMembers(user).get(user.enumerators[0].id)}`;
    switch (type?.id) {
      case 'bool':
        return 'false';
      case 'int':
        return '0L';
      case 'float':
        return '0.0';
      case 'string':
        return '""';
      default:
        return 'null';
    }
  }

  // The class's ancestors' member names, nearest first (src/core/compiler/names.ts).
  private inheritedMembers(info: ClassInfo | undefined): InheritedMembers[] {
    const chain: InheritedMembers[] = [];
    const seen = new Set<string>();
    for (let parent = info?.parent; parent && !seen.has(parent);) {
      seen.add(parent);
      const ancestor = classInfo(this.program, parent);
      const names = ancestor && this.membersOf(parent);
      if (!ancestor || !names) break;
      chain.push({ names, functions: ancestor.functions });
      parent = ancestor.parent;
    }
    const classes = [info, ...[...seen].map((id) => classInfo(this.program, id))];
    for (const id of new Set(classes.flatMap((c) => c?.interfaces ?? []))) {
      const iface = interfaceInfo(this.program, id);
      if (iface) chain.push({ names: this.interfaceNames(iface), functions: iface.functions });
    }
    return chain;
  }

  private interfaceNames(iface: InterfaceInfo): ClassMemberNames {
    const cached = this.classNames.get(iface.id);
    if (cached) return cached;
    const names = claimClassMembers(classScope(javaClassName(iface.name)), { functions: iface.functions, events: [], variables: [], dispatchers: [] }, CLASS_STYLES);
    this.classNames.set(iface.id, names);
    return names;
  }

  // An interface function's return type: none, its one output's, or an Object[] of its outputs.
  private interfaceResult(fn: ClassInfo['functions'][number]): string {
    const outputs = fn.outputs.filter((p) => p.kind === 'data');
    if (!outputs.length) return 'void';
    return outputs.length === 1 ? this.typeName(outputs[0].type) : 'Object[]';
  }

  private parentFunctionName(name: string): string | undefined {
    for (const ancestor of this.program.ancestors ?? []) {
      const fn = ancestor.functions.find((f) => f.name === name);
      if (fn) return this.membersOf(ancestor.id)?.functions.get(fn.id);
    }
    return undefined;
  }

  private membersOf(id: string): ClassMemberNames | undefined {
    const existing = this.classNames.get(id);
    if (existing) return existing;
    const info = classInfo(this.program, id);
    if (!info) return undefined;
    const names = claimClassMembers(classScope(javaClassName(info.name)), info, CLASS_STYLES, this.inheritedMembers(info));
    this.classNames.set(id, names);
    return names;
  }

  // An object member is reached through its object; a null one stops the run, as Unreal stops on
  // "Accessed None".
  private targetRef(e: IrExpr): string {
    return e.kind === 'self' ? 'this' : this.operand(e);
  }

  private dispatcherRef(s: { dispatcher: string; target?: IrExpr; type?: string }): string {
    if (s.target && s.type) return `${this.targetRef(s.target)}.${this.membersOf(s.type)?.dispatchers.get(s.dispatcher)}`;
    return this.dispatcherNames.get(s.dispatcher)!;
  }

  // The name a struct, enum, interface or class goes by: its own in its file, else qualified by
  // its package.
  private userTypeName(id: string): string {
    if (this.program.declaration?.type.id === id || id === `object:${this.program.className}`) return this.className;
    const imported = this.program.imports.find((i) => i.id === id);
    if (!imported) return 'Object';
    const name = javaClassName(imported.name);
    return imported.module && imported.module !== this.options.namespace ? `${imported.module}.${name}` : name;
  }

  // Java's spelling of a type, with user types by their (qualified) names.
  private mapType(type: TypeRef): string {
    if (!isUserTypeId(type.id) && !(type.valueType && isUserTypeId(type.valueType.id))) return mapType(type);
    const element = isUserTypeId(type.id) ? this.userTypeName(type.id) : mapType({ id: type.id, container: undefined });
    const boxed = (text: string) => BOXED[text] ?? text;
    const value = type.valueType ? boxed(this.mapType({ ...type.valueType, nullable: false })) : 'Object';
    if (type.container === 'array') return `ArrayList<${boxed(element)}>`;
    if (type.container === 'set') return `LinkedHashSet<${boxed(element)}>`;
    if (type.container === 'map') return `LinkedHashMap<${boxed(element)}, ${value}>`;
    return type.nullable ? boxed(element) : element;
  }

  private typeName(type: TypeRef | undefined): string {
    return this.mapType(type ?? { id: 'any' });
  }

  private typeOf(e: IrExpr): TypeRef | undefined {
    const type = exprType(e, this.program);
    return type?.id === 'any' ? undefined : type;
  }
}

// Whether == compares two values of the type correctly: primitives, enums and object references
// (identity is what Blueprint compares for objects) do; text, containers and structs need equals.
function comparesByIdentity(type: TypeRef | undefined, types: Map<string, UserType>): boolean {
  if (!type || type.container || type.nullable) return false;
  if (type.id === 'bool' || type.id === 'int' || type.id === 'float') return true;
  const { category } = parseTypeId(type.id);
  if (category === 'object' || category === 'interface') return true;
  return types.get(type.id)?.kind === 'enum';
}

// Whether execution can reach the end of the statements (Java refuses a statement it can't reach).
function canComplete(statements: IrStatement[]): boolean {
  const last = statements[statements.length - 1];
  if (!last) return true;
  if (last.kind === 'return') return false;
  if (last.kind === 'if') return canComplete(last.then) || canComplete(last.else);
  return true;
}

function literalTypeOf(value: unknown): TypeRef | undefined {
  if (typeof value === 'number') return { id: Number.isInteger(value) ? 'int' : 'float' };
  if (typeof value === 'string') return { id: 'string' };
  if (typeof value === 'boolean') return { id: 'bool' };
  return undefined;
}

// A JSON value as a Java literal: whole numbers are longs (`5L`), so they box to Long.
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'Double.NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Double.POSITIVE_INFINITY' : 'Double.NEGATIVE_INFINITY';
    // A whole number too large for a long (1e+21) is written as a double.
    return Number.isInteger(value) && Number.isSafeInteger(value) ? `${value}L` : String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return 'null';
}

const INT: TypeRef = { id: 'int' };
const BOOL: TypeRef = { id: 'bool' };

function sameSource(a: IrStatement, b: IrStatement): boolean {
  return a.kind !== 'callBlock' && b.kind !== 'callBlock' && a.source.graphId === b.source.graphId && a.source.nodeId === b.source.nodeId;
}

function isNumeric(type: TypeRef | undefined): boolean {
  return !!type && !type.container && (type.id === 'int' || type.id === 'float');
}

function sameType(a: TypeRef | undefined, b: TypeRef | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

