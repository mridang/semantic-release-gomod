import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerifyConditionsContext } from 'semantic-release';
import type { ExecFn } from './exec.js';

/**
 * The part of the semantic-release context logger that tagging uses.
 */
type Logger = Pick<VerifyConditionsContext['logger'], 'log'>;

/**
 * Directories that never contain modules the plugin manages.
 */
const IGNORED_DIRS: readonly string[] = ['vendor', 'node_modules'];

/**
 * Whether a directory name is skipped when searching for modules: the
 * ignored directories above, and dot-directories such as `.git`.
 *
 * @param name A directory name.
 * @returns True when the directory is not searched.
 */
function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.includes(name) || name.startsWith('.');
}

/**
 * Read a directory, returning an empty array on any I/O error.
 *
 * @param dir Absolute path of the directory.
 * @returns Its entries, or an empty array when it cannot be read.
 */
function safeReadDir(dir: string): readonly fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Walk `root` recursively and return the absolute paths of every
 * go.mod file found, excluding the root-level go.mod itself.
 *
 * When `globPatterns` are provided the walk is skipped and the
 * patterns are expanded against `root` instead.
 *
 * @param root        Absolute path to the repository root.
 * @param globPatterns Optional array of glob patterns relative to root.
 * @returns Sorted array of absolute go.mod paths (submodules only).
 */
export function discoverSubmoduleGoMods(
  root: string,
  globPatterns?: readonly string[],
): readonly string[] {
  const rootGoMod = path.join(root, 'go.mod');
  const candidates =
    globPatterns && globPatterns.length > 0
      ? globPatterns.flatMap((pattern) =>
          expandGlob(root, pattern).filter(
            (file) =>
              file !== rootGoMod &&
              // A literal path was asked for by name, so it is honoured.
              (!pattern.includes('*') || !inIgnoredDir(root, file)),
          ),
        )
      : walkForGoMods(root).filter((file) => file !== rootGoMod);
  return [...new Set(candidates)].toSorted();
}

/**
 * Whether a file is inside a `vendor`, `node_modules` or dot-directory below
 * the root. Wildcard patterns skip such files, like auto-discovery does.
 *
 * @param root Absolute path to the repository root.
 * @param file Absolute path to a file.
 * @returns True when a directory on the way from the root is ignored.
 */
function inIgnoredDir(root: string, file: string): boolean {
  return path.relative(root, file).split(path.sep).some(isIgnoredDir);
}

/**
 * Recursively walk `dir` and return absolute paths of all go.mod files,
 * skipping `vendor`, `node_modules` and dot-directories. Only regular files count, so a
 * symlink named go.mod is ignored.
 *
 * @param dir Absolute path of the directory to walk.
 * @returns Every go.mod file below it, including one directly inside it.
 */
function walkForGoMods(dir: string): readonly string[] {
  return safeReadDir(dir).flatMap((entry) => {
    if (isIgnoredDir(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkForGoMods(full);
    if (entry.isFile() && entry.name === 'go.mod') return [full];
    return [];
  });
}

/**
 * Minimal glob expander supporting `**` as a recursive wildcard.
 * Only handles the patterns this plugin actually uses, e.g.
 * `"assert/**\/go.mod"` or `"env/*\/go.mod"`.
 *
 * @param root    Absolute path the pattern is relative to.
 * @param pattern Glob pattern using `/` separators.
 * @returns Absolute paths of the files the pattern matches.
 */
function expandGlob(root: string, pattern: string): readonly string[] {
  return matchParts(root, pattern.split('/'));
}

/**
 * Match the remaining segments of a glob pattern below a directory.
 * `**` matches zero or more directory levels, `*` exactly one, and any other
 * segment is a literal name. The last segment must be a regular file.
 *
 * @param dir   Absolute path of the directory to match in.
 * @param parts Pattern segments still to be matched.
 * @returns Absolute paths of the matching files.
 */
function matchParts(dir: string, parts: readonly string[]): readonly string[] {
  if (parts.length === 0) return [];
  const [head, ...tail] = parts;

  if (head === '**') {
    // Zero levels: continue with tail from current dir.
    // One or more levels: descend into each subdirectory.
    return [
      ...matchParts(dir, tail),
      ...safeReadDir(dir)
        .filter((e) => e.isDirectory())
        .flatMap((e) => matchParts(path.join(dir, e.name), parts)),
    ];
  }

  if (tail.length === 0) {
    // Last segment — must be a file (single statSync avoids TOCTOU)
    const candidate = path.join(dir, head);
    try {
      return fs.statSync(candidate).isFile() ? [candidate] : [];
    } catch {
      return [];
    }
  }

  if (head === '*') {
    // Single-level wildcard
    return safeReadDir(dir)
      .filter((e) => e.isDirectory())
      .flatMap((e) => matchParts(path.join(dir, e.name), tail));
  }

  // Literal segment — safeReadDir handles missing/unreadable paths gracefully
  return matchParts(path.join(dir, head), tail);
}

/**
 * Read a go.mod file and extract the module declaration.
 *
 * @param goModPath Absolute path to the go.mod file.
 * @returns The module import path, e.g. `"github.com/mridang/wilhelm"`.
 * @throws Error if no `module` line is found.
 */
export function readModulePath(goModPath: string): string {
  const content = fs.readFileSync(goModPath, 'utf8');
  const declared = content
    .split('\n')
    .map((line) =>
      /^\uFEFF?module\s+(\S+)/.exec(line)?.[1]?.replace(/^(["`])(.*)\1$/, '$2'),
    )
    .find((name) => name !== undefined);
  if (declared === undefined) {
    throw new Error(`No module declaration found in ${goModPath}`);
  }
  return declared;
}

/**
 * Update every `require` line in a go.mod file whose import path
 * starts with `rootModule`, replacing the version with `newVersion`.
 * Lines with `// indirect` comments are preserved as-is.
 *
 * Handles both single-line requires and require blocks.
 *
 * @param filePath   Absolute path to the go.mod file to rewrite.
 * @param rootModule Root module import path (e.g. `"github.com/mridang/wilhelm"`).
 * @param newVersion New semver string without leading `v` (e.g. `"1.2.3"`).
 */
export function updateGoModRequires(
  filePath: string,
  rootModule: string,
  newVersion: string,
): void {
  const content = fs.readFileSync(filePath, 'utf8');
  // Escape slashes and dots in the module path for use in regex
  const escaped = rootModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The path must be the root module or one of its sub-paths, so `repo` does
  // not match `repository` or `repo-x`.
  const requirePath = `${escaped}(?:/\\S*)?`;
  const version = `([ \\t]+)v[0-9]\\S*`;
  const inBlock = new RegExp(`^([ \\t]*${requirePath})${version}`, 'gm');
  const single = new RegExp(`^(require[ \\t]+${requirePath})${version}`, 'gm');
  const pin = `$1$2v${newVersion}`;
  // Only `require` directives are pinned, never replace, exclude or retract.
  const updated = content
    .replace(
      /(^require[ \t]*\(\r?\n)([\s\S]*?)(^[ \t]*\))/gm,
      (_match, open: string, body: string, close: string) =>
        `${open}${body.replace(inBlock, pin)}${close}`,
    )
    .replace(single, pin);
  if (updated !== content) {
    fs.writeFileSync(filePath, updated, 'utf8');
  }
}

/**
 * Derive the git tag prefix for a submodule given its go.mod path
 * and the repository root.
 *
 * - Root module (`./go.mod`)                → `""` (tag = `"v1.2.3"`)
 * - Submodule (`./assert/cert/manager/go.mod`) → `"assert/cert/manager"`
 *
 * @param goModPath Absolute path to the go.mod file.
 * @param repoRoot  Absolute path to the repository root.
 * @param pathApi   Path implementation (injectable to test Windows paths).
 * @returns Tag prefix with `/` separators (empty for the root module).
 */
export function deriveTagPrefix(
  goModPath: string,
  repoRoot: string,
  pathApi: Pick<typeof path, 'relative' | 'dirname' | 'sep'> = path,
): string {
  return pathApi
    .relative(repoRoot, pathApi.dirname(goModPath))
    .split(pathApi.sep)
    .join('/');
}

/**
 * Whether a tag already exists locally. Asks git for the ref instead of
 * reading the text of its error message, which depends on the locale.
 *
 * @param repoRoot Absolute path to the repository root.
 * @param tag      Full tag string, e.g. `"assert/cert/manager/v1.2.3"`.
 * @param exec     Command executor (injectable for testing).
 * @returns True when `refs/tags/<tag>` resolves.
 */
function tagExists(repoRoot: string, tag: string, exec: ExecFn): boolean {
  try {
    exec(`git rev-parse -q --verify "refs/tags/${tag}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a git tag locally and optionally push it to origin.
 * Silently skips a tag that already exists so the plugin can be called
 * idempotently.
 *
 * @param repoRoot Absolute path to the repository root.
 * @param tag      Full tag string, e.g. `"assert/cert/manager/v1.2.3"`.
 * @param push     When true, push the tag to `origin`.
 * @param logger   semantic-release logger.
 * @param exec     Command executor (injectable for testing).
 */
export function createAndPushTag(
  repoRoot: string,
  tag: string,
  push: boolean,
  logger: Logger,
  exec: ExecFn,
): void {
  if (tagExists(repoRoot, tag, exec)) {
    logger.log('Tag %s already exists, skipping', tag);
  } else {
    exec(`git tag "${tag}"`, { cwd: repoRoot, stdio: 'pipe' });
    logger.log('Created tag %s', tag);
  }

  if (push) {
    exec(`git push origin "refs/tags/${tag}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    logger.log('Pushed tag %s', tag);
  }
}
