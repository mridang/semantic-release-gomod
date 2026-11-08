import { describe, expect, it, jest } from '@jest/globals';
import { Release } from '../src/release.js';
import type { Runner } from '../src/utils/exec.js';
import {
  commandsOf,
  exitedWith,
  HEAD,
  mockExec,
  repoWith,
  tagsOf,
} from './utils/context.js';
import { recordingLogger } from './utils/logger.js';

const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

describe('Release.check', () => {
  it('accepts names git accepts, asking git about each', async () => {
    const exec = mockExec();
    await Release.check(tagsOf(repoWith(exec), ['v1.0.0', 'a/v1.0.0']));
    expect(commandsOf(exec)).toEqual([
      'git check-ref-format refs/tags/v1.0.0',
      'git check-ref-format refs/tags/a/v1.0.0',
    ]);
  });

  it('refuses every name git rejects, in one coded error', async () => {
    const exec = mockExec((cmd) => {
      if (cmd.includes('bad')) throw exitedWith(1);
    });
    await expect(
      Release.check(tagsOf(repoWith(exec), ['v1', 'bad one/v1', 'bad two/v1'])),
    ).rejects.toMatchObject({
      code: 'EINVALIDTAG',
      message: expect.stringContaining('bad one/v1, bad two/v1'),
    });
  });

  it('refuses a name starting with a dash', async () => {
    await expect(
      Release.check(tagsOf(repoWith(mockExec()), ['-dash/v1.0.0'])),
    ).rejects.toMatchObject({ code: 'EINVALIDTAG' });
  });

  it.each([
    ['status 128', exitedWith(128)],
    [
      'a missing git',
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
    ],
  ])(
    'rethrows %s instead of calling the tag invalid',
    async (_name, failure) => {
      const exec = mockExec((cmd) => {
        if (cmd.startsWith('git check-ref-format')) throw failure;
      });
      await expect(
        Release.check(tagsOf(repoWith(exec), ['v1.0.0'])),
      ).rejects.toBe(failure);
    },
  );
});

describe('Release.plan', () => {
  it('checks the names, then HEAD, then each tag, and creates nothing', async () => {
    const exec = mockExec();
    await Release.plan(
      repoWith(exec),
      tagsOf(repoWith(exec), ['v1.0.0', 'a/v1.0.0']),
      false,
    );
    expect(commandsOf(exec)).toEqual([
      'git check-ref-format refs/tags/v1.0.0',
      'git check-ref-format refs/tags/a/v1.0.0',
      'git rev-parse HEAD',
      'git rev-parse -q --verify refs/tags/v1.0.0^{commit}',
      'git rev-parse -q --verify refs/tags/a/v1.0.0^{commit}',
    ]);
  });

  it('refuses a tag that exists at another commit than HEAD', async () => {
    const exec = mockExec(() => undefined, { 'a/v1.0.0': OTHER });
    await expect(
      Release.plan(
        repoWith(exec),
        tagsOf(repoWith(exec), ['v1.0.0', 'a/v1.0.0']),
        false,
      ),
    ).rejects.toMatchObject({
      code: 'ETAGMISMATCH',
      message: expect.stringContaining(`a/v1.0.0 (${OTHER})`),
    });
  });

  it('lists every stale tag in one error', async () => {
    const exec = mockExec(() => undefined, {
      'a/v1.0.0': OTHER,
      'b/v1.0.0': OTHER,
    });
    await expect(
      Release.plan(
        repoWith(exec),
        tagsOf(repoWith(exec), ['a/v1.0.0', 'b/v1.0.0']),
        false,
      ),
    ).rejects.toThrow(/a\/v1\.0\.0 .*b\/v1\.0\.0/);
  });

  it('refuses a name git rejects before it looks at any tag', async () => {
    const exec = mockExec((cmd) => {
      if (cmd.endsWith('refs/tags/bad name/v1.0.0')) throw exitedWith(1);
    });
    await expect(
      Release.plan(
        repoWith(exec),
        tagsOf(repoWith(exec), ['v1.0.0', 'bad name/v1.0.0']),
        false,
      ),
    ).rejects.toMatchObject({
      code: 'EINVALIDTAG',
      message: expect.stringContaining('bad name/v1.0.0'),
    });
    expect(commandsOf(exec)).toEqual([
      'git check-ref-format refs/tags/v1.0.0',
      'git check-ref-format refs/tags/bad name/v1.0.0',
    ]);
  });

  it('rethrows a failing tag lookup instead of calling the tag missing', async () => {
    const failure = exitedWith(128);
    const run = jest.fn<Runner>(async (_file, args) => {
      if (args.includes('--verify')) throw failure;
      return args[0] === 'rev-parse' ? HEAD : '';
    });
    await expect(
      Release.plan(repoWith(run), tagsOf(repoWith(run), ['v1.0.0']), false),
    ).rejects.toBe(failure);
  });

  describe('against the remote', () => {
    it('refuses a tag that exists on the remote at another commit', async () => {
      const exec = mockExec(() => undefined, {}, { 'sub/v1.0.0': OTHER });
      await expect(
        Release.plan(
          repoWith(exec),
          tagsOf(repoWith(exec), ['v1.0.0', 'sub/v1.0.0']),
          true,
        ),
      ).rejects.toMatchObject({
        code: 'ETAGMISMATCH',
        message: expect.stringContaining(`sub/v1.0.0 on origin (${OTHER})`),
      });
    });

    it('accepts a remote tag at HEAD and an annotated tag peeled to HEAD', async () => {
      const exec = mockExec(
        () => undefined,
        {},
        { 'v1.0.0': HEAD, 'a/v1.0.0': HEAD },
      );
      await expect(
        Release.plan(
          repoWith(exec),
          tagsOf(repoWith(exec), ['v1.0.0', 'a/v1.0.0']),
          true,
        ),
      ).resolves.toBeInstanceOf(Release);
    });

    it('does not contact the remote when the tags are not pushed', async () => {
      const exec = mockExec();
      await Release.plan(
        repoWith(exec),
        tagsOf(repoWith(exec), ['v1.0.0']),
        false,
      );
      expect(commandsOf(exec).some((cmd) => cmd.includes('ls-remote'))).toBe(
        false,
      );
    });

    it('asks the remote once, after the local checks', async () => {
      const exec = mockExec();
      await Release.plan(
        repoWith(exec),
        tagsOf(repoWith(exec), ['v1.0.0', 'a/v1.0.0']),
        true,
      );
      expect(
        commandsOf(exec).filter((cmd) => cmd.includes('ls-remote')),
      ).toEqual(['git ls-remote --tags origin']);
    });

    it('rethrows a failing ls-remote', async () => {
      const run = jest.fn<Runner>(async (_file, args) => {
        if (args.includes('ls-remote')) throw exitedWith(128);
        return args[0] === 'rev-parse' ? HEAD : '';
      });
      await expect(
        Release.plan(repoWith(run), tagsOf(repoWith(run), ['v1.0.0']), true),
      ).rejects.toMatchObject({ status: 128 });
    });
  });
});

describe('Release.publish', () => {
  it('creates and pushes each tag, in order, and returns the tags', async () => {
    const exec = mockExec();
    const { logger, lines } = recordingLogger();
    const release = await Release.plan(
      repoWith(exec),
      tagsOf(repoWith(exec), ['v1.2.3', 'a/v1.2.3']),
      true,
    );
    const tags = await release.publish(logger);
    expect(tags.map((tag) => tag.name)).toEqual(['v1.2.3', 'a/v1.2.3']);
    expect(commandsOf(exec).slice(-4)).toEqual([
      'git tag -- v1.2.3',
      'git push origin refs/tags/v1.2.3',
      'git tag -- a/v1.2.3',
      'git push origin refs/tags/a/v1.2.3',
    ]);
    expect(lines).toEqual([
      'Created tag %s v1.2.3',
      'Pushed tag %s v1.2.3',
      'Created tag %s a/v1.2.3',
      'Pushed tag %s a/v1.2.3',
    ]);
  });

  it('only creates the tags when pushing is off', async () => {
    const exec = mockExec();
    const release = await Release.plan(
      repoWith(exec),
      tagsOf(repoWith(exec), ['v1.2.3']),
      false,
    );
    await release.publish(recordingLogger().logger);
    expect(commandsOf(exec).slice(-1)).toEqual(['git tag -- v1.2.3']);
  });

  it('skips a tag that exists at HEAD and still pushes it', async () => {
    const exec = mockExec(() => undefined, { 'v1.2.3': HEAD });
    const { logger, lines } = recordingLogger();
    const release = await Release.plan(
      repoWith(exec),
      tagsOf(repoWith(exec), ['v1.2.3']),
      true,
    );
    await release.publish(logger);
    expect(lines).toEqual([
      'Tag %s already exists, skipping v1.2.3',
      'Pushed tag %s v1.2.3',
    ]);
    expect(commandsOf(exec).some((cmd) => cmd.startsWith('git tag'))).toBe(
      false,
    );
  });

  it('rethrows a tag error without pushing it', async () => {
    const exec = mockExec((cmd) => {
      if (cmd.startsWith('git tag')) throw new Error('fatal: cannot lock ref');
    });
    const release = await Release.plan(
      repoWith(exec),
      tagsOf(repoWith(exec), ['v1.2.3']),
      true,
    );
    await expect(release.publish(recordingLogger().logger)).rejects.toThrow(
      'cannot lock ref',
    );
    expect(commandsOf(exec).some((cmd) => cmd.startsWith('git push'))).toBe(
      false,
    );
  });

  it('rethrows a rejected push and pushes no further tag', async () => {
    const calls: string[] = [];
    const run = jest.fn<Runner>(async (file, args) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const cmd = [file, ...args].join(' ');
      calls.push(cmd);
      if (cmd === 'git rev-parse HEAD') return HEAD;
      if (cmd.includes('--verify')) throw exitedWith(1);
      if (cmd === 'git push origin refs/tags/a/v1.2.3') {
        throw new Error('remote: rejected');
      }
      return '';
    });
    const repository = repoWith(run);
    const release = await Release.plan(
      repository,
      tagsOf(repository, ['v1.2.3', 'a/v1.2.3', 'b/v1.2.3']),
      true,
    );
    await expect(release.publish(recordingLogger().logger)).rejects.toThrow(
      'remote: rejected',
    );
    expect(calls.slice(-4)).toEqual([
      'git tag -- v1.2.3',
      'git push origin refs/tags/v1.2.3',
      'git tag -- a/v1.2.3',
      'git push origin refs/tags/a/v1.2.3',
    ]);
    expect(
      calls.filter((cmd) => /^git (tag|push)/.test(cmd) && cmd.includes('b/')),
    ).toEqual([]);
  });

  it('skips a tag already on origin at HEAD, creating and pushing nothing for it', async () => {
    const exec = mockExec(() => undefined, {}, { 'a/v1.2.3': HEAD });
    const { logger, lines } = recordingLogger();
    const release = await Release.plan(
      repoWith(exec),
      tagsOf(repoWith(exec), ['v1.2.3', 'a/v1.2.3']),
      true,
    );
    await release.publish(logger);
    expect(lines).toEqual([
      'Created tag %s v1.2.3',
      'Pushed tag %s v1.2.3',
      'Tag %s already on origin, skipping a/v1.2.3',
    ]);
    expect(
      commandsOf(exec).filter((cmd) => /^git (tag|push)/.test(cmd)),
    ).toEqual(['git tag -- v1.2.3', 'git push origin refs/tags/v1.2.3']);
  });

  it('creates a tag that is on origin when the tags are not pushed', async () => {
    const exec = mockExec(() => undefined, {}, { 'a/v1.2.3': HEAD });
    const release = await Release.plan(
      repoWith(exec),
      tagsOf(repoWith(exec), ['a/v1.2.3']),
      false,
    );
    await release.publish(recordingLogger().logger);
    expect(commandsOf(exec).slice(-1)).toEqual(['git tag -- a/v1.2.3']);
  });
});
