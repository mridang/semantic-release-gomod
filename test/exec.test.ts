import { describe, expect, it } from '@jest/globals';
import { defaultExec } from '../src/exec.js';

describe('defaultExec', () => {
  it('runs a command that succeeds', () => {
    expect(() =>
      defaultExec('node --version', { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('throws when the command exits with a non-zero status', () => {
    expect(() =>
      defaultExec('node -e "process.exit(3)"', { stdio: 'pipe' }),
    ).toThrow(/Command failed/);
  });
});
