import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import plugin, { prepare, publish, verifyConditions } from '../src/index.js';
import { mockExec, stepContext } from './utils/context.js';
import { goMod } from './utils/go-mod.js';
import { withTmp } from './utils/tmpdir.js';

const ROOT = 'github.com/example/repo';

describe('default export', () => {
  it('exposes the three semantic-release steps', () => {
    expect(plugin).toEqual({ verifyConditions, prepare, publish });
  });
});

describe('verifyConditions', () => {
  it('passes when go.mod exists and git is available', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const exec = mockExec();
      await expect(
        verifyConditions({}, stepContext(dir).verify, exec),
      ).resolves.toBeUndefined();
      expect(exec).toHaveBeenCalledWith('git --version', { stdio: 'pipe' });
    });
  });

  it('throws EMISSINGGOMOD when go.mod is absent', async () => {
    await withTmp({}, async (dir) => {
      await expect(
        verifyConditions({}, stepContext(dir).verify, mockExec()),
      ).rejects.toMatchObject({
        code: 'EMISSINGGOMOD',
        message: 'go.mod not found.',
        details: expect.stringContaining(dir),
      });
    });
  });

  it('throws ENOGIT when git is not available', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const exec = mockExec(() => {
        throw new Error('git not found');
      });
      await expect(
        verifyConditions({}, stepContext(dir).verify, exec),
      ).rejects.toMatchObject({
        code: 'ENOGIT',
        message: 'git is not available.',
      });
    });
  });

  it('logs that it is in single-module mode when no submodules exist', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const { verify, logger } = stepContext(dir);
      await verifyConditions({}, verify, mockExec());
      expect(logger.log).toHaveBeenCalledWith(
        'No submodule go.mod files found — operating in single-module mode.',
      );
    });
  });

  it('logs the submodule count when submodules are found', async () => {
    await withTmp(
      { 'go.mod': goMod(ROOT), 'sub/go.mod': goMod(`${ROOT}/sub`) },
      async (dir) => {
        const { verify, logger } = stepContext(dir);
        await verifyConditions({}, verify, mockExec());
        expect(logger.log).toHaveBeenCalledWith('Found %d submodule(s).', 1);
      },
    );
  });

  it('runs the real git when no executor is injected', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      await expect(
        verifyConditions({}, stepContext(dir).verify),
      ).resolves.toBeUndefined();
    });
  });
});

describe('steps without a cwd in the context', () => {
  // The repository this suite runs in has no go.mod at its root.
  const noCwd = stepContext('ignored');

  it.each([
    [
      'verifyConditions',
      () =>
        verifyConditions({}, { ...noCwd.verify, cwd: undefined }, mockExec()),
    ],
    [
      'prepare',
      () => prepare({}, { ...noCwd.prepare, cwd: undefined }, mockExec()),
    ],
  ])('%s looks for go.mod in the process directory', async (_step, run) => {
    await expect(run()).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/go\.mod/),
      }),
    );
  });

  it('publish tags in the process directory', async () => {
    const exec = mockExec();
    await publish({}, { ...noCwd.publish, cwd: undefined }, exec);
    expect(exec).toHaveBeenCalledWith(
      'git tag "v1.2.3"',
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });
});

describe('prepare', () => {
  const files = {
    'go.mod': goMod(ROOT),
    'sub/go.mod': goMod(`${ROOT}/sub`, [`${ROOT} v1.0.0`]),
  };

  it('updates submodule requires to the new version', async () => {
    await withTmp(files, async (dir) => {
      await prepare(
        { skipGoModTidy: true },
        stepContext(dir, '2.0.0').prepare,
        mockExec(),
      );
      expect(await readFile(join(dir, 'sub/go.mod'), 'utf8')).toContain(
        `${ROOT} v2.0.0`,
      );
    });
  });

  it('uses the real executor when none is injected and nothing needs running', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      await expect(
        prepare({ skipGoModTidy: true }, stepContext(dir).prepare),
      ).resolves.toBeUndefined();
    });
  });

  it('runs go mod tidy in each submodule by default', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      const { prepare: ctx, logger } = stepContext(dir, '2.0.0');
      await prepare({}, ctx, exec);
      expect(exec).toHaveBeenCalledWith('go mod tidy', {
        cwd: join(dir, 'sub'),
        stdio: 'pipe',
      });
      expect(logger.log).toHaveBeenCalledWith('go mod tidy OK in %s', 'sub');
      expect(logger.log).toHaveBeenCalledWith(
        'Prepared %d submodule(s) for v%s.',
        1,
        '2.0.0',
      );
    });
  });

  it('skips go mod tidy when skipGoModTidy is true', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      await prepare({ skipGoModTidy: true }, stepContext(dir).prepare, exec);
      expect(exec).not.toHaveBeenCalled();
    });
  });

  it('logs and returns when no submodules exist', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const { prepare: ctx, logger } = stepContext(dir);
      await prepare({}, ctx, mockExec());
      expect(logger.log).toHaveBeenCalledWith('Root module: %s', ROOT);
      expect(logger.log).toHaveBeenCalledWith('No submodules to update.');
    });
  });

  it.each([
    ['a plain string', 'sub/go.mod'],
    ['an array of strings', ['sub/go.mod']],
  ])('accepts modules as %s', async (_name, modules) => {
    await withTmp(files, async (dir) => {
      await prepare(
        { modules, skipGoModTidy: true },
        stepContext(dir, '3.0.0').prepare,
        mockExec(),
      );
      expect(await readFile(join(dir, 'sub/go.mod'), 'utf8')).toContain(
        `${ROOT} v3.0.0`,
      );
    });
  });

  it('warns and continues when go mod tidy fails', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec(() => {
        throw new Error('go: module lookup disabled');
      });
      const { prepare: ctx, logger } = stepContext(dir, '2.0.0');
      await expect(prepare({}, ctx, exec)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'go mod tidy failed in %s: %s',
        'sub',
        'go: module lookup disabled',
      );
    });
  });

  it('fails when the root go.mod has no module declaration', async () => {
    await withTmp({ 'go.mod': 'go 1.21\n' }, async (dir) => {
      await expect(
        prepare({}, stepContext(dir).prepare, mockExec()),
      ).rejects.toThrow(/No module declaration found/);
    });
  });
});

describe('publish', () => {
  it('runs the real git when no executor is injected', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const git = (...args: readonly string[]): string =>
        execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
      git('init', '-q');
      git(
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      );
      await publish({ pushTags: false }, stepContext(dir).publish);
      expect(git('tag', '--list').trim()).toBe('v1.2.3');
    });
  });
});

describe('publish with a mocked executor', () => {
  const files = {
    'go.mod': goMod(ROOT),
    'pkg/foo/go.mod': goMod(`${ROOT}/pkg/foo`),
  };
  const commands = (exec: ReturnType<typeof mockExec>): readonly string[] =>
    exec.mock.calls.map(([cmd]) => cmd);

  it('creates and pushes tags for the root and every submodule', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      const { publish: ctx, logger } = stepContext(dir);
      await publish({}, ctx, exec);
      expect(commands(exec)).toEqual([
        'git rev-parse -q --verify "refs/tags/v1.2.3"',
        'git tag "v1.2.3"',
        'git push origin "refs/tags/v1.2.3"',
        'git rev-parse -q --verify "refs/tags/pkg/foo/v1.2.3"',
        'git tag "pkg/foo/v1.2.3"',
        'git push origin "refs/tags/pkg/foo/v1.2.3"',
      ]);
      expect(logger.log).toHaveBeenCalledWith(
        'Tagged %d module(s) at v%s.',
        2,
        '1.2.3',
      );
    });
  });

  it('does not push tags when pushTags is false', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      await publish({ pushTags: false }, stepContext(dir).publish, exec);
      expect(commands(exec).filter((cmd) => cmd.startsWith('git tag'))).toEqual(
        ['git tag "v1.2.3"', 'git tag "pkg/foo/v1.2.3"'],
      );
      expect(commands(exec).some((cmd) => cmd.includes('push'))).toBe(false);
    });
  });

  it('skips tags that already exist and still pushes', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const exec = mockExec(() => undefined, ['v1.2.3']);
      await expect(
        publish({}, stepContext(dir).publish, exec),
      ).resolves.toBeUndefined();
      expect(commands(exec)).toEqual([
        'git rev-parse -q --verify "refs/tags/v1.2.3"',
        'git push origin "refs/tags/v1.2.3"',
      ]);
    });
  });

  it('rethrows unexpected tag errors', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const exec = mockExec((cmd) => {
        if (cmd.startsWith('git tag'))
          throw new Error('fatal: cannot lock ref');
      });
      await expect(publish({}, stepContext(dir).publish, exec)).rejects.toThrow(
        /cannot lock ref/,
      );
    });
  });
});
