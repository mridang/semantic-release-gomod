import * as fs from 'node:fs';
import * as path from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import type { ExecFn } from './exec.js';

/**
 * The part of the semantic-release context logger the helpers use.
 */
type Logger = Pick<VerifyConditionsContext['logger'], 'log' | 'warn'>;

/**
 * Directories that are not searched for modules when walking the tree or
 * expanding a wildcard: git's own data, and vendored dependencies. A literal
 * path into one of them is still honoured. Other dot-directories such as
 * `.tools` are searched, because they can hold real modules.
 */
const IGNORED_DIRS: readonly string[] = ['.git', 'vendor', 'node_modules'];

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
 * The subdirectories to descend into, skipping the ignored ones before they
 * are read (so a huge `node_modules` is never walked). Ignored directories
 * other than `.git` are reported, so users can see what was left out.
 *
 * @param dir    Absolute path of the directory.
 * @param logger Where skipped directories are reported.
 * @returns The absolute paths of the directories to search.
 */
function searchableSubdirs(dir: string, logger: Logger): readonly string[] {
  return safeReadDir(dir)
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (!IGNORED_DIRS.includes(entry.name)) return [full];
      if (entry.name !== '.git') {
        logger.log(
          'Not searching %s for modules. Name a go.mod in it in the `modules` option to include it.',
          full,
        );
      }
      return [];
    });
}

/**
 * Find the submodule go.mod files: every go.mod below `root` except the
 * root-level one, or the ones the glob patterns match.
 *
 * Without patterns the tree is walked, skipping `.git`, `vendor` and
 * `node_modules`. Patterns support literal names and whole-segment `*` and
 * `**` wildcards, which skip the same directories; a literal path is
 * honoured even inside them. Symlinked go.mod files are never matched. A
 * pattern that matches nothing is reported with a warning.
 *
 * @param root         Absolute path to the repository root.
 * @param globPatterns Optional array of glob patterns relative to root.
 * @param logger       Where skipped directories and empty patterns are reported.
 * @returns Sorted array of absolute go.mod paths (submodules only).
 */
export function discoverSubmoduleGoMods(
  root: string,
  globPatterns: readonly string[] | undefined,
  logger: Logger,
): readonly string[] {
  const rootGoMod = path.join(root, 'go.mod');
  const isSubmodule = (file: string): boolean => file !== rootGoMod;
  if (!globPatterns || globPatterns.length === 0) {
    return walkForGoMods(root, logger).filter(isSubmodule).toSorted();
  }
  const found = globPatterns.map((pattern) => ({
    pattern,
    files: matchParts(root, pattern.split('/'), logger).filter(isSubmodule),
  }));
  found
    .filter(({ files }) => files.length === 0)
    .forEach(({ pattern }) => {
      logger.warn(
        'Pattern "%s" in `modules` matched no go.mod files.',
        pattern,
      );
    });
  return [...new Set(found.flatMap(({ files }) => files))].toSorted();
}

/**
 * Recursively walk `dir` and return absolute paths of all go.mod files,
 * skipping the ignored directories. Only regular files count, so a symlink
 * named go.mod is ignored.
 *
 * @param dir    Absolute path of the directory to walk.
 * @param logger Where skipped directories are reported.
 * @returns Every go.mod file below it, including one directly inside it.
 */
function walkForGoMods(dir: string, logger: Logger): readonly string[] {
  const here = safeReadDir(dir)
    .filter((entry) => entry.isFile() && entry.name === 'go.mod')
    .map((entry) => path.join(dir, entry.name));
  return [
    ...here,
    ...searchableSubdirs(dir, logger).flatMap((sub) =>
      walkForGoMods(sub, logger),
    ),
  ];
}

/**
 * Match the segments of a glob pattern below a directory.
 * `**` matches zero or more directory levels, `*` exactly one, and any other
 * segment is a literal name. The last segment must be a regular file (not a
 * symlink, like in auto-discovery). Wildcards do not descend into ignored
 * directories, but a literal segment may name one.
 *
 * @param dir    Absolute path of the directory to match in.
 * @param parts  Pattern segments still to be matched.
 * @param logger Where skipped directories are reported.
 * @returns Absolute paths of the matching files.
 */
function matchParts(
  dir: string,
  parts: readonly string[],
  logger: Logger,
): readonly string[] {
  if (parts.length === 0) return [];
  const [head, ...tail] = parts;

  if (head === '**') {
    // Zero levels: continue with tail from the current dir.
    // One or more levels: descend into each subdirectory.
    return [
      ...matchParts(dir, tail, logger),
      ...searchableSubdirs(dir, logger).flatMap((sub) =>
        matchParts(sub, parts, logger),
      ),
    ];
  }

  if (tail.length === 0) {
    // Last segment: must be a regular file (one lstat avoids a TOCTOU race).
    const candidate = path.join(dir, head);
    try {
      return fs.lstatSync(candidate).isFile() ? [candidate] : [];
    } catch {
      return [];
    }
  }

  if (head === '*') {
    // Single-level wildcard
    return searchableSubdirs(dir, logger).flatMap((sub) =>
      matchParts(sub, tail, logger),
    );
  }

  // Literal segment: a missing or unreadable path simply matches nothing.
  return matchParts(path.join(dir, head), tail, logger);
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
      /^\uFEFF?module\s+([^\s(]\S*)/
        .exec(line)?.[1]
        ?.replace(/^(["`])(.*)\1$/, '$2'),
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
  // A first sub-path segment such as `/v2` is a different module (a new
  // major version), so it is not pinned to this one's release.
  const requirePath = `${escaped}(?:/(?!v[0-9]+(?:/|[ \\t]))\\S*)?`;
  const version = `([ \\t]+)v[0-9]\\S*`;
  const inBlock = new RegExp(`^([ \\t]*${requirePath})${version}`, 'gm');
  const single = new RegExp(`^(require[ \\t]+${requirePath})${version}`, 'gm');
  const pin = `$1$2v${newVersion}`;
  // Only `require` directives are pinned, never replace, exclude or retract.
  const updated = content
    .replace(
      /(^require[ \t]*\([ \t]*(?:\/\/[^\r\n]*)?\r?\n)([\s\S]*?)(^[ \t]*\))/gm,
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
 * A tag to create, and whether it already exists on the commit being released.
 */
export interface TagPlan {
  /** The full tag, e.g. `"assert/cert/manager/v1.2.3"`. */
  readonly tag: string;
  /** True when the tag already points at `HEAD`, so it need not be created. */
  readonly exists: boolean;
}

/**
 * Whether git accepts a tag name. A name starting with `-` is refused too,
 * since git would read it as an option.
 *
 * @param repoRoot Absolute path to the repository root.
 * @param tag      Full tag string.
 * @param exec     Command executor (injectable for testing).
 * @returns True when `git check-ref-format` accepts `refs/tags/<tag>`.
 */
function isValidTagName(repoRoot: string, tag: string, exec: ExecFn): boolean {
  if (tag.startsWith('-')) return false;
  try {
    exec('git', ['check-ref-format', `refs/tags/${tag}`], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The commit a tag already points at. Asks git for the ref instead of
 * reading the text of its error message, which depends on the locale.
 *
 * @param repoRoot Absolute path to the repository root.
 * @param tag      Full tag string.
 * @param exec     Command executor (injectable for testing).
 * @returns The commit hash, or undefined when the tag does not exist.
 */
function tagCommit(
  repoRoot: string,
  tag: string,
  exec: ExecFn,
): string | undefined {
  try {
    return exec(
      'git',
      ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`],
      { cwd: repoRoot, stdio: 'pipe' },
    ).trim();
  } catch {
    return undefined;
  }
}

/**
 * Check every tag before any of them is created or pushed, so a bad one
 * cannot leave a release half published. A tag name git would refuse, or an
 * existing tag that points at a different commit than `HEAD` (which would
 * publish stale code under the new version), stops the release.
 *
 * @param repoRoot Absolute path to the repository root.
 * @param tags     Every full tag the release will create.
 * @param exec     Command executor (injectable for testing).
 * @returns For each tag, whether it already exists at `HEAD`.
 * @throws SemanticReleaseError `EINVALIDTAG` or `ETAGMISMATCH`.
 */
export function planTags(
  repoRoot: string,
  tags: readonly string[],
  exec: ExecFn,
): readonly TagPlan[] {
  const invalid = tags.filter((tag) => !isValidTagName(repoRoot, tag, exec));
  if (invalid.length > 0) {
    throw new SemanticReleaseError(
      `Cannot create tag(s) git rejects: ${invalid.join(', ')}.`,
      'EINVALIDTAG',
      'A tag is the module directory plus the version, so rename the directory (tag names cannot contain spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\\` or `..`, and cannot start with `-`), or exclude it with the `modules` option.',
    );
  }
  const head = exec('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdio: 'pipe',
  }).trim();
  const plans = tags.map((tag) => ({
    tag,
    commit: tagCommit(repoRoot, tag, exec),
  }));
  const stale = plans.filter(
    ({ commit }) => commit !== undefined && commit !== head,
  );
  if (stale.length > 0) {
    throw new SemanticReleaseError(
      `Tag(s) already exist at another commit than HEAD (${head}): ${stale.map(({ tag, commit }) => `${tag} (${commit})`).join(', ')}.`,
      'ETAGMISMATCH',
      'Pushing them would publish old code under this version. Delete the stale tag(s) locally (`git tag -d <tag>`) and on the remote if they were pushed, or release a new version.',
    );
  }
  return plans.map(({ tag, commit }) => ({
    tag,
    exists: commit !== undefined,
  }));
}

/**
 * Create a git tag locally and optionally push it to origin. A tag that
 * already points at `HEAD` is not created again, so the plugin can be called
 * idempotently. Use `planTags` first to validate the whole batch.
 *
 * @param repoRoot Absolute path to the repository root.
 * @param plan     The tag, and whether it already exists at `HEAD`.
 * @param push     When true, push the tag to `origin`.
 * @param logger   semantic-release logger.
 * @param exec     Command executor (injectable for testing).
 */
export function createAndPushTag(
  repoRoot: string,
  plan: TagPlan,
  push: boolean,
  logger: Logger,
  exec: ExecFn,
): void {
  const { tag } = plan;
  if (plan.exists) {
    logger.log('Tag %s already exists, skipping', tag);
  } else {
    exec('git', ['tag', '--', tag], { cwd: repoRoot, stdio: 'pipe' });
    logger.log('Created tag %s', tag);
  }

  if (push) {
    exec('git', ['push', 'origin', `refs/tags/${tag}`], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    logger.log('Pushed tag %s', tag);
  }
}
