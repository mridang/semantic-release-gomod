import { execFileSync } from 'node:child_process';

/**
 * Turn a directory into a git repository with one empty commit.
 * @param dir - The directory.
 * @returns A function running git in the repository and returning its output.
 */
export function initRepo(dir: string): (...args: readonly string[]) => string {
  const git = (...args: readonly string[]): string =>
    execFileSync(
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
 */
export function initBare(dir: string): void {
  execFileSync('git', ['init', '--bare', '-q', dir]);
}
