import { describe, expect, it } from '@jest/globals';
import { defaultExec } from '../src/exec.js';

const node = (code: string): string =>
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

  it('returns what the program wrote to stdout', () => {
    expect(node('process.stdout.write("hello")')).toBe('hello');
  });

  it.each([
    ['a semicolon and a substitution', 'a;touch${IFS}x $(id) b'],
    ['quotes and backticks', '"a\'`b`'],
    ['spaces and a glob', 'a b *'],
  ])('passes %s through unchanged, as one argument', (_name, value) => {
    const echoed = defaultExec(
      'node',
      [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        value,
      ],
      { stdio: 'pipe' },
    );
    expect(JSON.parse(echoed)).toEqual([value]);
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

  it('keeps the error code of a missing program', () => {
    expect(() => defaultExec('no-such-program-gomod', [])).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('keeps the exit status of a failing program', () => {
    expect(() => node('process.exit(3)')).toThrow(
      expect.objectContaining({ status: 3 }),
    );
  });

  it('keeps the signal that killed the program', () => {
    expect(() => node('process.kill(process.pid, "SIGTERM")')).toThrow(
      expect.objectContaining({ signal: 'SIGTERM' }),
    );
  });
});
