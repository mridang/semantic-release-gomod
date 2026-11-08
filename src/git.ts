import SemanticReleaseError from '@semantic-release/error';
import { statusOf } from './utils/error.js';
import { run as defaultRun, type Run } from './utils/exec.js';

/**
 * How to build a `GitClient`.
 */
export interface GitClientOptions {
  /** The repository directory every command runs in. */
  readonly cwd: string;
  /** Runs a program; defaults to the real, shell-free runner. */
  readonly run?: Run | undefined;
}

/**
 * A handle on the git commands the plugin needs, run in one repository.
 * Every command is passed as a program and an argument list, never as shell
 * text, and git's answers are read from exit statuses and parsed output
 * rather than from its (localised) messages.
 */
export class GitClient {
  private readonly cwd: string;
  private readonly run: Run;

  /**
   * @param options The repository directory and, for tests, a runner.
   */
  constructor(options: GitClientOptions) {
    this.cwd = options.cwd;
    this.run = options.run ?? defaultRun;
  }

  /**
   * Check that git can be run.
   *
   * @returns The version line git printed.
   * @throws SemanticReleaseError `ENOGIT` when git cannot be run.
   */
  version(): string {
    try {
      return this.run('git', ['--version'], { cwd: this.cwd }).trim();
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
  head(): string {
    return this.run('git', ['rev-parse', 'HEAD'], { cwd: this.cwd }).trim();
  }

  /**
   * Whether git accepts a reference name.
   *
   * @param ref A full reference such as `refs/tags/v1.2.3`.
   * @returns True when `git check-ref-format` accepts it.
   * @throws Whatever git failed with, unless it only answered "invalid"
   * (exit status 1).
   */
  checkRefFormat(ref: string): boolean {
    return this.answer(['check-ref-format', ref]);
  }

  /**
   * The commit a local tag points at. An annotated tag is followed to the
   * commit.
   *
   * @param tag The tag name, e.g. `assert/v1.2.3`.
   * @returns The commit hash, or undefined when the tag does not exist.
   * @throws Whatever git failed with, unless it only answered "missing"
   * (exit status 1).
   */
  commitOf(tag: string): string | undefined {
    try {
      return this.run(
        'git',
        ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`],
        { cwd: this.cwd },
      ).trim();
    } catch (err: unknown) {
      if (statusOf(err) === 1) return undefined;
      throw err;
    }
  }

  /**
   * Whether a local tag exists.
   *
   * @param tag The tag name.
   * @returns True when the tag exists.
   */
  tagExists(tag: string): boolean {
    return this.commitOf(tag) !== undefined;
  }

  /**
   * The tags on the remote `origin`, with the commit each points at.
   *
   * @returns A map from tag name to commit hash; an annotated tag maps to the
   * commit it peels to.
   */
  lsRemoteTags(): ReadonlyMap<string, string> {
    const listing = this.run('git', ['ls-remote', '--tags', 'origin'], {
      cwd: this.cwd,
    });
    // The peeled entry (`<tag>^{}`) follows its tag object, so it wins.
    return new Map(
      listing.split('\n').flatMap((line) => {
        const match = /^([0-9a-f]+)\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
        return match?.[1] && match[2] ? [[match[2], match[1]] as const] : [];
      }),
    );
  }

  /**
   * Create a lightweight tag at `HEAD`.
   *
   * @param tag The tag name.
   */
  createTag(tag: string): void {
    this.run('git', ['tag', '--', tag], { cwd: this.cwd });
  }

  /**
   * Push one tag to the remote `origin`.
   *
   * @param tag The tag name.
   */
  pushTag(tag: string): void {
    this.run('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: this.cwd });
  }

  /**
   * Ask git a yes/no question by its exit status.
   *
   * @param args The git arguments.
   * @returns True for exit status 0, false for exit status 1.
   * @throws Whatever git failed with for any other status or error, so a git
   * that could not run is not mistaken for "no".
   */
  private answer(args: readonly string[]): boolean {
    try {
      this.run('git', args, { cwd: this.cwd });
      return true;
    } catch (err: unknown) {
      if (statusOf(err) === 1) return false;
      throw err;
    }
  }
}
