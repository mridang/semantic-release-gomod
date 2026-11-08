import SemanticReleaseError from '@semantic-release/error';
import { statusOf } from './utils/error.js';
import { run as defaultRun, type Runner } from './utils/exec.js';

/**
 * How to open a `GitRepository`.
 */
export interface GitOptions {
  /** The repository directory every command runs in. */
  readonly cwd: string;
  /** Runs a program; defaults to the real, shell-free runner. */
  readonly run?: Runner | undefined;
}

/**
 * What a `Tag` needs to run git: the repository directory and a runner.
 */
interface TagOptions {
  /** The repository directory. */
  readonly cwd: string;
  /** Runs git. */
  readonly run: Runner;
}

/**
 * A tag in a repository, which may or may not exist yet. git's answers are
 * read from exit statuses, never from its (localised) messages.
 */
export class Tag {
  /** The tag name, e.g. `assert/v1.2.3`. */
  readonly name: string;
  /** The repository directory git runs in. */
  private readonly cwd: string;
  /** Runs git. */
  private readonly run: Runner;

  /**
   * @param name    The tag name, e.g. `assert/v1.2.3`.
   * @param options The repository directory and the runner.
   */
  constructor(name: string, options: TagOptions) {
    this.name = name;
    this.cwd = options.cwd;
    this.run = options.run;
  }

  /**
   * The commit the tag points at; an annotated tag is followed to the commit.
   *
   * @returns The commit hash, or undefined when the tag does not exist.
   * @throws Whatever git failed with, unless it only answered "missing"
   * (exit status 1), so a git that could not run is not mistaken for "no".
   */
  async commit(): Promise<string | undefined> {
    try {
      const out = await this.run(
        'git',
        ['rev-parse', '-q', '--verify', `refs/tags/${this.name}^{commit}`],
        { cwd: this.cwd },
      );
      return out.trim();
    } catch (err: unknown) {
      if (statusOf(err) === 1) return undefined;
      throw err;
    }
  }

  /**
   * Whether git accepts the tag's name. A name starting with `-` is refused
   * without asking git, which would read it as an option.
   *
   * @returns True when `git check-ref-format` accepts `refs/tags/<name>`.
   * @throws Whatever git failed with, unless it only answered "invalid" (exit
   * status 1).
   */
  async isValid(): Promise<boolean> {
    if (this.name.startsWith('-')) return false;
    try {
      await this.run('git', ['check-ref-format', `refs/tags/${this.name}`], {
        cwd: this.cwd,
      });
      return true;
    } catch (err: unknown) {
      if (statusOf(err) === 1) return false;
      throw err;
    }
  }

  /**
   * Create the tag at `HEAD`, as a lightweight tag.
   *
   * @returns This tag.
   */
  async create(): Promise<Tag> {
    await this.run('git', ['tag', '--', this.name], { cwd: this.cwd });
    return this;
  }

  /**
   * Push the tag to the remote `origin`.
   *
   * @returns This tag.
   */
  async push(): Promise<Tag> {
    await this.run('git', ['push', 'origin', `refs/tags/${this.name}`], {
      cwd: this.cwd,
    });
    return this;
  }
}

/**
 * A git repository on disk.
 */
export class GitRepository {
  /** The repository directory every command runs in. */
  readonly cwd: string;
  /** Runs git. */
  private readonly run: Runner;

  /**
   * @param cwd The repository directory.
   * @param run Runs git.
   */
  private constructor(cwd: string, run: Runner) {
    this.cwd = cwd;
    this.run = run;
  }

  /**
   * Open the repository in a directory.
   *
   * @param options The directory and, for tests, a runner.
   * @returns The repository.
   */
  static open(options: GitOptions): GitRepository {
    return new GitRepository(options.cwd, options.run ?? defaultRun);
  }

  /**
   * Check that git can be run.
   *
   * @returns The version line git printed.
   * @throws SemanticReleaseError `ENOGIT` when git cannot be run.
   */
  async version(): Promise<string> {
    try {
      const out = await this.run('git', ['--version'], { cwd: this.cwd });
      return out.trim();
    } catch {
      throw new SemanticReleaseError(
        'git is not available.',
        'ENOGIT',
        'The `git` executable could not be found. Ensure git is installed and available on PATH.',
      );
    }
  }

  /**
   * The commit `HEAD` points at.
   *
   * @returns The full commit hash.
   */
  async head(): Promise<string> {
    const out = await this.run('git', ['rev-parse', 'HEAD'], {
      cwd: this.cwd,
    });
    return out.trim();
  }

  /**
   * A tag of this repository.
   *
   * @param name The tag name.
   * @returns The tag, which may not exist yet.
   */
  tag(name: string): Tag {
    return new Tag(name, { cwd: this.cwd, run: this.run });
  }

  /**
   * The tags on the remote `origin`, with the commit each points at.
   *
   * @returns A map from tag name to commit hash; an annotated tag maps to the
   * commit it peels to.
   */
  async remoteTags(): Promise<ReadonlyMap<string, string>> {
    const listing = await this.run('git', ['ls-remote', '--tags', 'origin'], {
      cwd: this.cwd,
    });
    // The peeled entry (`<tag>^{}`) follows its tag object, so it wins.
    return new Map(
      listing.split('\n').flatMap((line) => {
        const match = /^([0-9a-f]+)\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
        if (!match?.[1] || !match[2]) return [];
        return [[match[2], match[1]] as const];
      }),
    );
  }
}
