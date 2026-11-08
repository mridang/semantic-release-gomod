import { describe, expect, it, jest } from '@jest/globals';
import { GitRepository, Tag } from '../src/git.js';
import type { ExecOptions, Runner } from '../src/utils/exec.js';
import { exitedWith } from './utils/context.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

/**
 * A repository whose runner answers every command the same way.
 *
 * @param outcome What the runner returns, or the error it rejects with.
 * @returns The repository and the runner, to inspect its calls.
 */
function repositoryThat(outcome: string | Error): {
  readonly repository: GitRepository;
  readonly run: jest.Mock<Runner>;
} {
  const run = jest.fn<Runner>(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { repository: GitRepository.open({ cwd: '/repo', run }), run };
}

/** Every git command runs in the repository directory. */
const inRepo: ExecOptions = { cwd: '/repo' };

const missingProgram = Object.assign(new Error('spawn git ENOENT'), {
  code: 'ENOENT',
});

describe('GitRepository', () => {
  it('uses the real runner when none is given', async () => {
    const repository = GitRepository.open({ cwd: process.cwd() });
    await expect(repository.version()).resolves.toMatch(/^git version/);
  });

  describe('version', () => {
    it('runs git --version in the repository and returns the line', async () => {
      const { repository, run } = repositoryThat('git version 2.45.0\n');
      await expect(repository.version()).resolves.toBe('git version 2.45.0');
      expect(run).toHaveBeenCalledWith('git', ['--version'], inRepo);
    });

    it.each([
      ['a missing git', missingProgram],
      ['a failing git', exitedWith(127)],
    ])('maps %s to ENOGIT', async (_name, failure) => {
      await expect(
        repositoryThat(failure).repository.version(),
      ).rejects.toMatchObject({
        code: 'ENOGIT',
        message: 'git is not available.',
      });
    });
  });

  describe('head', () => {
    it('returns the trimmed commit of HEAD', async () => {
      const { repository, run } = repositoryThat(`${SHA}\n`);
      await expect(repository.head()).resolves.toBe(SHA);
      expect(run).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
        cwd: '/repo',
      });
    });
  });

  describe('isValidTagName', () => {
    it('is true when git accepts the name', async () => {
      const { repository, run } = repositoryThat('');
      await expect(repository.isValidTagName('sub/v1.2.3')).resolves.toBe(true);
      expect(run).toHaveBeenCalledWith(
        'git',
        ['check-ref-format', 'refs/tags/sub/v1.2.3'],
        inRepo,
      );
    });

    it('is false when git exits with status 1', async () => {
      const { repository } = repositoryThat(exitedWith(1));
      await expect(repository.isValidTagName('a b/v1')).resolves.toBe(false);
    });

    it('refuses a name starting with a dash without asking git', async () => {
      const { repository, run } = repositoryThat('');
      await expect(repository.isValidTagName('-dash/v1')).resolves.toBe(false);
      expect(run).not.toHaveBeenCalled();
    });

    it.each([
      ['status 128', exitedWith(128)],
      ['a missing program', missingProgram],
      ['a signal', Object.assign(new Error('x'), { signal: 'SIGKILL' })],
    ])('rethrows %s instead of answering no', async (_name, failure) => {
      await expect(
        repositoryThat(failure).repository.isValidTagName('v1'),
      ).rejects.toBe(failure);
    });
  });

  describe('remoteTags', () => {
    it('lists the tags of origin, annotated ones peeled to their commit', async () => {
      const { repository, run } = repositoryThat(
        [
          `${OTHER}\trefs/tags/a/v1.0.0`,
          `${SHA}\trefs/tags/a/v1.0.0^{}`,
          `${SHA}\trefs/tags/v1.0.0`,
          'not a listing line',
          '',
        ].join('\n'),
      );
      await expect(repository.remoteTags()).resolves.toEqual(
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

    it('is empty for an empty listing', async () => {
      const tags = await repositoryThat('').repository.remoteTags();
      expect(tags.size).toBe(0);
    });

    it('rethrows a failing remote', async () => {
      const failure = exitedWith(128);
      await expect(
        repositoryThat(failure).repository.remoteTags(),
      ).rejects.toBe(failure);
    });
  });

  describe('tag', () => {
    it('gives a tag of the repository that runs in its directory', async () => {
      const { repository, run } = repositoryThat(SHA);
      const tag = repository.tag('v1.2.3');
      expect(tag).toBeInstanceOf(Tag);
      expect(tag.name).toBe('v1.2.3');
      await tag.commit();
      expect(run).toHaveBeenCalledWith('git', expect.any(Array), {
        cwd: '/repo',
      });
    });
  });
});

describe('Tag', () => {
  describe('commit and exists', () => {
    it('asks for the commit the tag peels to', async () => {
      const { repository, run } = repositoryThat(`${SHA}\n`);
      await expect(repository.tag('sub/v1.2.3').commit()).resolves.toBe(SHA);
      expect(run).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '-q', '--verify', 'refs/tags/sub/v1.2.3^{commit}'],
        inRepo,
      );
    });

    it('is undefined for a missing tag, which then does not exist', async () => {
      const tag = repositoryThat(exitedWith(1)).repository.tag('v1.2.3');
      await expect(tag.commit()).resolves.toBeUndefined();
      await expect(tag.exists()).resolves.toBe(false);
    });

    it('reports an existing tag', async () => {
      const tag = repositoryThat(SHA).repository.tag('v1.2.3');
      await expect(tag.exists()).resolves.toBe(true);
    });

    it.each([
      ['status 128', exitedWith(128)],
      ['a missing program', missingProgram],
    ])(
      'rethrows %s instead of calling the tag missing',
      async (_name, failure) => {
        const tag = repositoryThat(failure).repository.tag('v1.2.3');
        await expect(tag.commit()).rejects.toBe(failure);
      },
    );
  });

  describe('create and push', () => {
    it('creates a tag with -- so a name is never an option, and returns it', async () => {
      const { repository, run } = repositoryThat('');
      const tag = repository.tag('sub/v1.2.3');
      await expect(tag.create()).resolves.toBe(tag);
      expect(run).toHaveBeenCalledWith('git', ['tag', '--', 'sub/v1.2.3'], {
        cwd: '/repo',
      });
    });

    it('pushes one tag ref to origin, and returns the tag', async () => {
      const { repository, run } = repositoryThat('');
      const tag = repository.tag('sub/v1.2.3');
      await expect(tag.push()).resolves.toBe(tag);
      expect(run).toHaveBeenCalledWith(
        'git',
        ['push', 'origin', 'refs/tags/sub/v1.2.3'],
        inRepo,
      );
    });

    it.each([
      ['a semicolon', 'a;b/v1.0.0'],
      ['a command substitution', '$(id)/v1.0.0'],
      ['quotes and backticks', '"a\'`b/v1.0.0'],
      ['spaces', 'a b/v1.0.0'],
    ])('passes a tag with %s as a single argument', async (_name, name) => {
      const { repository, run } = repositoryThat('');
      const tag = repository.tag(name);
      await tag.create();
      await tag.push();
      expect(run.mock.calls.map(([, args]) => args.at(-1))).toEqual([
        name,
        `refs/tags/${name}`,
      ]);
    });

    it('lets a failure propagate', async () => {
      const failure = new Error('fatal: cannot lock ref');
      const tag = repositoryThat(failure).repository.tag('v1');
      await expect(tag.create()).rejects.toBe(failure);
      await expect(tag.push()).rejects.toBe(failure);
    });
  });
});
