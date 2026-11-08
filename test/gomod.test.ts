import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAndPushTag,
  deriveTagPrefix,
  discoverSubmoduleGoMods,
  readModulePath,
  updateGoModRequires,
} from '../src/gomod.js';
import { mockExec, mockLogger } from './utils/context.js';
import { goMod } from './utils/go-mod.js';
import { withTmp } from './utils/tmpdir.js';

describe('discoverSubmoduleGoMods', () => {
  it('returns an empty array when only the root go.mod exists', async () => {
    await withTmp(
      { 'go.mod': goMod('github.com/example/repo') },
      async (dir) => {
        expect(discoverSubmoduleGoMods(dir)).toEqual([]);
      },
    );
  });

  it('auto-detects submodule go.mod files, sorted', async () => {
    await withTmp(
      {
        'go.mod': goMod('github.com/example/repo'),
        'pkg/b/go.mod': goMod('github.com/example/repo/pkg/b'),
        'pkg/a/go.mod': goMod('github.com/example/repo/pkg/a'),
      },
      async (dir) => {
        expect(discoverSubmoduleGoMods(dir)).toEqual([
          join(dir, 'pkg/a/go.mod'),
          join(dir, 'pkg/b/go.mod'),
        ]);
      },
    );
  });

  it('respects glob patterns when provided', async () => {
    await withTmp(
      {
        'go.mod': goMod('github.com/example/repo'),
        'assert/foo/go.mod': goMod('github.com/example/repo/assert/foo'),
        'env/bar/go.mod': goMod('github.com/example/repo/env/bar'),
        'other/baz/go.mod': goMod('github.com/example/repo/other/baz'),
      },
      async (dir) => {
        expect(
          discoverSubmoduleGoMods(dir, ['assert/**/go.mod', 'env/**/go.mod']),
        ).toEqual([
          join(dir, 'assert/foo/go.mod'),
          join(dir, 'env/bar/go.mod'),
        ]);
      },
    );
  });

  it('lists a file matched by several patterns once', async () => {
    await withTmp(
      { 'pkg/a/go.mod': goMod('github.com/example/repo/pkg/a') },
      async (dir) => {
        expect(
          discoverSubmoduleGoMods(dir, ['pkg/*/go.mod', 'pkg/**/go.mod']),
        ).toEqual([join(dir, 'pkg/a/go.mod')]);
      },
    );
  });

  it('skips vendor and node_modules directories', async () => {
    await withTmp(
      {
        'go.mod': goMod('github.com/example/repo'),
        'vendor/pkg/go.mod': goMod('github.com/example/vendored'),
        'node_modules/pkg/go.mod': goMod('github.com/example/npm'),
      },
      async (dir) => {
        expect(discoverSubmoduleGoMods(dir)).toEqual([]);
      },
    );
  });

  it('supports a single-level * wildcard in glob patterns', async () => {
    await withTmp(
      {
        'pkg/a/go.mod': goMod('github.com/example/repo/pkg/a'),
        'pkg/b/go.mod': goMod('github.com/example/repo/pkg/b'),
        'pkg/b/deep/go.mod': goMod('github.com/example/repo/pkg/b/deep'),
      },
      async (dir) => {
        expect(discoverSubmoduleGoMods(dir, ['pkg/*/go.mod'])).toEqual([
          join(dir, 'pkg/a/go.mod'),
          join(dir, 'pkg/b/go.mod'),
        ]);
      },
    );
  });

  it('matches a literal path, and ignores one that does not exist', async () => {
    await withTmp(
      { 'sub/go.mod': goMod('github.com/example/repo/sub') },
      async (dir) => {
        expect(
          discoverSubmoduleGoMods(dir, ['sub/go.mod', 'missing/go.mod']),
        ).toEqual([join(dir, 'sub/go.mod')]);
      },
    );
  });

  it('ignores a glob that matches a directory instead of a file', async () => {
    await withTmp({ 'sub/go.mod/keep': '' }, async (dir) => {
      expect(discoverSubmoduleGoMods(dir, ['sub/go.mod'])).toEqual([]);
    });
  });

  it('returns nothing for a root that cannot be read', () => {
    expect(discoverSubmoduleGoMods('/nonexistent-gomod-root')).toEqual([]);
  });

  it('falls back to auto-discovery for an empty pattern list', async () => {
    await withTmp(
      { 'sub/go.mod': goMod('github.com/example/repo/sub') },
      async (dir) => {
        expect(discoverSubmoduleGoMods(dir, [])).toEqual([
          join(dir, 'sub/go.mod'),
        ]);
      },
    );
  });
});

describe('readModulePath', () => {
  it('extracts the module path from a go.mod file', async () => {
    await withTmp(
      { 'go.mod': goMod('github.com/example/repo') },
      async (dir) => {
        expect(readModulePath(join(dir, 'go.mod'))).toBe(
          'github.com/example/repo',
        );
      },
    );
  });

  it('throws if no module line is present', async () => {
    await withTmp({ 'go.mod': 'go 1.21\n' }, async (dir) => {
      expect(() => readModulePath(join(dir, 'go.mod'))).toThrow(
        /No module declaration found in .*go\.mod/,
      );
    });
  });
});

describe('updateGoModRequires', () => {
  const update = async (
    requires: readonly string[],
    version = '2.0.0',
  ): Promise<string> =>
    withTmp(
      { 'go.mod': goMod('github.com/example/sub', requires) },
      async (dir) => {
        updateGoModRequires(
          join(dir, 'go.mod'),
          'github.com/example/repo',
          version,
        );
        return readFile(join(dir, 'go.mod'), 'utf8');
      },
    );

  it('replaces the version of a direct require', async () => {
    const content = await update(['github.com/example/repo v1.0.0']);
    expect(content).toContain('github.com/example/repo v2.0.0');
    expect(content).not.toContain('v1.0.0');
  });

  it('preserves // indirect comments', async () => {
    expect(
      await update(['github.com/example/repo v1.0.0 // indirect']),
    ).toContain('github.com/example/repo v2.0.0 // indirect');
  });

  it('updates sub-path requires of the root module', async () => {
    expect(await update(['github.com/example/repo/pkg/foo v1.0.0'])).toContain(
      'github.com/example/repo/pkg/foo v2.0.0',
    );
  });

  it('does not modify unrelated requires', async () => {
    expect(await update(['github.com/other/lib v3.0.0'])).toContain(
      'github.com/other/lib v3.0.0',
    );
  });

  it('is a no-op when there is nothing to update', async () => {
    expect(await update([])).toBe(goMod('github.com/example/sub'));
  });

  it.each([
    ['a longer module name', 'github.com/example/repository v1.0.0'],
    ['a hyphenated sibling', 'github.com/example/repo-x v1.2.0'],
    ['a dotted sibling', 'github.com/example/repo.v2 v1.2.0'],
  ])(
    'does not touch %s that merely starts with the root path',
    async (_name, line) => {
      expect(await update([line])).toContain(line);
    },
  );

  it('pins a single-line require', async () => {
    await withTmp(
      {
        'go.mod':
          'module x\n\nrequire github.com/example/repo v1.0.0 // indirect\n',
      },
      async (dir) => {
        updateGoModRequires(
          join(dir, 'go.mod'),
          'github.com/example/repo',
          '2.0.0',
        );
        expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe(
          'module x\n\nrequire github.com/example/repo v2.0.0 // indirect\n',
        );
      },
    );
  });

  it.each([
    ['replace', 'replace github.com/example/repo v1.0.0 => ../repo'],
    ['exclude', 'exclude github.com/example/repo v1.0.0'],
    [
      'replace block',
      'replace (\n\tgithub.com/example/repo v1.0.0 => ../repo\n)',
    ],
    ['retract', 'retract v1.0.0'],
  ])('leaves %s directives alone', async (_name, directive) => {
    const content = `module x\n\n${directive}\n`;
    await withTmp({ 'go.mod': content }, async (dir) => {
      updateGoModRequires(
        join(dir, 'go.mod'),
        'github.com/example/repo',
        '2.0.0',
      );
      expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe(content);
    });
  });

  it('treats regex characters in the module path literally', async () => {
    await withTmp(
      { 'go.mod': goMod('x', ['github.com/aXb/repo v1.0.0']) },
      async (dir) => {
        updateGoModRequires(
          join(dir, 'go.mod'),
          'github.com/a.b/repo',
          '2.0.0',
        );
        expect(await readFile(join(dir, 'go.mod'), 'utf8')).toContain(
          'github.com/aXb/repo v1.0.0',
        );
      },
    );
  });
});

describe('deriveTagPrefix', () => {
  it('returns an empty string for the root go.mod', () => {
    expect(deriveTagPrefix(join('/repo', 'go.mod'), '/repo')).toBe('');
  });

  it('returns the relative directory for submodules', () => {
    expect(
      deriveTagPrefix(join('/repo', 'assert/cert/manager', 'go.mod'), '/repo'),
    ).toBe('assert/cert/manager');
  });
});

describe('createAndPushTag', () => {
  it('creates and pushes the tag', () => {
    const exec = mockExec();
    const logger = mockLogger();
    createAndPushTag('/repo', 'v1.2.3', true, logger, exec);
    expect(exec.mock.calls).toEqual([
      ['git tag "v1.2.3"', { cwd: '/repo', stdio: 'pipe' }],
      ['git push origin "refs/tags/v1.2.3"', { cwd: '/repo', stdio: 'pipe' }],
    ]);
    expect(logger.log).toHaveBeenCalledWith('Created tag %s', 'v1.2.3');
    expect(logger.log).toHaveBeenCalledWith('Pushed tag %s', 'v1.2.3');
  });

  it('only creates the tag when push is off', () => {
    const exec = mockExec();
    createAndPushTag('/repo', 'v1.2.3', false, mockLogger(), exec);
    expect(exec.mock.calls.map(([cmd]) => cmd)).toEqual(['git tag "v1.2.3"']);
  });

  it('logs and still pushes when the tag already exists', () => {
    const exec = mockExec((cmd) => {
      if (cmd.startsWith('git tag')) throw new Error('tag already exists');
    });
    const logger = mockLogger();
    createAndPushTag('/repo', 'v1.2.3', true, logger, exec);
    expect(logger.log).toHaveBeenCalledWith(
      'Tag %s already exists, skipping',
      'v1.2.3',
    );
    expect(exec).toHaveBeenCalledWith(
      'git push origin "refs/tags/v1.2.3"',
      expect.anything(),
    );
  });

  it('rethrows other tag errors without pushing', () => {
    const exec = mockExec((cmd) => {
      if (cmd.startsWith('git tag')) throw new Error('cannot lock ref');
    });
    expect(() =>
      createAndPushTag('/repo', 'v1.2.3', true, mockLogger(), exec),
    ).toThrow('cannot lock ref');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
