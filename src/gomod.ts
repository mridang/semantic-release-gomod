import * as fs from 'node:fs';
import * as path from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import type { GitClient } from './git.js';
import type { StepLogger } from './plugin-config.js';

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
 * List a directory once and sort what is in it: the regular files, the
 * subdirectories to search, and the ignored subdirectories (skipped before
 * they are read, so a huge `node_modules` is never walked). A directory that
 * cannot be read is empty.
 *
 * @param dir Absolute path of the directory.
 * @returns Names of its regular files, and the absolute paths of the
 * subdirectories to search and of those that are ignored.
 */
function scan(dir: string): {
  readonly files: readonly string[];
  readonly searchable: readonly string[];
  readonly ignored: readonly string[];
} {
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
export function discoverSubmoduleGoMods(
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
 * Read a go.mod file and extract the module declaration.
 *
 * @param goModPath Absolute path to the go.mod file.
 * @returns The module import path, e.g. `"github.com/mridang/wilhelm"`.
 * @throws Error if no `module` line is found, if it uses the grouped
 * `module (` form, or if its quote is not closed.
 */
export function readModulePath(goModPath: string): string {
  const content = fs.readFileSync(goModPath, 'utf8');
  const line = content
    .split('\n')
    .find((candidate) => /^\uFEFF?module(?:\s|\(|$)/.test(candidate));
  if (line === undefined) {
    throw new Error(`No module declaration found in ${goModPath}`);
  }
  if (/^\uFEFF?module\s*\(/.test(line)) {
    throw new Error(
      `Grouped module declarations ("module (") are not supported, found in ${goModPath}`,
    );
  }
  const token = /^\uFEFF?module\s+(\S+)/.exec(line)?.[1];
  if (token === undefined) {
    throw new Error(`No module declaration found in ${goModPath}`);
  }
  const quoted = /^(["`])(.*)\1$/.exec(token);
  if (quoted) return quoted[2];
  if (/^["`]/.test(token)) {
    throw new Error(
      `Unterminated quote in the module declaration in ${goModPath}`,
    );
  }
  return token;
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
  // A path may be quoted with " or a backtick (written as an escape here).
  const quoteChars = '"\\u0060';
  const quote = `[${quoteChars}]?`;
  const requirePath = `${quote}${escaped}(?:/(?!v[0-9]+(?:/|[${quoteChars}]|[ \\t]))[^\\s${quoteChars}]*)?`;
  const version = `(${quote})([ \\t]+)v[0-9]\\S*`;
  const inBlock = new RegExp(`^([ \\t]*${requirePath})${version}`, 'gm');
  const single = new RegExp(
    `^([ \\t]*require[ \\t]+${requirePath})${version}`,
    'gm',
  );
  const pin = `$1$2$3v${newVersion}`;
  // Only `require` directives are pinned, never replace, exclude or retract.
  const updated = content
    .replace(
      /(^[ \t]*require[ \t]*\([ \t]*(?:\/\/[^\r\n]*)?\r?\n)([\s\S]*?)(^[ \t]*\))/gm,
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
 * The tag of every module for a release: the module directory relative to
 * the repository root, then `/v<version>`; the root module's tag is just
 * `v<version>`.
 *
 * @param repoRoot   Absolute path to the repository root.
 * @param submodules Absolute paths of the submodule go.mod files.
 * @param version    The version without a leading `v`.
 * @returns The root tag first, then one tag per submodule.
 */
export function tagNames(
  repoRoot: string,
  submodules: readonly string[],
  version: string,
): readonly string[] {
  return [path.join(repoRoot, 'go.mod'), ...submodules].map((goModPath) => {
    const prefix = deriveTagPrefix(goModPath, repoRoot);
    return prefix ? `${prefix}/v${version}` : `v${version}`;
  });
}

/**
 * Refuse tag names git would reject, so a bad directory name stops the
 * release before anything is changed. Run it as early as the lifecycle
 * allows: once semantic-release has pushed the release commit and the root
 * tag, a later failure leaves a half published release.
 *
 * @param git  The repository's git client.
 * @param tags Every full tag the release will create.
 * @throws SemanticReleaseError `EINVALIDTAG` listing every refused tag.
 */
export function checkTagNames(git: GitClient, tags: readonly string[]): void {
  // A name starting with `-` is refused without asking git, which would read
  // it as an option.
  const invalid = tags.filter(
    (tag) => tag.startsWith('-') || !git.checkRefFormat(`refs/tags/${tag}`),
  );
  if (invalid.length > 0) {
    throw new SemanticReleaseError(
      `Cannot create tag(s) git rejects: ${invalid.join(', ')}.`,
      'EINVALIDTAG',
      'A tag is the module directory plus the version, so rename the directory. Git refuses a tag with a space, `~`, `^`, `:`, `?`, `*`, `[`, `\\`, `..` or `@{`, a component that starts with `.` or ends with `.lock`, a trailing `.` or `/`, and a name starting with `-`. The `modules` option only lists modules to include (there is no exclusion syntax), so to leave a directory out, list the other modules explicitly.',
    );
  }
}

/**
 * Check every tag before any of them is created or pushed, so a bad one
 * cannot leave a release half published. A tag name git would refuse, or an
 * existing tag, local or (when pushing) on the remote, that points at a
 * different commit than `HEAD` (which would publish stale code under the new
 * version), stops the release.
 *
 * @param git  The repository's git client.
 * @param tags Every full tag the release will create.
 * @param push Whether the tags will be pushed, so the remote is checked.
 * @returns For each tag, whether it already exists locally at `HEAD`.
 * @throws SemanticReleaseError `EINVALIDTAG` or `ETAGMISMATCH`.
 */
export function planTags(
  git: GitClient,
  tags: readonly string[],
  push: boolean,
): readonly TagPlan[] {
  checkTagNames(git, tags);
  const head = git.head();
  const remote = push ? git.lsRemoteTags() : new Map<string, string>();
  const plans = tags.map((tag) => ({
    tag,
    local: git.commitOf(tag),
    remote: remote.get(tag),
  }));
  const stale = plans.flatMap(({ tag, local, remote: onRemote }) => [
    ...(local !== undefined && local !== head ? [`${tag} (${local})`] : []),
    ...(onRemote !== undefined && onRemote !== head
      ? [`${tag} on origin (${onRemote})`]
      : []),
  ]);
  if (stale.length > 0) {
    throw new SemanticReleaseError(
      `Tag(s) already exist at another commit than HEAD (${head}): ${stale.join(', ')}.`,
      'ETAGMISMATCH',
      'Pushing them would publish old code under this version. Delete the stale tag(s) locally (`git tag -d <tag>`) and on the remote if they were pushed, or release a new version.',
    );
  }
  return plans.map(({ tag, local }) => ({ tag, exists: local !== undefined }));
}

/**
 * Create a git tag locally and optionally push it to origin. A tag that
 * already points at `HEAD` is not created again, so the plugin can be called
 * idempotently. Use `planTags` first to validate the whole batch.
 *
 * @param git    The repository's git client.
 * @param plan   The tag, and whether it already exists at `HEAD`.
 * @param push   When true, push the tag to `origin`.
 * @param logger semantic-release logger.
 */
export function createAndPushTag(
  git: GitClient,
  plan: TagPlan,
  push: boolean,
  logger: Logger,
): void {
  const { tag } = plan;
  if (plan.exists) {
    logger.log('Tag %s already exists, skipping', tag);
  } else {
    git.createTag(tag);
    logger.log('Created tag %s', tag);
  }

  if (push) {
    git.pushTag(tag);
    logger.log('Pushed tag %s', tag);
  }
}
