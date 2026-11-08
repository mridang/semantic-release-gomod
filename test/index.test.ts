import { describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import plugin, { prepare, publish, verifyConditions } from '../src/index.js';
import {
  commandsOf,
  exitedWith,
  HEAD,
  mockExec,
  rawConfig,
  stepContext,
} from './utils/context.js';
import { goMod } from './utils/go-mod.js';
import { initBare, initRepo } from './utils/repo.js';
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
      expect(exec).toHaveBeenCalledWith('git', ['--version'], {
        stdio: 'pipe',
      });
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
      const { verify, lines } = stepContext(dir);
      await verifyConditions({}, verify, mockExec());
      expect(lines).toContain(
        'No submodule go.mod files found — operating in single-module mode.',
      );
    });
  });

  it('logs the submodule count when submodules are found', async () => {
    await withTmp(
      { 'go.mod': goMod(ROOT), 'sub/go.mod': goMod(`${ROOT}/sub`) },
      async (dir) => {
        const { verify, lines } = stepContext(dir);
        await verifyConditions({}, verify, mockExec());
        expect(lines).toContain('Found %d submodule(s). 1');
      },
    );
  });

  it('fails with EINVALIDMODULES for a modules option of the wrong type', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      await expect(
        verifyConditions(
          rawConfig({ modules: 5 }),
          stepContext(dir).verify,
          mockExec(),
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDMODULES' });
    });
  });

  it('runs the real git when no executor is injected', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      await expect(
        verifyConditions({}, stepContext(dir).verify),
      ).resolves.toBeUndefined();
    });
  });
});

describe('a directory name git cannot tag', () => {
  const files = {
    'go.mod': goMod(ROOT),
    'bad dir/go.mod': goMod(`${ROOT}/bad`),
  };
  const refuse = (cmd: string): void => {
    if (cmd.includes('bad dir')) throw exitedWith(1);
  };

  it('stops verifyConditions, before any release commit exists', async () => {
    await withTmp(files, async (dir) => {
      await expect(
        verifyConditions({}, stepContext(dir).verify, mockExec(refuse)),
      ).rejects.toMatchObject({ code: 'EINVALIDTAG' });
    });
  });

  it('stops prepare before any go.mod is rewritten or tidied', async () => {
    await withTmp(
      { ...files, 'ok/go.mod': goMod(`${ROOT}/ok`, [`${ROOT} v1.0.0`]) },
      async (dir) => {
        const exec = mockExec(refuse);
        await expect(
          prepare({}, stepContext(dir, '2.0.0').prepare, exec),
        ).rejects.toMatchObject({ code: 'EINVALIDTAG' });
        expect(await readFile(join(dir, 'ok/go.mod'), 'utf8')).toContain(
          `${ROOT} v1.0.0`,
        );
        expect(commandsOf(exec).some((cmd) => cmd.startsWith('go '))).toBe(
          false,
        );
      },
    );
  });

  it('checks the names with a placeholder version in verifyConditions', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      await verifyConditions({}, stepContext(dir).verify, exec);
      expect(commandsOf(exec)).toEqual(
        expect.arrayContaining([
          'git check-ref-format refs/tags/v0.0.0',
          'git check-ref-format refs/tags/bad dir/v0.0.0',
        ]),
      );
    });
  });

  it('stops prepare when a tag exists at another commit', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const exec = mockExec(() => undefined, { 'v2.0.0': 'f'.repeat(40) });
      await expect(
        prepare({}, stepContext(dir, '2.0.0').prepare, exec),
      ).rejects.toMatchObject({ code: 'ETAGMISMATCH' });
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
      'git',
      ['tag', '--', 'v1.2.3'],
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
      initRepo(dir);
      await expect(
        prepare(
          { skipGoModTidy: true, pushTags: false },
          stepContext(dir).prepare,
        ),
      ).resolves.toBeUndefined();
    });
  });

  it('runs go mod tidy in each submodule by default', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      const { prepare: ctx, lines } = stepContext(dir, '2.0.0');
      await prepare({}, ctx, exec);
      expect(exec).toHaveBeenCalledWith('go', ['mod', 'tidy'], {
        cwd: join(dir, 'sub'),
        stdio: 'pipe',
      });
      expect(lines).toContain('go mod tidy OK in %s sub');
      expect(lines).toContain('Prepared %d submodule(s) for v%s. 1 2.0.0');
    });
  });

  it('skips go mod tidy when skipGoModTidy is true', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      await prepare({ skipGoModTidy: true }, stepContext(dir).prepare, exec);
      expect(commandsOf(exec).some((cmd) => cmd.startsWith('go '))).toBe(false);
    });
  });

  it('logs and returns when no submodules exist', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const { prepare: ctx, lines } = stepContext(dir);
      await prepare({}, ctx, mockExec());
      expect(lines).toContain(`Root module: %s ${ROOT}`);
      expect(lines).toContain('No submodules to update.');
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
      const exec = mockExec((cmd) => {
        if (cmd.startsWith('go '))
          throw new Error('go: module lookup disabled');
      });
      const { prepare: ctx, lines } = stepContext(dir, '2.0.0');
      await expect(prepare({}, ctx, exec)).resolves.toBeUndefined();
      expect(lines).toContain(
        'go mod tidy failed in %s: %s sub go: module lookup disabled',
      );
    });
  });

  it('redacts credentials in URLs from the go mod tidy warning', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec((cmd) => {
        if (cmd.startsWith('go '))
          throw new Error('go: https://user:s3cret@proxy.example.com/x failed');
      });
      const { prepare: ctx, lines } = stepContext(dir, '2.0.0');
      await prepare({}, ctx, exec);
      expect(lines).toContain(
        'go mod tidy failed in %s: %s sub go: https://***@proxy.example.com/x failed',
      );
      expect(lines.join('\n')).not.toContain('s3cret');
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
      const git = initRepo(dir);
      await publish({ pushTags: false }, stepContext(dir).publish);
      expect(git('tag', '--list').trim()).toBe('v1.2.3');
    });
  });
});

describe('publish with hostile directory names', () => {
  it.each([
    ['a command substitution', '$(touch${IFS}INJECTED)'],
    ['backticks', '`touch${IFS}INJECTED`'],
    ['quotes and a semicolon', 'a";touch${IFS}INJECTED;"b\'c'],
  ])(
    'tags a directory named with %s without running a shell',
    async (_name, name) => {
      await withTmp(
        { 'go.mod': goMod(ROOT), [`${name}/go.mod`]: goMod(`${ROOT}/x`) },
        async (dir) => {
          const git = initRepo(dir);
          await publish({ pushTags: false }, stepContext(dir).publish);
          expect(git('tag', '--list').split('\n')).toContain(`${name}/v1.2.3`);
          expect(existsSync(join(dir, 'INJECTED'))).toBe(false);
        },
      );
    },
  );
});

describe('publish in a real repository', () => {
  it('refuses a tag left at an older commit and creates no other tag', async () => {
    await withTmp(
      { 'go.mod': goMod(ROOT), 'sub/go.mod': goMod(`${ROOT}/sub`) },
      async (dir) => {
        const git = initRepo(dir);
        git('tag', 'sub/v1.2.3');
        git('commit', '-q', '--allow-empty', '-m', 'two');
        await expect(
          publish({ pushTags: false }, stepContext(dir).publish),
        ).rejects.toMatchObject({ code: 'ETAGMISMATCH' });
        expect(git('tag', '--list').trim()).toBe('sub/v1.2.3');
      },
    );
  });

  it('refuses a tag that exists only on the remote at another commit, before pushing any', async () => {
    await withTmp({}, async (remote) => {
      await withTmp(
        { 'go.mod': goMod(ROOT), 'sub/go.mod': goMod(`${ROOT}/sub`) },
        async (dir) => {
          const git = initRepo(dir);
          initBare(remote);
          git('remote', 'add', 'origin', remote);
          git('tag', 'sub/v1.2.3');
          git('push', '-q', 'origin', 'refs/tags/sub/v1.2.3');
          git('tag', '-d', 'sub/v1.2.3');
          git('commit', '-q', '--allow-empty', '-m', 'two');
          await expect(
            publish({}, stepContext(dir).publish),
          ).rejects.toMatchObject({
            code: 'ETAGMISMATCH',
          });
          expect(git('ls-remote', '--tags', 'origin')).not.toContain(
            'refs/tags/v1.2.3',
          );
          expect(git('tag', '--list').trim()).toBe('');
        },
      );
    });
  });

  it('treats an annotated tag at HEAD as already created', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const git = initRepo(dir);
      git('tag', '-a', 'v1.2.3', '-m', 'release');
      await expect(
        publish({ pushTags: false }, stepContext(dir).publish),
      ).resolves.toBeUndefined();
    });
  });

  it.each([
    ['a leading dash', '-dash'],
    ['a space', 'a b'],
  ])('creates no tag at all when a directory has %s', async (_name, name) => {
    await withTmp(
      { 'go.mod': goMod(ROOT), [`${name}/go.mod`]: goMod(`${ROOT}/x`) },
      async (dir) => {
        const git = initRepo(dir);
        await expect(
          publish({ pushTags: false }, stepContext(dir).publish),
        ).rejects.toMatchObject({ code: 'EINVALIDTAG' });
        expect(git('tag', '--list').trim()).toBe('');
      },
    );
  });
});

describe('publish with a mocked executor', () => {
  const files = {
    'go.mod': goMod(ROOT),
    'pkg/foo/go.mod': goMod(`${ROOT}/pkg/foo`),
  };
  const commands = (exec: ReturnType<typeof mockExec>): readonly string[] =>
    commandsOf(exec);

  const checks = [
    'git check-ref-format refs/tags/v1.2.3',
    'git check-ref-format refs/tags/pkg/foo/v1.2.3',
    'git rev-parse HEAD',
    'git ls-remote --tags origin',
    'git rev-parse -q --verify refs/tags/v1.2.3^{commit}',
    'git rev-parse -q --verify refs/tags/pkg/foo/v1.2.3^{commit}',
  ];

  it('validates every tag first, then creates and pushes each', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      const { publish: ctx, lines } = stepContext(dir);
      await publish({}, ctx, exec);
      expect(commands(exec)).toEqual([
        ...checks,
        'git tag -- v1.2.3',
        'git push origin refs/tags/v1.2.3',
        'git tag -- pkg/foo/v1.2.3',
        'git push origin refs/tags/pkg/foo/v1.2.3',
      ]);
      expect(lines).toContain('Tagged %d module(s) at v%s. 2 1.2.3');
    });
  });

  it('does not push tags when pushTags is false', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec();
      await publish({ pushTags: false }, stepContext(dir).publish, exec);
      expect(commands(exec).slice(checks.length - 1)).toEqual([
        'git tag -- v1.2.3',
        'git tag -- pkg/foo/v1.2.3',
      ]);
    });
  });

  it('skips tags that already exist at HEAD and still pushes', async () => {
    await withTmp({ 'go.mod': goMod(ROOT) }, async (dir) => {
      const exec = mockExec(() => undefined, { 'v1.2.3': HEAD });
      await expect(
        publish({}, stepContext(dir).publish, exec),
      ).resolves.toBeUndefined();
      expect(commands(exec).slice(-1)).toEqual([
        'git push origin refs/tags/v1.2.3',
      ]);
      expect(commands(exec).some((cmd) => cmd.startsWith('git tag'))).toBe(
        false,
      );
    });
  });

  it('pushes nothing when any tag exists at another commit', async () => {
    await withTmp(files, async (dir) => {
      const exec = mockExec(() => undefined, {
        'pkg/foo/v1.2.3': 'f'.repeat(40),
      });
      await expect(
        publish({}, stepContext(dir).publish, exec),
      ).rejects.toMatchObject({ code: 'ETAGMISMATCH' });
      expect(
        commands(exec).filter((cmd) => /^git (tag|push)/.test(cmd)),
      ).toEqual([]);
    });
  });

  it('pushes nothing when a tag name is invalid', async () => {
    await withTmp(
      { 'go.mod': goMod(ROOT), '-dash/go.mod': goMod(`${ROOT}/dash`) },
      async (dir) => {
        const exec = mockExec();
        await expect(
          publish({}, stepContext(dir).publish, exec),
        ).rejects.toMatchObject({ code: 'EINVALIDTAG' });
        expect(
          commands(exec).filter((cmd) => /^git (tag|push)/.test(cmd)),
        ).toEqual([]);
      },
    );
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
