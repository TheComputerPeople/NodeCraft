// New Project (docs/project-integration.md, part 4): a minimal project in a language's usual layout,
// with a first class graph that prints "Hello from Blueprint", an entry point that runs it, and what
// every project gets: a .gitignore for the build output, .gitattributes marking generated files,
// and a README. Its versions are what generated code needs, or the installed toolchain's when that
// is newer, written where the project model reads them back (src/extension/projects.ts). Free of
// the vscode API, like graph-compile.ts: the command (extension.ts) and the tests use it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toIdentifier } from '../core/compiler/names';
import { LanguagePackRegistry } from '../core/language-pack';
import { builtinLanguagePacks } from '../core/languages';
import { GraphDocument } from '../core/model';
import { NodeRegistry } from '../core/registry';
import { compareVersionNumbers } from '../core/versions';
import { applyAcceptedPlan, compileGraphFile } from './graph-compile';
import { runCommand } from './runner';

export const HELLO = 'Hello from Blueprint';

export interface NewProjectOptions {
  // The installed toolchain's version, when known (detectToolVersion), as the tool reports it.
  toolVersion?: string;
  // Java: Maven, or Gradle (the command picks Gradle when it's on the PATH and Maven isn't).
  javaBuild?: 'maven' | 'gradle';
}

export interface NewProject {
  // Every file, relative to the project folder, with "/" separators.
  files: Record<string, string>;
  // The first graph, relative to the project folder.
  graph: string;
  // How the project runs without VS Code, from its folder.
  run: string;
}

// The names a project's name gives: its folder's ("My Game" is my-game), a package's (my_game), a
// class's or namespace's (MyGame) and a Java package's or Go module's (mygame).
export function projectNames(name: string): { slug: string; snake: string; pascal: string; lower: string } {
  const snake = toIdentifier(name, 'snake') || 'game';
  return { slug: snake.replace(/_/g, '-'), snake, pascal: toIdentifier(name, 'pascal') || 'Game', lower: snake.replace(/_/g, '') };
}

// The first graph: Start prints "Hello from Blueprint".
export function helloGraph(language: string): GraphDocument {
  return {
    schemaVersion: 3, name: 'Main', kind: 'class', language, variables: [],
    graphs: [{
      id: 'EventGraph', name: 'EventGraph', kind: 'event', comments: [],
      nodes: [
        { id: 'start', type: 'core:event.start', position: { x: 0, y: 0 }, properties: {} },
        { id: 'print', type: 'core:console.print', position: { x: 260, y: 0 }, properties: { 'pin:value': HELLO } }
      ],
      connections: [{ id: 'start.execOut->print.execIn', fromNode: 'start', fromPin: 'execOut', toNode: 'print', toPin: 'execIn' }]
    }]
  };
}

// A version that's at least the minimum: the installed one's first parts when it's newer.
function atLeast(minimum: string, installed: string | undefined, parts: number): string {
  const found = installed && /\d+(\.\d+)*/.exec(installed)?.[0].split('.').slice(0, parts).join('.');
  return found && compareVersionNumbers(found, minimum) > 0 ? found : minimum;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// The project's files for a language.
export function newProjectFiles(language: string, name: string, options: NewProjectOptions = {}): NewProject {
  const n = projectNames(name);
  const graph = (folder: string) => (folder ? `${folder}/Main.vgraph` : 'Main.vgraph');
  const v = options.toolVersion;
  let files: Record<string, string>;
  let first: string;
  let run: string;
  let ignore: string[];
  switch (language) {
    case 'typescript':
      first = graph('src');
      run = 'node src/main.ts';
      ignore = ['node_modules/', 'dist/'];
      files = {
        'package.json': json({
          name: n.slug, version: '0.1.0', private: true, type: 'module',
          scripts: { start: 'node src/main.ts', check: 'tsc' },
          // Node.js runs TypeScript itself from 22.18.
          engines: { node: '>=22.18' },
          devDependencies: { typescript: '^5.9.0', '@types/node': '^24.0.0' }
        }),
        'tsconfig.json': json({
          compilerOptions: {
            target: 'ES2022', lib: ['ES2022'], module: 'nodenext', moduleResolution: 'nodenext', types: ['node'],
            strict: true, noEmit: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true, skipLibCheck: true
          },
          include: ['src']
        }),
        'src/main.ts': "// Runs the Main graph: node src/main.ts\nimport { Main } from './Main.vgraph.ts';\n\nnew Main().start();\n"
      };
      break;
    case 'javascript':
      first = graph('src');
      run = 'node src/main.js';
      ignore = ['node_modules/'];
      files = {
        'package.json': json({ name: n.slug, version: '0.1.0', private: true, type: 'module', scripts: { start: 'node src/main.js' }, engines: { node: '>=18' } }),
        'src/main.js': "// Runs the Main graph: node src/main.js\nimport { Main } from './Main.vgraph.js';\n\nnew Main().start();\n"
      };
      break;
    case 'python':
      first = graph(`src/${n.snake}`);
      run = `python -m ${n.snake} (with src on PYTHONPATH, or after pip install -e .)`;
      ignore = ['__pycache__/', '*.egg-info/', '.venv/', 'build/', 'dist/'];
      files = {
        'pyproject.toml': [
          '[project]', `name = "${n.slug}"`, 'version = "0.1.0"', 'requires-python = ">=3.8"', '',
          '[build-system]', 'requires = ["setuptools>=61"]', 'build-backend = "setuptools.build_meta"', ''
        ].join('\n'),
        [`src/${n.snake}/__init__.py`]: '',
        [`src/${n.snake}/__main__.py`]: `"""Runs the Main graph: python -m ${n.snake}."""\nfrom ${n.snake}.main_vgraph import Main\n\nMain().start()\n`
      };
      break;
    case 'csharp': {
      // The SDK installed, whose framework is there (an older one may need a download).
      const framework = `net${atLeast('8', v, 1)}.0`;
      first = graph('');
      run = 'dotnet run';
      ignore = ['bin/', 'obj/'];
      files = {
        [`${n.pascal}.csproj`]: [
          '<Project Sdk="Microsoft.NET.Sdk">', '', '  <PropertyGroup>', '    <OutputType>Exe</OutputType>', `    <TargetFramework>${framework}</TargetFramework>`,
          `    <RootNamespace>${n.pascal}</RootNamespace>`, '    <Nullable>enable</Nullable>', '    <ImplicitUsings>enable</ImplicitUsings>', '  </PropertyGroup>', '', '</Project>', ''
        ].join('\n'),
        'Program.cs': `// Runs the Main graph: dotnet run\nnew ${n.pascal}.Main().Start();\n`
      };
      break;
    }
    case 'cpp':
      first = graph('src');
      run = `cmake -S . -B build && cmake --build build && build/${n.snake}`;
      ignore = ['build/'];
      files = {
        // Compiling the graph adds the generated files' include (vgraph.cmake) to the target.
        'CMakeLists.txt': [
          'cmake_minimum_required(VERSION 3.20)', `project(${n.snake} CXX)`, '', 'set(CMAKE_CXX_STANDARD 20)', 'set(CMAKE_CXX_STANDARD_REQUIRED ON)', '',
          `add_executable(${n.snake} src/main.cpp)`, ''
        ].join('\n'),
        'src/main.cpp': '// Runs the Main graph.\n#include "Main.vgraph.h"\n\nint main() {\n    Main().start();\n    // Delays and futures the graph waits on.\n    vgraph::run_latent_actions();\n    return 0;\n}\n'
      };
      break;
    case 'rust':
      first = graph('src');
      run = 'cargo run';
      ignore = ['target/'];
      files = {
        'Cargo.toml': ['[package]', `name = "${n.snake}"`, 'version = "0.1.0"', 'edition = "2021"', '', '[dependencies]', ''].join('\n'),
        // Compiling the graph declares the generated modules below.
        'src/main.rs': '//! Runs the Main graph: cargo run\n\nfn main() {\n    main_vgraph::Main::new().start();\n    // Delays and futures the graph waits on.\n    vgraph_runtime::run_latent_actions();\n}\n'
      };
      break;
    case 'java': {
      const release = atLeast('17', v, 1);
      const source = `src/main/java/${n.lower}`;
      first = graph(source);
      const app = [
        `package ${n.lower};`, '', '/** Runs the Main graph. */', 'public final class App {', '    private App() {', '    }', '',
        '    public static void main(String[] args) {', '        new Main().start();', '    }', '}', ''
      ].join('\n');
      if (options.javaBuild === 'gradle') {
        run = 'gradle run';
        ignore = ['.gradle/', 'build/'];
        files = {
          'settings.gradle': `rootProject.name = '${n.slug}'\n`,
          'build.gradle': ['plugins {', "    id 'application'", '}', '', "tasks.withType(JavaCompile).configureEach {", `    options.release = ${release}`, '}', '', 'application {', `    mainClass = '${n.lower}.App'`, '}', ''].join('\n'),
          [`${source}/App.java`]: app
        };
      } else {
        run = `mvn -q compile && java -cp target/classes ${n.lower}.App`;
        ignore = ['target/'];
        files = {
          'pom.xml': [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
            '  <modelVersion>4.0.0</modelVersion>', `  <groupId>${n.lower}</groupId>`, `  <artifactId>${n.slug}</artifactId>`, '  <version>0.1.0</version>', '',
            '  <properties>', `    <maven.compiler.release>${release}</maven.compiler.release>`, '    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>', '  </properties>', '',
            // Pinned, as Maven asks, so a build is the same everywhere.
            '  <build>', '    <plugins>',
            '      <plugin>', '        <groupId>org.apache.maven.plugins</groupId>', '        <artifactId>maven-resources-plugin</artifactId>', '        <version>3.4.0</version>', '      </plugin>',
            '      <plugin>', '        <groupId>org.apache.maven.plugins</groupId>', '        <artifactId>maven-compiler-plugin</artifactId>', '        <version>3.15.0</version>', '      </plugin>',
            '    </plugins>', '  </build>',
            '</project>', ''
          ].join('\n'),
          [`${source}/App.java`]: app
        };
      }
      break;
    }
    case 'go':
      first = graph('game');
      run = 'go run .';
      ignore = [`/${n.lower}`, `/${n.lower}.exe`];
      files = {
        'go.mod': `module ${n.lower}\n\ngo ${atLeast('1.21', v, 2)}\n`,
        'main.go': [
          `// Command ${n.lower} runs the Main graph: go run .`, 'package main', '', `import "${n.lower}/game"`, '', 'func main() {',
          '\tgame.NewMain().Start()', '\t// Delays and channels the graph waits on.', '\tgame.VgRunLatentActions()', '}', ''
        ].join('\n')
      };
      break;
    case 'lua':
      first = graph('');
      run = 'lua main.lua';
      ignore = [];
      files = {
        '.luarc.json': json({ 'runtime.version': `Lua ${atLeast('5.4', v, 2)}` }),
        'main.lua': '-- Runs the Main graph: lua main.lua\nlocal Main = require("main_vgraph")\nlocal vg = require("vgraph_runtime")\n\nMain.new():start()\n-- Delays and coroutines the graph waits on.\nvg.run_latent_actions()\n'
      };
      break;
    case 'gdscript':
      first = graph('');
      run = 'godot --headless --path .';
      ignore = ['.godot/'];
      files = {
        'project.godot': [
          'config_version=5', '', '[application]', '', `config/name="${name.replace(/["\\]/g, '')}"`, 'run/main_scene="res://main.tscn"',
          `config/features=PackedStringArray("${atLeast('4.3', v, 2)}")`, ''
        ].join('\n'),
        'main.tscn': '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
        'main.gd': [
          'extends Node', '## Runs the Main graph, then quits: make main.tscn your game\'s scene instead.', '',
          'const Main = preload("res://main_vgraph.gd")', 'const vg = preload("res://vgraph_runtime.gd")', '', '',
          'func _ready() -> void:', '\tMain.new().start()', '\t# Delays and coroutines the graph waits on, while the tree runs frames.',
          '\tawait vg.run_latent_actions(get_tree())', '\tget_tree().quit(1 if vg.failed() else 0)', ''
        ].join('\n')
      };
      break;
    case 'ruby':
      first = graph('lib');
      run = 'ruby lib/main.rb';
      ignore = ['.bundle/', 'vendor/bundle/'];
      files = {
        Gemfile: "# frozen_string_literal: true\n\nsource 'https://rubygems.org'\n\nruby '>= 3.3'\n",
        '.ruby-version': `${atLeast('3.3', v, 3)}\n`,
        'lib/main.rb': "# frozen_string_literal: true\n\n# Runs the Main graph: ruby lib/main.rb\nrequire_relative 'main_vgraph'\n\nMain.new.start\n# Delays and threads the graph waits on.\nVg.run_latent_actions\n"
      };
      break;
    case 'php':
      first = graph('src');
      run = 'php bin/main.php';
      ignore = ['vendor/'];
      files = {
        'composer.json': json({ name: `example/${n.slug}`, type: 'project', require: { php: '>=8.1' }, autoload: { 'psr-4': { [`${n.pascal}\\`]: 'src/' } } }),
        'bin/main.php': [
          '<?php', '', 'declare(strict_types=1);', '', '// Runs the Main graph: php bin/main.php', "require_once __DIR__ . '/../src/Main.vgraph.php';", '',
          `(new \\${n.pascal}\\Main())->start();`, '// Delays and fibers the graph waits on.', '\\Vgraph\\Vg::runLatentActions();', ''
        ].join('\n')
      };
      break;
    default:
      throw new Error(`New Project has no layout for ${language}.`);
  }
  const pack = builtinLanguagePacks().get(language)!;
  files[first] = `${JSON.stringify(helloGraph(language), null, 2)}\n`;
  files['.gitignore'] = ignore.length ? `${ignore.join('\n')}\n` : '';
  files['.gitattributes'] = gitAttributes(language);
  files['README.md'] = readme(name, pack.displayName, first, run);
  return { files, graph: first, run };
}

// Generated files marked as generated, so diffs and statistics treat them so (docs/project-
// integration.md, part 3): every language's `name.vgraph.*`, the language's own pattern (Python's
// `name_vgraph.py`), and the support files placement keeps.
export function gitAttributes(language: string): string {
  const generator = builtinLanguagePacks().get(language)?.generator;
  const own = generator ? generator.outputFileName('Name.vgraph').replace(/name/i, '*') : undefined;
  const patterns = ['*.vgraph.*', ...(own && !own.startsWith('*.vgraph.') ? [own] : []), 'vgraph_runtime.*', ...(language === 'cpp' ? ['vgraph.cmake'] : [])];
  return `# Files Blueprint Visual Scripting generates from graphs.\n${patterns.map((p) => `${p} linguist-generated`).join('\n')}\n`;
}

function readme(name: string, language: string, graph: string, run: string): string {
  return [
    `# ${name}`, '',
    `A ${language} project with graphs made in Blueprint Visual Scripting.`, '',
    '## Run it', '',
    `- **In VS Code**, with the Blueprint Visual Scripting extension: open \`${graph}\` and press **Run** (or F5 to debug it).`,
    `- **Without VS Code:** \`${run}\`. It prints "${HELLO}".`, '',
    'Graphs compile when they are saved. Their generated files sit next to them and are committed with the project, so it builds without the extension.', ''
  ].join('\n');
}

// Writes the project into `folder` (which must be empty or not exist), compiles its graph and
// registers the generated files with its build, as accepting every hook would: a project made this
// way builds and runs as it is. Returns the graph's file.
export async function createProject(folder: string, language: string, name: string, options: NewProjectOptions = {}): Promise<{ graph: string; project: NewProject; diagnostics: string[] }> {
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error(`${folder} isn't empty.`);
  const project = newProjectFiles(language, name, options);
  for (const [file, text] of Object.entries(project.files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), text);
  }
  const graph = path.join(folder, project.graph);
  const languages = new LanguagePackRegistry(builtinLanguagePacks().all());
  const compiled = await compileGraphFile(helloGraph(language), graph, folder, {
    registry: new NodeRegistry(),
    languages,
    write: async (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    remove: async (file) => fs.rmSync(file, { force: true }),
    register: async (pack, root, outputFile) => applyAcceptedPlan(pack, root, [outputFile], outputFile)
  });
  return { graph, project, diagnostics: compiled.diagnostics.map((d) => `${d.severity}: ${d.message}`) };
}

// The installed toolchain's version for a language, as its tool reports it, or undefined.
const VERSION_COMMANDS: Record<string, string[]> = {
  csharp: ['dotnet', '--version'], java: ['java', '-version'], go: ['go', 'version'], lua: ['lua', '-v'],
  gdscript: [process.env.GODOT ?? 'godot', '--version'], ruby: ['ruby', '--version']
};
export async function detectToolVersion(language: string): Promise<string | undefined> {
  const command = VERSION_COMMANDS[language];
  if (!command) return undefined;
  const outcome = await runCommand(command, { cwd: process.cwd(), timeoutMs: 20000 }).catch(() => undefined);
  if (!outcome || outcome.exitCode !== 0) return undefined;
  // Java writes its version to stderr; Go's is "go1.23.4".
  return /(\d+(?:\.\d+)+)/.exec(`${outcome.stdout}\n${outcome.stderr}`)?.[1];
}

// Java's build tool: Maven, else Gradle when it's on the PATH and Maven isn't.
export async function detectJavaBuild(): Promise<'maven' | 'gradle'> {
  const has = async (command: string[]) => (await runCommand(command, { cwd: process.cwd(), timeoutMs: 30000 }).catch(() => undefined))?.exitCode === 0;
  const shell = process.platform === 'win32' ? ['cmd', '/c'] : [];
  if (await has([...shell, 'mvn', '-v'])) return 'maven';
  return (await has([...shell, 'gradle', '-v'])) ? 'gradle' : 'maven';
}
