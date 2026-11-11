/**
 * @file Builds the text of go.mod files for tests.
 */

/**
 * The contents of a go.mod file.
 * @param modulePath - The module declaration, for example `github.com/a/b`.
 * @param requires - Lines for the require block, such as `github.com/a/b v1.0.0`.
 * @returns The file contents.
 * @example
 * goMod('github.com/a/b', ['github.com/c/d v1.0.0']);
 */
export function goMod(
  modulePath: string,
  requires: readonly string[] = [],
): string {
  const body = requires.map((r) => `\t${r}`).join('\n');
  const requireBlock = requires.length > 0 ? `\nrequire (\n${body}\n)\n` : '';
  return `module ${modulePath}\n\ngo 1.21\n${requireBlock}`;
}
