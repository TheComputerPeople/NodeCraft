// What Run, Run Tests and Debug need besides the generated file, by language: where imported
// modules are found, the project's sources built with it, the Rust crate, the Go module and the Godot
// project. Free of the vscode API, so tests run a project's graphs as Run does.
import * as path from 'node:path';
import { GeneratedCode } from '../core/language-pack';
import { cppRunSources, csharpRunSources, godotProject, goPackage, goRunSources, javaProject, rustRunSources } from './placement';

export interface RunSetup {
  importRoots?: string[];
  sources?: string[];
  crate?: { src: string; modules: string[]; name?: string };
  goModule?: { path: string; dir: string };
  projectDir?: string;
}

export function runSetup(language: string, outputPath: string, root: string, output: Pick<GeneratedCode, 'importRoots' | 'importedFiles'>): RunSetup {
  const graphDir = path.dirname(outputPath);
  const imported = output.importedFiles ?? [];
  // Java finds the project's classes in its source roots (javac's -sourcepath).
  const javaRoots = language === 'java' ? javaProject(graphDir, root).sourceRoots : [];
  const importRoots = javaRoots.length ? javaRoots : output.importRoots?.map((r) => path.join(root, r));
  const sources = language === 'csharp' ? csharpRunSources(graphDir, root, outputPath, imported)
    : language === 'cpp' ? cppRunSources(outputPath)
    : language === 'rust' ? rustRunSources(outputPath, root, imported).generated
    : language === 'java' ? imported.map((f) => path.join(root, f))
    : language === 'go' ? goRunSources(outputPath) : undefined;
  const goModule = language === 'go' ? goPackage(graphDir, root).module : undefined;
  const crate = language === 'rust' ? rustRunSources(outputPath, root, imported).crate : undefined;
  const projectDir = language === 'gdscript' ? godotProject(graphDir, root) : undefined;
  return { importRoots, sources, ...(crate ? { crate } : {}), ...(goModule ? { goModule } : {}), ...(projectDir ? { projectDir } : {}) };
}
