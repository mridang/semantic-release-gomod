/**
 * The contents of a go.mod file.
 * @param modulePath - The module declaration, for example `github.com/a/b`.
 * @param requires - Lines for the require block, such as `github.com/a/b v1.0.0`.
 * @returns The file contents.
 */
export function goMod(
  modulePath: string,
  requires: readonly string[] = [],
): string {
  const requireBlock =
    requires.length > 0
      ? `\nrequire (\n${requires.map((r) => `\t${r}`).join('\n')}\n)\n`
      : '';
  return `module ${modulePath}\n\ngo 1.21\n${requireBlock}`;
}
