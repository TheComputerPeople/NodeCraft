// Arguments for a command line that a shell reads: what a debugger extension starts with Node's
// `shell: true` (godot-tools), so cmd.exe on Windows and sh elsewhere (docs/audit.md, third pass).

// One argument, quoted so the shell passes it as it is. Undefined when cmd can't be given it as it
// is: a double quote, a percent sign or a line break.
export function shellArgument(text: string, platform: string): string | undefined {
  if (platform !== 'win32') return `'${text.replace(/'/g, `'\\''`)}'`;
  if (/["%\r\n]/.test(text)) return undefined;
  // Backslashes before the closing quote are doubled, so the program doesn't read a quote in them.
  return `"${text.replace(/(\\+)$/, '$1$1')}"`;
}

// Whether text the extension itself puts between double quotes (godot-tools' path and project) is
// read as it is: in sh, `$`, a backquote and a backslash still mean something there.
export function safeInDoubleQuotes(text: string, platform: string): boolean {
  return platform === 'win32' ? !/["%\r\n]/.test(text) : !/["$`\\\r\n]/.test(text);
}
