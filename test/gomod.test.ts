import { describe, expect, it } from '@jest/globals';
import { readFile, symlink } from 'node:fs/promises';
import path, { join } from 'node:path';
import {
  createAndPushTag,
  planTags,
  deriveTagPrefix,
  discoverSubmoduleGoMods,
  readModulePath,
  updateGoModRequires,
} from '../src/gomod.js';
import { commandsOf, HEAD, mockExec, mockLogger } from './utils/context.js';
import { goMod } from './utils/go-mod.js';
import { withTmp } from './utils/tmpdir.js';

/**
 * Discover submodules, ignoring what is logged.
 *
 * @param root Repository root.
 * @param patterns Optional glob patterns.
 * @returns The go.mod files found.
 */
const discover = (
  root: string,
  patterns?: readonly string[],
): readonly string[] => discoverSubmoduleGoMods(root, patterns, mockLogger());

describe('discoverSubmoduleGoMods', () => {
  it('returns an empty array when only the root go.mod exists', async () => {
    await withTmp(
      { 'go.mod': goMod('github.com/example/repo') },
      async (dir) => {
        expect(discover(dir)).toEqual([]);
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
        expect(discover(dir)).toEqual([
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
        expect(discover(dir, ['assert/**/go.mod', 'env/**/go.mod'])).toEqual([
          join(dir, 'assert/foo/go.mod'),
          join(dir, 'env/bar/go.mod'),
        ]);
      },
    );
  });

  it.each([['**/go.mod'], ['*/go.mod'], ['go.mod']])(
    'applies the same exclusions to the glob %s as to auto-discovery',
    async (pattern) => {
      await withTmp(
        {
          'go.mod': goMod('github.com/example/repo'),
          'sub/go.mod': goMod('github.com/example/repo/sub'),
          'vendor/p/go.mod': goMod('github.com/example/vendored'),
          'node_modules/p/go.mod': goMod('github.com/example/npm'),
        },
        async (dir) => {
          const found = discover(dir, [pattern]);
          expect(found).not.toContain(join(dir, 'go.mod'));
          expect(found.filter((f) => /vendor|node_modules/.test(f))).toEqual(
            [],
          );
        },
      );
    },
  );

  it.each([[undefined], [['**/go.mod']], [['*/*/go.mod']]])(
    'skips .git but searches other dot-directories (patterns %j)',
    async (patterns) => {
      await withTmp(
        {
          'go.mod': goMod('github.com/example/repo'),
          '.git/modules/x/go.mod': goMod('github.com/example/git'),
          '.tools/y/go.mod': goMod('github.com/example/repo/.tools/y'),
          '.ci/go.mod': goMod('github.com/example/repo/.ci'),
        },
        async (dir) => {
          expect(discover(dir, patterns)).toEqual(
            expect.arrayContaining([join(dir, '.tools/y/go.mod')]),
          );
          expect(discover(dir, patterns)).not.toContain(
            join(dir, '.git/modules/x/go.mod'),
          );
        },
      );
    },
  );

  it('finds the modules in .tools and .ci that auto-discovery always found', async () => {
    await withTmp(
      {
        'go.mod': goMod('github.com/example/repo'),
        '.tools/go.mod': goMod('github.com/example/repo/.tools'),
        '.ci/go.mod': goMod('github.com/example/repo/.ci'),
      },
      async (dir) => {
        expect(discover(dir)).toEqual([
          join(dir, '.ci/go.mod'),
          join(dir, '.tools/go.mod'),
        ]);
      },
    );
  });

  it('logs each ignored directory it does not search, but not .git', async () => {
    await withTmp(
      {
        'go.mod': goMod('github.com/example/repo'),
        'vendor/p/go.mod': goMod('github.com/example/vendored'),
        'sub/node_modules/q/go.mod': goMod('github.com/example/npm'),
        '.git/x': '',
      },
      async (dir) => {
        const logger = mockLogger();
        discoverSubmoduleGoMods(dir, undefined, logger);
        const skipped = logger.log.mock.calls.map(([, path]) => path);
        expect(skipped).toEqual(
          expect.arrayContaining([
            join(dir, 'vendor'),
            join(dir, 'sub/node_modules'),
          ]),
        );
        expect(skipped).not.toContain(join(dir, '.git'));
      },
    );
  });

  it.each([['**/go.mod'], ['*/*/go.mod'], ['*/**/go.mod']])(
    'prunes ignored directories while expanding %s, instead of filtering afterwards',
    async (pattern) => {
      await withTmp(
        {
          'sub/go.mod': goMod('github.com/example/repo/sub'),
          'node_modules/a/b/go.mod': goMod('x'),
          'vendor/a/go.mod': goMod('x'),
        },
        async (dir) => {
          const logger = mockLogger();
          discoverSubmoduleGoMods(dir, [pattern], logger);
          // The directories are reported when the walk reaches them, so
          // their contents are never listed.
          expect(logger.log.mock.calls.map(([, skipped]) => skipped)).toEqual(
            expect.arrayContaining([
              join(dir, 'node_modules'),
              join(dir, 'vendor'),
            ]),
          );
          expect(logger.log.mock.calls.length).toBe(2);
        },
      );
    },
  );

  it('warns about a pattern that matches nothing, and still returns the rest', async () => {
    await withTmp(
      { 'sub/go.mod': goMod('github.com/example/repo/sub') },
      async (dir) => {
        const logger = mockLogger();
        expect(
          discoverSubmoduleGoMods(dir, ['sub/go.mod', 'svc/*/go.mod'], logger),
        ).toEqual([join(dir, 'sub/go.mod')]);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          'Pattern "%s" in `modules` matched no go.mod files.',
          'svc/*/go.mod',
        );
      },
    );
  });

  it('decides what to skip per matched segment, not per pattern', async () => {
    await withTmp(
      {
        'vendor/x/a/go.mod': goMod('github.com/example/a'),
        'vendor/x/node_modules/b/go.mod': goMod('github.com/example/b'),
      },
      async (dir) => {
        expect(discover(dir, ['vendor/x/*/go.mod'])).toEqual([
          join(dir, 'vendor/x/a/go.mod'),
        ]);
      },
    );
  });

  it('ignores a symlinked go.mod in a glob exactly as auto-discovery does', async () => {
    await withTmp(
      { 'a/go.mod': goMod('github.com/example/repo/a'), 'link/keep': '' },
      async (dir) => {
        await symlink(join(dir, 'a/go.mod'), join(dir, 'link/go.mod'));
        expect(discover(dir, ['*/go.mod'])).toEqual([join(dir, 'a/go.mod')]);
        expect(discover(dir)).toEqual([join(dir, 'a/go.mod')]);
      },
    );
  });

  it('honours a literal path into vendor or node_modules', async () => {
    await withTmp(
      {
        'go.mod': goMod('github.com/example/repo'),
        'vendor/x/go.mod': goMod('github.com/example/x'),
        'node_modules/y/go.mod': goMod('github.com/example/y'),
      },
      async (dir) => {
        expect(
          discover(dir, ['vendor/x/go.mod', 'node_modules/y/go.mod', 'go.mod']),
        ).toEqual([
          join(dir, 'node_modules/y/go.mod'),
          join(dir, 'vendor/x/go.mod'),
        ]);
      },
    );
  });

  it('finds only the submodule for **/go.mod', async () => {
    await withTmp(
      {
        'go.mod': goMod('github.com/example/repo'),
        'sub/go.mod': goMod('github.com/example/repo/sub'),
        'vendor/p/go.mod': goMod('github.com/example/vendored'),
      },
      async (dir) => {
        expect(discover(dir, ['**/go.mod'])).toEqual([join(dir, 'sub/go.mod')]);
      },
    );
  });

  it('lists a file matched by several patterns once', async () => {
    await withTmp(
      { 'pkg/a/go.mod': goMod('github.com/example/repo/pkg/a') },
      async (dir) => {
        expect(discover(dir, ['pkg/*/go.mod', 'pkg/**/go.mod'])).toEqual([
          join(dir, 'pkg/a/go.mod'),
        ]);
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
        expect(discover(dir)).toEqual([]);
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
        expect(discover(dir, ['pkg/*/go.mod'])).toEqual([
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
        expect(discover(dir, ['sub/go.mod', 'missing/go.mod'])).toEqual([
          join(dir, 'sub/go.mod'),
        ]);
      },
    );
  });

  it('ignores a glob that matches a directory instead of a file', async () => {
    await withTmp({ 'sub/go.mod/keep': '' }, async (dir) => {
      expect(discover(dir, ['sub/go.mod'])).toEqual([]);
    });
  });

  it('ignores a symlink named go.mod, which is not a regular file', async () => {
    await withTmp(
      { 'real/go.mod': goMod('github.com/example/repo/real'), 'sub/keep': '' },
      async (dir) => {
        await symlink(join(dir, 'real/go.mod'), join(dir, 'sub/go.mod'));
        expect(discover(dir)).toEqual([join(dir, 'real/go.mod')]);
      },
    );
  });

  it('matches nothing for a pattern that ends in **', async () => {
    await withTmp(
      { 'sub/go.mod': goMod('github.com/example/repo/sub') },
      async (dir) => {
        expect(discover(dir, ['sub/**'])).toEqual([]);
      },
    );
  });

  it('returns nothing for a root that cannot be read', () => {
    expect(discover('/nonexistent-gomod-root')).toEqual([]);
  });

  it('falls back to auto-discovery for an empty pattern list', async () => {
    await withTmp(
      { 'sub/go.mod': goMod('github.com/example/repo/sub') },
      async (dir) => {
        expect(discover(dir, [])).toEqual([join(dir, 'sub/go.mod')]);
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

  it.each([
    ['a quoted path', 'module "github.com/example/q"\n'],
    ['a raw-quoted path', 'module `github.com/example/q`\n'],
    ['a byte order mark', '\uFEFFmodule github.com/example/q\n'],
    ['CRLF line endings', 'module github.com/example/q\r\ngo 1.21\r\n'],
    ['a trailing comment', 'module github.com/example/q // the module\n'],
  ])('reads a module declaration with %s', async (_name, content) => {
    await withTmp({ 'go.mod': content }, async (dir) => {
      expect(readModulePath(join(dir, 'go.mod'))).toBe('github.com/example/q');
    });
  });

  it.each([
    ['a grouped declaration', 'module (\n\t"github.com/example/q"\n)\n'],
    ['an empty declaration', 'module\n'],
  ])('throws for %s, which it cannot read', async (_name, content) => {
    await withTmp({ 'go.mod': content }, async (dir) => {
      expect(() => readModulePath(join(dir, 'go.mod'))).toThrow(
        /No module declaration found/,
      );
    });
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

  it('changes only the version and keeps every other byte of the file', async () => {
    const before = [
      '\uFEFF// header comment',
      'module   github.com/example/sub',
      '',
      'go 1.21',
      'toolchain go1.22.1',
      'godebug default=go1.21',
      '',
      'require (',
      '\tgithub.com/example/repo\t\tv1.0.0 // indirect',
      '\tgithub.com/other/lib v3.0.0',
      '\t// a comment inside the block',
      ')',
      '',
      'replace github.com/other/lib => ../lib',
      'unknown-directive some value',
      '',
    ].join('\r\n');
    await withTmp({ 'go.mod': before }, async (dir) => {
      updateGoModRequires(
        join(dir, 'go.mod'),
        'github.com/example/repo',
        '2.0.0',
      );
      expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe(
        before.replace('repo\t\tv1.0.0', 'repo\t\tv2.0.0'),
      );
    });
  });

  it.each([
    ['plain', 'require (', '\n'],
    ['no space', 'require(', '\n'],
    ['a trailing space', 'require ( ', '\n'],
    ['a trailing comment', 'require ( // direct deps', '\n'],
    ['CRLF', 'require (', '\r\n'],
    ['a trailing comment and CRLF', 'require ( // c', '\r\n'],
  ])('pins a require block opened with %s', async (_name, opener, eol) => {
    const file = (version: string): string =>
      [
        'module x',
        '',
        opener,
        `\tgithub.com/example/repo ${version}`,
        '\tgithub.com/other/lib v3.0.0',
        ')',
        '',
      ].join(eol);
    await withTmp({ 'go.mod': file('v1.0.0') }, async (dir) => {
      updateGoModRequires(
        join(dir, 'go.mod'),
        'github.com/example/repo',
        '2.0.0',
      );
      expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe(file('v2.0.0'));
    });
  });

  it('pins every require block and a single-line require in the same file', async () => {
    const file = (v: string): string =>
      [
        'module x',
        `require github.com/example/repo ${v}`,
        'require (',
        `\tgithub.com/example/repo/a ${v}`,
        ')',
        'require ( // second',
        `\tgithub.com/example/repo/b ${v} // indirect`,
        ')',
        '',
      ].join('\n');
    await withTmp({ 'go.mod': file('v1.0.0') }, async (dir) => {
      updateGoModRequires(
        join(dir, 'go.mod'),
        'github.com/example/repo',
        '2.0.0',
      );
      expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe(file('v2.0.0'));
    });
  });

  it.each([
    ['a pseudo-version', 'v0.0.0-20240101120000-abcdef123456'],
    ['an incompatible version', 'v2.0.0+incompatible'],
    ['a pre-release', 'v1.0.0-rc.1'],
  ])('replaces %s', async (_name, version) => {
    expect(await update([`github.com/example/repo ${version}`])).toContain(
      'github.com/example/repo v2.0.0',
    );
  });

  it.each([
    ['a major-version module', 'github.com/example/repo/v2 v2.3.0'],
    ['a major-version sub-package', 'github.com/example/repo/v10/sub v10.0.1'],
  ])(
    'does not rewrite %s, which is a different module',
    async (_name, line) => {
      expect(await update([line])).toContain(line);
    },
  );

  it('still pins a sub-path that merely starts with v', async () => {
    expect(await update(['github.com/example/repo/vendor-x v1.0.0'])).toContain(
      'github.com/example/repo/vendor-x v2.0.0',
    );
  });

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

  it('uses forward slashes whatever the platform separator', () => {
    expect(
      deriveTagPrefix('C:\\repo\\assert\\cert\\go.mod', 'C:\\repo', path.win32),
    ).toBe('assert/cert');
  });

  it('returns the relative directory for submodules', () => {
    expect(
      deriveTagPrefix(join('/repo', 'assert/cert/manager', 'go.mod'), '/repo'),
    ).toBe('assert/cert/manager');
  });
});

describe('planTags', () => {
  const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

  it('marks tags by whether they already exist at HEAD', () => {
    const exec = mockExec(() => undefined, { 'a/v1.0.0': HEAD });
    expect(planTags('/repo', ['a/v1.0.0', 'b/v1.0.0'], exec)).toEqual([
      { tag: 'a/v1.0.0', exists: true },
      { tag: 'b/v1.0.0', exists: false },
    ]);
  });

  it('checks the names, then HEAD, then each tag, and creates nothing', () => {
    const exec = mockExec();
    planTags('/repo', ['v1.0.0', 'a/v1.0.0'], exec);
    expect(commandsOf(exec)).toEqual([
      'git check-ref-format refs/tags/v1.0.0',
      'git check-ref-format refs/tags/a/v1.0.0',
      'git rev-parse HEAD',
      'git rev-parse -q --verify refs/tags/v1.0.0^{commit}',
      'git rev-parse -q --verify refs/tags/a/v1.0.0^{commit}',
    ]);
  });

  it('refuses a tag that exists at another commit than HEAD', () => {
    const exec = mockExec(() => undefined, { 'a/v1.0.0': OTHER });
    expect(() => planTags('/repo', ['v1.0.0', 'a/v1.0.0'], exec)).toThrow(
      expect.objectContaining({
        code: 'ETAGMISMATCH',
        message: expect.stringContaining(`a/v1.0.0 (${OTHER})`),
      }),
    );
  });

  it('lists every stale tag in one error', () => {
    const exec = mockExec(() => undefined, {
      'a/v1.0.0': OTHER,
      'b/v1.0.0': OTHER,
    });
    expect(() => planTags('/repo', ['a/v1.0.0', 'b/v1.0.0'], exec)).toThrow(
      /a\/v1\.0\.0 .*b\/v1\.0\.0/,
    );
  });

  it('refuses a name git rejects before it looks at any tag', () => {
    const exec = mockExec((cmd) => {
      if (cmd.endsWith('refs/tags/bad name/v1.0.0')) throw new Error('invalid');
    });
    expect(() =>
      planTags('/repo', ['v1.0.0', 'bad name/v1.0.0'], exec),
    ).toThrow(
      expect.objectContaining({
        code: 'EINVALIDTAG',
        message: expect.stringContaining('bad name/v1.0.0'),
      }),
    );
    expect(commandsOf(exec).some((cmd) => cmd.includes('--verify'))).toBe(
      false,
    );
  });

  it('refuses a tag starting with a dash without asking git', () => {
    const exec = mockExec();
    expect(() => planTags('/repo', ['-dash/v1.0.0'], exec)).toThrow(
      expect.objectContaining({ code: 'EINVALIDTAG' }),
    );
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('createAndPushTag', () => {
  const options = { cwd: '/repo', stdio: 'pipe' };
  const missing = { tag: 'v1.2.3', exists: false };

  it('creates and pushes the tag', () => {
    const exec = mockExec();
    const logger = mockLogger();
    createAndPushTag('/repo', missing, true, logger, exec);
    expect(exec.mock.calls).toEqual([
      ['git', ['tag', '--', 'v1.2.3'], options],
      ['git', ['push', 'origin', 'refs/tags/v1.2.3'], options],
    ]);
    expect(logger.log).toHaveBeenCalledWith('Created tag %s', 'v1.2.3');
    expect(logger.log).toHaveBeenCalledWith('Pushed tag %s', 'v1.2.3');
  });

  it.each([
    ['a semicolon', 'a;b/v1.0.0'],
    ['a command substitution', '$(id)/v1.0.0'],
    ['quotes and backticks', '"a\'`b/v1.0.0'],
    ['spaces', 'a b/v1.0.0'],
  ])('passes a tag with %s as one argument', (_name, tag) => {
    const exec = mockExec();
    createAndPushTag('/repo', { tag, exists: false }, true, mockLogger(), exec);
    expect(exec.mock.calls.map(([file, args]) => [file, ...args])).toEqual([
      ['git', 'tag', '--', tag],
      ['git', 'push', 'origin', `refs/tags/${tag}`],
    ]);
  });

  it('only creates the tag when push is off', () => {
    const exec = mockExec();
    createAndPushTag('/repo', missing, false, mockLogger(), exec);
    expect(commandsOf(exec)).toEqual(['git tag -- v1.2.3']);
  });

  it('skips a tag that exists at HEAD and still pushes', () => {
    const exec = mockExec();
    const logger = mockLogger();
    createAndPushTag(
      '/repo',
      { tag: 'v1.2.3', exists: true },
      true,
      logger,
      exec,
    );
    expect(logger.log).toHaveBeenCalledWith(
      'Tag %s already exists, skipping',
      'v1.2.3',
    );
    expect(commandsOf(exec)).toEqual(['git push origin refs/tags/v1.2.3']);
  });

  it('rethrows tag errors without pushing', () => {
    const exec = mockExec((cmd) => {
      if (cmd.startsWith('git tag')) throw new Error('fatal: cannot lock ref');
    });
    expect(() =>
      createAndPushTag('/repo', missing, true, mockLogger(), exec),
    ).toThrow('cannot lock ref');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
