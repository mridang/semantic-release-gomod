/**
 * @file Creates real git repositories for tests that need one on disk.
 */

import { execFileAsync } from './exec.js';

/**
 * Turn a directory into a git repository with one empty commit.
 * @param dir - The directory.
 * @returns A function running git in the repository and returning its output.
 * @example
 * const git = initRepo('/tmp/gomod-test-repo');
 * git('rev-parse', 'HEAD');
 */
export async function initRepo(
  dir: string,
): Promise<(...args: readonly string[]) => Promise<string>> {
  const git = async (...args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=t@e.com', ...args],
      { encoding: 'utf8' },
    );
    return stdout;
  };
  await git('init', '-q');
  await git('commit', '-q', '--allow-empty', '-m', 'one');
  return git;
}

/**
 * Turn a directory into an empty bare repository, to use as a remote.
 * @param dir - The directory.
 * @example
 * initBare('/tmp/gomod-test-remote.git');
 */
export async function initBare(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '--bare', '-q', dir]);
}
