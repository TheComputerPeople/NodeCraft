// Applies language packs' output plans (docs/output-placement.md): writes the files the extension
// owns, keeps accepted fenced blocks in the user's build files up to date, and proposes each new
// one once. Answers are remembered per workspace; a declined hook leaves a warning until the
// Register Generated Files with the Build command offers it again.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompileDiagnostic } from '../core/compiler/diagnostics';
import { LanguagePack, LanguagePackRegistry } from '../core/language-pack';
import { OutputHook, OutputPlan, confinePlan, findBlock, hasBlock, withBlock } from '../core/output-plan';

export type HookAnswer = 'accept' | 'decline' | 'later';

const ANSWERS = 'nodecraft.hookAnswers';
const PROPOSAL_SCHEME = 'vgraph-proposal';
const EXCLUDE = '**/{node_modules,.git,.venv,venv,dist,out,build,bin,obj,target}/**';

export class OutputPlans implements vscode.Disposable {
  // How a hook is proposed. The integration tests answer for the user.
  ask: (hook: OutputHook, showChange: () => Promise<void>) => Promise<HookAnswer> = askUser;
  // Hooks being proposed right now, so a second compile doesn't ask again.
  private readonly asking = new Set<string>();
  private readonly proposals = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  // Each folder's plan being applied, so compiles of different graphs take turns with its build
  // files rather than one writing a block from a plan made before the other's (docs/audit.md).
  private readonly applying = new Map<string, Promise<unknown>>();

  constructor(private readonly state: vscode.Memento, private readonly languages: LanguagePackRegistry) {
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, { provideTextDocumentContent: (uri) => this.proposals.get(uri.path) ?? '' }));
  }

  // After a graph of `pack`'s language compiled to `outputFile` (or, without it, after one was
  // deleted or renamed): applies the pack's plan, and returns the warnings for the graph.
  apply(pack: LanguagePack, root: string, outputFile?: string): Promise<CompileDiagnostic[]> {
    const key = path.resolve(root).toLowerCase();
    const previous = this.applying.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.applyNow(pack, root, outputFile), () => this.applyNow(pack, root, outputFile));
    const settled = next.then(() => undefined, () => undefined);
    this.applying.set(key, settled);
    void settled.then(() => {
      if (this.applying.get(key) === settled) this.applying.delete(key);
    });
    return next;
  }

  private async applyNow(pack: LanguagePack, root: string, outputFile?: string): Promise<CompileDiagnostic[]> {
    const placement = pack.generator?.placement;
    if (!placement) return [];
    const plan: OutputPlan = confinePlan(placement({
      outputFile: outputFile && relative(root, outputFile),
      generatedFiles: await this.generatedFiles(pack, root),
      readFile: (file) => {
        try {
          return fs.readFileSync(path.join(root, file), 'utf8');
        } catch {
          return undefined;
        }
      },
      exists: (file) => fs.existsSync(path.join(root, file)),
      list: (dir) => {
        try {
          return fs.readdirSync(path.join(root, dir));
        } catch {
          return [];
        }
      }
    }));
    for (const owned of plan.ownedFiles ?? []) await writeOwned(path.join(root, owned.path), owned.text);
    const diagnostics = [...(plan.diagnostics ?? [])];
    for (const hook of plan.hooks ?? []) {
      const warning = await this.applyHook(hook, root);
      if (warning) diagnostics.push({ severity: 'warning', code: 'build-registration', message: warning });
    }
    return diagnostics;
  }

  // Every pack's plan again, for the workspace folder (after a graph was deleted or renamed).
  async refreshAll(root: string): Promise<void> {
    for (const pack of this.languages.all()) await this.apply(pack, root);
  }

  // The Register Generated Files with the Build command: forgets declined hooks and offers them again.
  async offerAgain(root: string): Promise<void> {
    const answers = this.answers();
    for (const [id, answer] of Object.entries(answers)) if (answer === 'decline') delete answers[id];
    await this.state.update(ANSWERS, answers);
    await this.refreshAll(root);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  // Keeps an accepted block current; proposes a new one, unless declined. Returns a warning while
  // the build doesn't have it.
  private async applyHook(hook: OutputHook, root: string): Promise<string | undefined> {
    const uri = vscode.Uri.file(path.join(root, hook.file));
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      return `${hook.file} doesn't exist, so the generated code isn't registered with the build (${hook.description}).`;
    }
    const text = document.getText();
    if (hasBlock(text, hook.block)) return undefined;
    // Accepted before: the block is the extension's to update.
    if (findBlock(text, hook.block)) {
      await replaceText(document, withBlock(text, hook.block));
      return undefined;
    }
    const pending = `The generated code isn't registered with the build yet: ${hook.description}. Run "Register Generated Files with the Build" to do it.`;
    if (this.answers()[hook.id] === 'decline' || this.asking.has(hook.id)) return pending;
    this.asking.add(hook.id);
    // Asked without holding up the compile.
    void this.propose(hook, document).finally(() => this.asking.delete(hook.id));
    return pending;
  }

  private async propose(hook: OutputHook, document: vscode.TextDocument): Promise<void> {
    const proposed = withBlock(document.getText(), hook.block);
    const showChange = async (): Promise<void> => {
      const key = `/${hook.file}`;
      this.proposals.set(key, proposed);
      await vscode.commands.executeCommand('vscode.diff', document.uri, vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: key }), `${path.basename(hook.file)}: proposed change`);
    };
    const answer = await this.ask(hook, showChange);
    if (answer === 'later') return;
    await this.state.update(ANSWERS, { ...this.answers(), [hook.id]: answer });
    if (answer === 'accept') await replaceText(document, withBlock(document.getText(), hook.block));
  }

  private answers(): Record<string, HookAnswer> {
    return { ...this.state.get<Record<string, HookAnswer>>(ANSWERS, {}) };
  }

  // The generated files of graphs in the pack's language in the workspace folder, relative, sorted.
  private async generatedFiles(pack: LanguagePack, root: string): Promise<string[]> {
    const generator = pack.generator!;
    const graphs = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.vgraph'), EXCLUDE, 5000);
    const files: string[] = [];
    for (const graph of graphs) {
      let text: string;
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(graph));
      } catch {
        continue;
      }
      if (/"language":\s*"([^"]*)"/.exec(text)?.[1] !== pack.id) continue;
      files.push(relative(root, path.join(path.dirname(graph.fsPath), generator.outputFileName(path.basename(graph.fsPath)))));
    }
    return files.sort();
  }
}

// Asks with a notification: Add, Show Change (then asks again) or Never; dismissing asks next time.
async function askUser(hook: OutputHook, showChange: () => Promise<void>): Promise<HookAnswer> {
  for (;;) {
    const choice = await vscode.window.showInformationMessage(`NodeCraft: ${hook.description}?`, 'Add', 'Show Change', 'Never');
    if (choice === 'Show Change') {
      await showChange();
      continue;
    }
    return choice === 'Add' ? 'accept' : choice === 'Never' ? 'decline' : 'later';
  }
}

// An undoable edit of the user's file, saved unless it had unsaved changes of its own.
async function replaceText(document: vscode.TextDocument, text: string): Promise<void> {
  const wasDirty = document.isDirty;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
  if (!wasDirty) await document.save();
}

async function writeOwned(file: string, text: string): Promise<void> {
  const uri = vscode.Uri.file(file);
  if (!text) {
    if (fs.existsSync(file)) await vscode.workspace.fs.delete(uri);
    return;
  }
  try {
    if (new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) === text) return;
  } catch {
    // A new file.
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
