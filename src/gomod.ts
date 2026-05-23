import * as fs from 'fs';
import * as path from 'path';
import { defaultExec, type ExecFn } from './exec.js';

/**
 * Minimal logger interface compatible with the semantic-release context logger.
 */
export interface Logger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/**
 * Read a directory, returning an empty array on any I/O error.
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
  if (globPatterns && globPatterns.length > 0) {
    const results = globPatterns.flatMap((pattern) =>
      expandGlob(root, pattern),
    );
    return [...new Set(results)].sort();
  }

  // Auto-discover: walk the tree
  return walkForGoMods(root)
    .filter((f) => f !== path.join(root, 'go.mod'))
    .sort();
}

/**
 * Recursively walk `dir` and return absolute paths of all go.mod files.
 */
function walkForGoMods(dir: string): readonly string[] {
  return safeReadDir(dir).flatMap((entry) => {
    if (entry.name === 'vendor' || entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return [...walkForGoMods(full)];
    if (entry.isFile() && entry.name === 'go.mod') return [full];
    return [];
  });
}

/**
 * Minimal glob expander supporting `**` as a recursive wildcard.
 * Only handles the patterns this plugin actually uses, e.g.
 * `"assert/**\/go.mod"` or `"env/*\/go.mod"`.
 */
function expandGlob(root: string, pattern: string): readonly string[] {
  return matchParts(root, pattern.split('/'));
}

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
    // Last segment — must be a file
    const candidate = path.join(dir, head);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return [candidate];
    }
    return [];
  }

  if (head === '*') {
    // Single-level wildcard
    return safeReadDir(dir)
      .filter((e) => e.isDirectory())
      .flatMap((e) => matchParts(path.join(dir, e.name), tail));
  }

  // Literal segment
  const next = path.join(dir, head);
  if (!fs.existsSync(next)) return [];
  return matchParts(next, tail);
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
  for (const line of content.split('\n')) {
    const m = line.match(/^module\s+(\S+)/);
    if (m) return m[1];
  }
  throw new Error(`No module declaration found in ${goModPath}`);
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
  // Match: <module_path_starting_with_root> <v-prefixed-version> [optional comment]
  const pattern = new RegExp(`(${escaped}[^\\s]*)\\s+v[0-9]\\S*`, 'g');
  const updated = content.replace(pattern, `$1 v${newVersion}`);
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
 * @returns Tag prefix string (empty string for the root module).
 */
export function deriveTagPrefix(goModPath: string, repoRoot: string): string {
  return path.relative(repoRoot, path.dirname(goModPath));
}

/**
 * Create a git tag locally and optionally push it to origin.
 * Silently ignores the case where the tag already exists so the
 * plugin can be called idempotently.
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
  exec: ExecFn = defaultExec,
): void {
  try {
    exec(`git tag "${tag}"`, { cwd: repoRoot, stdio: 'pipe' });
    logger.log('Created tag %s', tag);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      logger.log('Tag %s already exists, skipping', tag);
    } else {
      throw err;
    }
  }

  if (push) {
    exec(`git push origin "refs/tags/${tag}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    logger.log('Pushed tag %s', tag);
  }
}
