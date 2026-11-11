/**
 * @file Creates real git repositories for tests that need one on disk.
 */

import { execFileSync } from 'node:child_process';

/**
 * Turn a directory into a git repository with one empty commit.
 * @param dir - The directory.
 * @returns A function running git in the repository and returning its output.
 * @example
 * const git = initRepo('/tmp/gomod-test-repo');
 * git('rev-parse', 'HEAD');
 */
export function initRepo(dir: string): (...args: readonly string[]) => string {
  const git = (...args: readonly string[]): string =>
    // eslint-disable-next-line n/no-sync -- sync is fine in a test fixture; the helper is called once per test
    execFileSync(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- test fixture runs the git on PATH that the suite itself uses
      'git',
      ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=t@e.com', ...args],
      { encoding: 'utf8' },
    );
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  return git;
}

/**
 * Turn a directory into an empty bare repository, to use as a remote.
 * @param dir - The directory.
 * @example
 * initBare('/tmp/gomod-test-remote.git');
 */
export function initBare(dir: string): void {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test fixture; the helper is called once per test
  execFileSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- test fixture runs the git on PATH that the suite itself uses
    'git',
    ['init', '--bare', '-q', dir],
  );
}
