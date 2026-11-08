import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StepLogger } from './plugin-config.js';
import { run as defaultRun, type Runner } from './utils/exec.js';

/**
 * The part of the semantic-release context logger the helpers use.
 */
type Logger = Pick<StepLogger, 'log' | 'warn'>;

/**
 * Directories that are not searched for modules when walking the tree or
 * expanding a wildcard: git's data, vendored dependencies, and every
 * dot-directory (such as a `.go` module cache, `.tools` or a git worktree
 * under `.claude`). A go.mod below a dot-directory can never be released,
 * because neither a Go module path nor a git ref may have a component
 * starting with a dot. A literal path into one of them is still honoured.
 *
 * @param name A directory name.
 * @returns True when the directory is not searched.
 */
function isIgnoredDir(name: string): boolean {
  return name === 'vendor' || name === 'node_modules' || name.startsWith('.');
}

/**
 * What a search found: go.mod files, and the directories it left out.
 */
interface Found {
  /** Absolute paths of the go.mod files found. */
  readonly files: readonly string[];
  /** Absolute paths of the ignored directories that were not searched. */
  readonly skipped: readonly string[];
}

/**
 * Combine the results of several searches.
 *
 * @param parts The results to combine.
 * @returns One result with all their files and skipped directories.
 */
function merge(parts: readonly Found[]): Found {
  return {
    files: parts.flatMap((part) => part.files),
    skipped: parts.flatMap((part) => part.skipped),
  };
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
 * What is in a directory, sorted for a search.
 */
interface Listing {
  /** Names of the regular files. */
  readonly files: readonly string[];
  /** Absolute paths of the subdirectories to search. */
  readonly searchable: readonly string[];
  /** Absolute paths of the ignored subdirectories. */
  readonly ignored: readonly string[];
}

/**
 * List a directory once and sort what is in it: the regular files, the
 * subdirectories to search, and the ignored subdirectories (skipped before
 * they are read, so a huge `node_modules` is never walked). A directory that
 * cannot be read is empty.
 *
 * @param dir Absolute path of the directory.
 * @returns Names of its regular files, and the absolute paths of the
 * subdirectories to search and of those that are ignored.
 */
function scan(dir: string): Listing {
  const entries = safeReadDir(dir);
  const dirs = entries.filter((entry) => entry.isDirectory());
  const full = (entry: fs.Dirent): string => path.join(dir, entry.name);
  return {
    files: entries.filter((entry) => entry.isFile()).map((e) => e.name),
    searchable: dirs.filter((e) => !isIgnoredDir(e.name)).map(full),
    ignored: dirs.filter((e) => isIgnoredDir(e.name)).map(full),
  };
}

/**
 * Find the submodule go.mod files: every go.mod below `root` except the
 * root-level one, or the ones the glob patterns match.
 *
 * Without patterns the tree is walked, skipping `vendor`, `node_modules`
 * and dot-directories. Patterns support literal names and whole-segment `*`
 * and `**` wildcards, which skip the same directories; a literal path is
 * honoured even inside them. Links are never followed or matched, neither a
 * symlinked go.mod nor a symlinked directory, and a match outside the
 * repository is dropped. A pattern that matches nothing is reported with a
 * warning, and each skipped directory (other than `.git`) is reported once.
 *
 * @param root         Absolute path to the repository root.
 * @param globPatterns Optional array of glob patterns relative to root.
 * @param logger       Where skipped directories and empty patterns are reported.
 * @returns Sorted array of absolute go.mod paths (submodules only).
 */
function discoverSubmoduleGoMods(
  root: string,
  globPatterns: readonly string[] | undefined,
  logger: Logger,
): readonly string[] {
  const rootGoMod = path.join(root, 'go.mod');
  const isSubmodule = (file: string): boolean =>
    file !== rootGoMod && isInside(root, file);
  const searches =
    globPatterns && globPatterns.length > 0
      ? globPatterns.map((pattern) => ({
          pattern,
          found: matchParts(root, pattern.split('/')),
        }))
      : [{ pattern: undefined, found: walkForGoMods(root) }];
  new Set(
    searches
      .flatMap(({ found }) => found.skipped)
      .filter((dir) => path.basename(dir) !== '.git'),
  ).forEach((dir) => {
    logger.log(
      'Not searching %s for modules. Name a go.mod in it in the `modules` option to include it.',
      dir,
    );
  });
  searches
    .filter(
      ({ pattern, found }) =>
        pattern !== undefined && !found.files.some(isSubmodule),
    )
    .forEach(({ pattern }) => {
      logger.warn(
        'Pattern "%s" in `modules` matched no go.mod files.',
        pattern,
      );
    });
  return [
    ...new Set(
      searches.flatMap(({ found }) => found.files).filter(isSubmodule),
    ),
  ].toSorted();
}

/**
 * Recursively walk `dir` and find all go.mod files, skipping the ignored
 * directories. Only regular files count, so a symlink named go.mod is
 * ignored.
 *
 * @param dir Absolute path of the directory to walk.
 * @returns Every go.mod file below it, including one directly inside it.
 */
function walkForGoMods(dir: string): Found {
  const { files, searchable, ignored } = scan(dir);
  return merge([
    {
      files: files.includes('go.mod') ? [path.join(dir, 'go.mod')] : [],
      skipped: ignored,
    },
    ...searchable.map(walkForGoMods),
  ]);
}

/**
 * Whether a path is a directory itself, not a link to one.
 *
 * @param target Absolute path to check.
 * @returns True for a real directory.
 */
function isRealDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a file lies inside the repository, judged on the resolved
 * relative path so `..` and other drives are caught whatever the separator.
 *
 * @param root    Absolute path to the repository root.
 * @param file    Absolute path to a file.
 * @param pathApi Path implementation (injectable to test Windows paths).
 * @returns True when the file is below the root.
 */
export function isInside(
  root: string,
  file: string,
  pathApi: Pick<typeof path, 'relative' | 'sep' | 'isAbsolute'> = path,
): boolean {
  const relative = pathApi.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
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
 * @returns The matching files, and the ignored directories passed over.
 */
function matchParts(dir: string, parts: readonly string[]): Found {
  const none: Found = { files: [], skipped: [] };
  if (parts.length === 0) return none;
  const [head, ...tail] = parts;

  if (head === '**') {
    // Zero levels: continue with the tail from the current dir.
    // One or more levels: descend into each subdirectory.
    const { searchable, ignored } = scan(dir);
    return merge([
      matchParts(dir, tail),
      { files: [], skipped: ignored },
      ...searchable.map((sub) => matchParts(sub, parts)),
    ]);
  }

  if (tail.length === 0) {
    // Last segment: must be a regular file (one lstat avoids a TOCTOU race).
    const candidate = path.join(dir, head);
    try {
      return fs.lstatSync(candidate).isFile()
        ? { files: [candidate], skipped: [] }
        : none;
    } catch {
      return none;
    }
  }

  if (head === '*') {
    // Single-level wildcard
    const { searchable, ignored } = scan(dir);
    return merge([
      { files: [], skipped: ignored },
      ...searchable.map((sub) => matchParts(sub, tail)),
    ]);
  }

  // Literal segment: a missing path, or a link, matches nothing.
  const next = path.join(dir, head);
  return isRealDirectory(next) ? matchParts(next, tail) : none;
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
export function tagPrefix(
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
 * How to open a `GoModule`.
 */
export interface GoModuleOptions {
  /** Runs a program; defaults to the real, shell-free runner. */
  readonly run?: Runner | undefined;
}

/**
 * A go.mod file on disk. It knows its module path, which tag a release gives
 * it, how to pin the requires on the root module to a new version, and how to
 * tidy itself. The file is read when asked, so opening one never fails.
 */
export class GoModule {
  /** Absolute path to the go.mod file. */
  readonly file: string;
  /** Runs `go`. */
  private readonly run: Runner;

  /**
   * @param file Absolute path to the go.mod file.
   * @param run  Runs `go`.
   */
  private constructor(file: string, run: Runner) {
    this.file = file;
    this.run = run;
  }

  /**
   * Open a go.mod file.
   *
   * @param file    Absolute path to the go.mod file.
   * @param options For tests, a runner.
   * @returns The module.
   */
  static open(file: string, options: GoModuleOptions = {}): GoModule {
    return new GoModule(file, options.run ?? defaultRun);
  }

  /**
   * Find the submodules of a repository: every go.mod below the root except
   * the root-level one, or the ones the glob patterns match. See the README
   * for which directories are skipped and which patterns are supported.
   *
   * @param root     Absolute path to the repository root.
   * @param patterns Optional glob patterns relative to the root.
   * @param logger   Where skipped directories and empty patterns are reported.
   * @param options  For tests, a runner.
   * @returns The submodules, sorted by path.
   */
  static discover(
    root: string,
    patterns: readonly string[] | undefined,
    logger: Logger,
    options: GoModuleOptions = {},
  ): readonly GoModule[] {
    return discoverSubmoduleGoMods(root, patterns, logger).map((file) =>
      GoModule.open(file, options),
    );
  }

  /**
   * The module's import path, e.g. `github.com/mridang/wilhelm`.
   *
   * @returns The path of its `module` declaration.
   * @throws Error if the file has no readable `module` declaration.
   */
  modulePath(): string {
    const content = fs.readFileSync(this.file, 'utf8');
    const line = content
      .split('\n')
      .find((candidate) => /^\uFEFF?module(?:\s|\(|$)/.test(candidate));
    if (line === undefined) {
      throw new Error(`No module declaration found in ${this.file}`);
    }
    if (/^\uFEFF?module\s*\(/.test(line)) {
      throw new Error(
        `Grouped module declarations ("module (") are not supported, found in ${this.file}`,
      );
    }
    const token = /^\uFEFF?module\s+(\S+)/.exec(line)?.[1];
    if (token === undefined) {
      throw new Error(`No module declaration found in ${this.file}`);
    }
    const quoted = /^(["`])(.*)\1$/.exec(token);
    if (quoted) return quoted[2];
    if (/^["`]/.test(token)) {
      throw new Error(
        `Unterminated quote in the module declaration in ${this.file}`,
      );
    }
    return token;
  }

  /**
   * The git tag a release gives this module: its directory relative to the
   * repository root, then `/v<version>`; the root module's tag is just
   * `v<version>`.
   *
   * @param root    Absolute path to the repository root.
   * @param version The version without a leading `v`.
   * @returns The tag name, e.g. `assert/cert/manager/v1.2.3`.
   */
  tagName(root: string, version: string): string {
    const prefix = tagPrefix(this.file, root);
    if (prefix === '') return `v${version}`;
    return `${prefix}/v${version}`;
  }

  /**
   * Pin every `require` of the root module (or one of its sub-paths) to a
   * new version, leaving every other byte of the file alone.
   *
   * @param rootModule The root module's import path.
   * @param version    The new version without a leading `v`.
   * @returns This module.
   */
  pin(rootModule: string, version: string): GoModule {
    const content = fs.readFileSync(this.file, 'utf8');
    // Escape slashes and dots in the module path for use in regex
    const escaped = rootModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The path must be the root module or one of its sub-paths, so `repo` does
    // not match `repository` or `repo-x`.
    // A first sub-path segment such as `/v2` is a different module (a new
    // major version), so it is not pinned to this one's release.
    // A path may be quoted with " or a backtick (written as an escape here).
    const quoteChars = '"\\u0060';
    const quote = `[${quoteChars}]?`;
    const requirePath = `${quote}${escaped}(?:/(?!v[0-9]+(?:/|[${quoteChars}]|[ \\t]))[^\\s${quoteChars}]*)?`;
    const versionPattern = `(${quote})([ \\t]+)v[0-9]\\S*`;
    const inBlock = new RegExp(
      `^([ \\t]*${requirePath})${versionPattern}`,
      'gm',
    );
    const single = new RegExp(
      `^([ \\t]*require[ \\t]+${requirePath})${versionPattern}`,
      'gm',
    );
    const pin = `$1$2$3v${version}`;
    // Only `require` directives are pinned, never replace, exclude or retract.
    const updated = content
      .replace(
        /(^[ \t]*require[ \t]*\([ \t]*(?:\/\/[^\r\n]*)?\r?\n)([\s\S]*?)(^[ \t]*\))/gm,
        (_match, open: string, body: string, close: string) =>
          `${open}${body.replace(inBlock, pin)}${close}`,
      )
      .replace(single, pin);
    if (updated !== content) {
      fs.writeFileSync(this.file, updated, 'utf8');
    }
    return this;
  }

  /**
   * Run `go mod tidy` in the module's directory.
   *
   * @returns This module.
   * @throws Whatever `go` failed with, for the caller to report.
   */
  async tidy(): Promise<GoModule> {
    await this.run('go', ['mod', 'tidy'], { cwd: path.dirname(this.file) });
    return this;
  }
}
