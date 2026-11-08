import { describe, expect, it, jest } from '@jest/globals';
import { GitClient } from '../src/git.js';
import type { Run } from '../src/utils/exec.js';
import { exitedWith } from './utils/context.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

/**
 * A client whose runner answers with a fixed result or failure.
 *
 * @param outcome What the runner returns, or the error it throws.
 * @returns The client and the runner, to inspect its calls.
 */
function clientThat(outcome: string | Error): {
  readonly git: GitClient;
  readonly run: jest.Mock<Run>;
} {
  const run = jest.fn<Run>(() => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { git: new GitClient({ cwd: '/repo', run }), run };
}

describe('GitClient', () => {
  it('uses the real runner when none is given', () => {
    expect(new GitClient({ cwd: process.cwd() }).version()).toMatch(
      /^git version/,
    );
  });

  describe('version', () => {
    it('runs git --version in the repository and returns the line', () => {
      const { git, run } = clientThat('git version 2.45.0\n');
      expect(git.version()).toBe('git version 2.45.0');
      expect(run).toHaveBeenCalledWith('git', ['--version'], { cwd: '/repo' });
    });

    it.each([
      [
        'a missing git',
        Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
      ],
      ['a failing git', exitedWith(127)],
    ])('maps %s to ENOGIT', (_name, failure) => {
      expect(() => clientThat(failure).git.version()).toThrow(
        expect.objectContaining({
          code: 'ENOGIT',
          message: 'git is not available.',
        }),
      );
    });
  });

  describe('head', () => {
    it('returns the trimmed commit of HEAD', () => {
      const { git, run } = clientThat(`${SHA}\n`);
      expect(git.head()).toBe(SHA);
      expect(run).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
        cwd: '/repo',
      });
    });
  });

  describe('checkRefFormat', () => {
    it('is true when git accepts the name', () => {
      const { git, run } = clientThat('');
      expect(git.checkRefFormat('refs/tags/v1.2.3')).toBe(true);
      expect(run).toHaveBeenCalledWith(
        'git',
        ['check-ref-format', 'refs/tags/v1.2.3'],
        { cwd: '/repo' },
      );
    });

    it('is false when git exits with status 1', () => {
      expect(
        clientThat(exitedWith(1)).git.checkRefFormat('refs/tags/a b'),
      ).toBe(false);
    });

    it.each([
      ['status 128', exitedWith(128)],
      ['a missing program', Object.assign(new Error('x'), { code: 'ENOENT' })],
      ['a signal', Object.assign(new Error('x'), { signal: 'SIGKILL' })],
    ])('rethrows %s instead of answering no', (_name, failure) => {
      expect(() =>
        clientThat(failure).git.checkRefFormat('refs/tags/v1'),
      ).toThrow(failure);
    });
  });

  describe('commitOf and tagExists', () => {
    it('asks for the commit the tag peels to', () => {
      const { git, run } = clientThat(`${SHA}\n`);
      expect(git.commitOf('sub/v1.2.3')).toBe(SHA);
      expect(run).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '-q', '--verify', 'refs/tags/sub/v1.2.3^{commit}'],
        { cwd: '/repo' },
      );
    });

    it('is undefined for a missing tag, and tagExists is false', () => {
      const { git } = clientThat(exitedWith(1));
      expect(git.commitOf('v1.2.3')).toBeUndefined();
      expect(git.tagExists('v1.2.3')).toBe(false);
    });

    it('reports an existing tag', () => {
      expect(clientThat(SHA).git.tagExists('v1.2.3')).toBe(true);
    });

    it.each([
      ['status 128', exitedWith(128)],
      ['a missing program', Object.assign(new Error('x'), { code: 'ENOENT' })],
    ])('rethrows %s instead of calling the tag missing', (_name, failure) => {
      expect(() => clientThat(failure).git.commitOf('v1.2.3')).toThrow(failure);
    });
  });

  describe('lsRemoteTags', () => {
    it('lists the tags of origin, annotated ones peeled to their commit', () => {
      const { git, run } = clientThat(
        [
          `${OTHER}\trefs/tags/a/v1.0.0`,
          `${SHA}\trefs/tags/a/v1.0.0^{}`,
          `${SHA}\trefs/tags/v1.0.0`,
          'not a listing line',
          '',
        ].join('\n'),
      );
      expect(git.lsRemoteTags()).toEqual(
        new Map([
          ['a/v1.0.0', SHA],
          ['v1.0.0', SHA],
        ]),
      );
      expect(run).toHaveBeenCalledWith(
        'git',
        ['ls-remote', '--tags', 'origin'],
        {
          cwd: '/repo',
        },
      );
    });

    it('is empty for an empty listing', () => {
      expect(clientThat('').git.lsRemoteTags().size).toBe(0);
    });

    it('rethrows a failing remote', () => {
      const failure = exitedWith(128);
      expect(() => clientThat(failure).git.lsRemoteTags()).toThrow(failure);
    });
  });

  describe('createTag and pushTag', () => {
    it('creates a tag with -- so a name is never an option', () => {
      const { git, run } = clientThat('');
      git.createTag('sub/v1.2.3');
      expect(run).toHaveBeenCalledWith('git', ['tag', '--', 'sub/v1.2.3'], {
        cwd: '/repo',
      });
    });

    it('pushes one tag ref to origin', () => {
      const { git, run } = clientThat('');
      git.pushTag('sub/v1.2.3');
      expect(run).toHaveBeenCalledWith(
        'git',
        ['push', 'origin', 'refs/tags/sub/v1.2.3'],
        { cwd: '/repo' },
      );
    });

    it.each([
      ['a semicolon', 'a;b/v1.0.0'],
      ['a command substitution', '$(id)/v1.0.0'],
      ['quotes and backticks', '"a\'`b/v1.0.0'],
      ['spaces', 'a b/v1.0.0'],
    ])('passes a tag with %s as a single argument', (_name, tag) => {
      const { git, run } = clientThat('');
      git.createTag(tag);
      git.pushTag(tag);
      expect(run.mock.calls.map(([, args]) => args.at(-1))).toEqual([
        tag,
        `refs/tags/${tag}`,
      ]);
    });

    it('lets a failure propagate', () => {
      const failure = new Error('fatal: cannot lock ref');
      expect(() => clientThat(failure).git.createTag('v1')).toThrow(failure);
      expect(() => clientThat(failure).git.pushTag('v1')).toThrow(failure);
    });
  });
});
