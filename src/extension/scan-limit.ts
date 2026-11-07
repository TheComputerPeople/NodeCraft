// Scanning the workspace (docs/project-integration.md, part 1): every scan stops at the
// `scanLimit` setting's count of files, and says so once when it does, rather than silently leaving
// files out of a large codebase.
import * as vscode from 'vscode';

const DEFAULT_LIMIT = 5000;
const warned = new Set<string>();

export function scanLimit(): number {
  const limit = vscode.workspace.getConfiguration('blueprintVisualScripting').get<number>('scanLimit', DEFAULT_LIMIT);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
}

// The files `include` finds, up to the limit; `what` names them in the warning ("source files").
export async function findFilesLimited(include: vscode.GlobPattern, exclude: string, what: string): Promise<vscode.Uri[]> {
  const limit = scanLimit();
  const found = await vscode.workspace.findFiles(include, exclude, limit + 1);
  if (found.length <= limit) return found;
  if (!warned.has(what)) {
    warned.add(what);
    const open = 'Open Settings';
    void vscode.window.showWarningMessage(`Blueprint scanned the first ${limit} ${what} of this workspace and left out the rest. Raise blueprintVisualScripting.scanLimit to scan them all.`, open)
      .then((choice) => choice === open && vscode.commands.executeCommand('workbench.action.openSettings', 'blueprintVisualScripting.scanLimit'));
  }
  return found.slice(0, limit);
}
