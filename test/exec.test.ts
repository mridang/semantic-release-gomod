import { describe, expect, it } from '@jest/globals';
import { defaultExec } from '../src/exec.js';

const node = (code: string): void =>
  defaultExec('node', ['-e', code], { stdio: 'pipe' });

describe('defaultExec', () => {
  it('runs a program that succeeds', () => {
    expect(() =>
      defaultExec('node', ['--version'], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('throws when the program exits with a non-zero status', () => {
    expect(() => node('process.exit(3)')).toThrow(/Command failed/);
  });

  it('throws when the program does not exist', () => {
    expect(() => defaultExec('no-such-program-gomod', [])).toThrow(/ENOENT/);
  });

  it('passes arguments without a shell', () => {
    expect(() =>
      node('if (process.argv.length !== 1) process.exit(1)'),
    ).not.toThrow();
    expect(() =>
      defaultExec(
        'node',
        [
          '-e',
          'process.exit(process.argv[1] === "a;b $(c)" ? 0 : 1)',
          'a;b $(c)',
        ],
        {
          stdio: 'pipe',
        },
      ),
    ).not.toThrow();
  });

  it('accepts output larger than the default buffer', () => {
    expect(() =>
      node('process.stdout.write("x".repeat(8 * 1024 * 1024))'),
    ).not.toThrow();
  });

  it('redacts credentials in URLs from the error message', () => {
    expect(() =>
      node(
        'console.error("fatal: unable to access https://user:s3cret@github.com/o/r.git/"); process.exit(1)',
      ),
    ).toThrow(/https:\/\/\*\*\*@github\.com/);
    expect(() =>
      node(
        'console.error("https://user:s3cret@github.com/o/r"); process.exit(1)',
      ),
    ).not.toThrow(/s3cret/);
  });
});
