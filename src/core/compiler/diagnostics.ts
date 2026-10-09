// Compiler Results entries. Each points at the graph and node it is about, when there is one, so
// the editor can badge the node and jump to it.
export type DiagnosticSeverity = 'error' | 'warning';

export interface CompileDiagnostic {
  severity: DiagnosticSeverity;
  // Stable identifier for tests and quick fixes, e.g. "exec-cycle".
  code: string;
  message: string;
  graphId?: string;
  nodeId?: string;
}

export function hasErrors(diagnostics: CompileDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
