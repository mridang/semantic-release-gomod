import { describe, expect, it, jest } from '@jest/globals';
import { readFile, symlink } from 'node:fs/promises';
import path, { join } from 'node:path';
import { GoModule, isInside, tagPrefix } from '../src/gomod.js';
import type { Runner } from '../src/utils/exec.js';
import { goMod } from './utils/go-mod.js';
import { recordingLogger } from './utils/logger.js';
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
): readonly string[] =>
  GoModule.discover(root, patterns, recordingLogger().logger).map(
    (module) => module.file,
  );

describe('GoModule.discover', () => {
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
    'skips .git and every other dot-directory (patterns %j)',
    async (patterns) => {
      await withTmp(
        {
          'go.mod': goMod('github.com/example/repo'),
          '.git/modules/x/go.mod': goMod('github.com/example/git'),
          '.tools/y/go.mod': goMod('github.com/example/repo/.tools/y'),
          '.ci/go.mod': goMod('github.com/example/repo/.ci'),
        },
        async (dir) => {
          expect(discover(dir, patterns)).toEqual([]);
        },
      );
    },
  );

  it('honours a literal path into a dot-directory, which Go cannot release', async () => {
    await withTmp(
      { '.tools/go.mod': goMod('github.com/example/repo/.tools') },
      async (dir) => {
        expect(discover(dir, ['.tools/go.mod'])).toEqual([
          join(dir, '.tools/go.mod'),
        ]);
      },
    );
  });

  it('does not walk into a Go module cache kept in a dot-directory', async () => {
    await withTmp(
      {
        'go.mod': goMod('github.com/example/repo'),
        '.go/pkg/mod/github.com/a/b@v1.2.3/go.mod': goMod('github.com/a/b'),
        'sub/go.mod': goMod('github.com/example/repo/sub'),
      },
      async (dir) => {
        expect(discover(dir)).toEqual([join(dir, 'sub/go.mod')]);
        expect(discover(dir, ['**/go.mod'])).toEqual([join(dir, 'sub/go.mod')]);
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
        const { logger, lines } = recordingLogger();
        GoModule.discover(dir, undefined, logger);
        const text = lines.join('\n');
        expect(text).toContain(join(dir, 'vendor'));
        expect(text).toContain(join(dir, 'sub/node_modules'));
        expect(text).not.toContain(join(dir, '.git'));
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
          const { logger, lines } = recordingLogger();
          GoModule.discover(dir, [pattern], logger);
          // The directories are reported when the walk reaches them, so
          // their contents are never listed.
          const skipped = lines.filter((l) => l.startsWith('Not searching'));
          expect(skipped).toHaveLength(2);
          expect(lines.join('\n')).toContain(join(dir, 'node_modules'));
          expect(lines.join('\n')).toContain(join(dir, 'vendor'));
        },
      );
    },
  );

  it('reports each skipped directory once per run, however many patterns reach it', async () => {
    await withTmp(
      {
        'sub/go.mod': goMod('github.com/example/repo/sub'),
        'node_modules/a/go.mod': goMod('x'),
      },
      async (dir) => {
        const { logger, lines } = recordingLogger();
        GoModule.discover(
          dir,
          ['**/go.mod', '*/go.mod', '**/**/go.mod'],
          logger,
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`Not searching %s for modules`);
        expect(lines[0]).toContain(join(dir, 'node_modules'));
      },
    );
  });

  it('warns about a pattern that matches nothing, and still returns the rest', async () => {
    await withTmp(
      { 'sub/go.mod': goMod('github.com/example/repo/sub') },
      async (dir) => {
        const { logger, lines } = recordingLogger();
        expect(
          GoModule.discover(dir, ['sub/go.mod', 'svc/*/go.mod'], logger).map(
            (module) => module.file,
          ),
        ).toEqual([join(dir, 'sub/go.mod')]);
        expect(lines).toEqual([
          'Pattern "%s" in `modules` matched no go.mod files. svc/*/go.mod',
        ]);
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

describe('links and the repository boundary', () => {
  it('does not follow a symlinked directory named literally in a pattern', async () => {
    await withTmp(
      { 'a/go.mod': goMod('github.com/example/repo/a'), 'other/keep': '' },
      async (dir) => {
        await symlink(join(dir, 'a'), join(dir, 'dirlink'));
        expect(discover(dir, ['a/go.mod', 'dirlink/go.mod'])).toEqual([
          join(dir, 'a/go.mod'),
        ]);
      },
    );
  });

  it('does not follow a symlinked directory that leaves the repository', async () => {
    await withTmp(
      { 'ext/go.mod': goMod('github.com/example/ext') },
      async (outside) => {
        await withTmp({ keep: '' }, async (dir) => {
          await symlink(join(outside, 'ext'), join(dir, 'ext'));
          expect(discover(dir, ['ext/go.mod'])).toEqual([]);
          expect(discover(dir, ['*/go.mod'])).toEqual([]);
          expect(discover(dir)).toEqual([]);
        });
      },
    );
  });

  it('warns about a pattern that only reached a link', async () => {
    await withTmp({ 'a/go.mod': goMod('x') }, async (dir) => {
      await symlink(join(dir, 'a'), join(dir, 'link'));
      const { logger, lines } = recordingLogger();
      GoModule.discover(dir, ['link/go.mod'], logger);
      expect(lines).toHaveLength(1);
    });
  });
});

describe('GoModule.discover and the repository boundary', () => {
  it.each([['../outside/x/go.mod'], ['a/../../outside/x/go.mod']])(
    'drops %s, which leads outside the repository, and warns',
    async (pattern) => {
      await withTmp(
        {
          'outside/x/go.mod': goMod('github.com/example/x'),
          'repo/a/keep': '',
        },
        async (dir) => {
          const { logger, lines } = recordingLogger();
          expect(
            GoModule.discover(join(dir, 'repo'), [pattern], logger),
          ).toEqual([]);
          expect(lines).toEqual([
            `Pattern "%s" in \`modules\` matched no go.mod files. ${pattern}`,
          ]);
        },
      );
    },
  );

  it('drops a match outside the repository that a sibling directory provides', async () => {
    await withTmp(
      {
        'outside/x/go.mod': goMod('github.com/example/x'),
        'repo/keep': '',
      },
      async (dir) => {
        const { logger } = recordingLogger();
        expect(
          GoModule.discover(join(dir, 'repo'), ['../outside/x/go.mod'], logger),
        ).toEqual([]);
      },
    );
  });
});

describe('isInside', () => {
  it.each([
    ['a file below the root', '/repo', '/repo/a/go.mod', true],
    ['a sibling directory', '/repo', '/repo-other/go.mod', false],
    ['the parent', '/repo', '/go.mod', false],
    ['the root itself', '/repo', '/repo', false],
  ])('on posix: %s', (_name, root, file, expected) => {
    expect(isInside(root, file)).toBe(expected);
  });

  it.each([
    ['a file below the root', 'C:\\repo', 'C:\\repo\\a\\go.mod', true],
    [
      'a backslash path that climbs out',
      'C:\\repo',
      'C:\\repo\\..\\x\\go.mod',
      false,
    ],
    ['another drive', 'C:\\repo', 'D:\\repo\\go.mod', false],
    ['a differently cased path', 'C:\\Repo', 'c:\\repo\\a\\go.mod', true],
  ])('on win32: %s', (_name, root, file, expected) => {
    expect(isInside(root, file, path.win32)).toBe(expected);
  });
});

describe('GoModule.modulePath', () => {
  it('extracts the module path from a go.mod file', async () => {
    await withTmp(
      { 'go.mod': goMod('github.com/example/repo') },
      async (dir) => {
        expect(GoModule.open(join(dir, 'go.mod')).modulePath()).toBe(
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
      expect(GoModule.open(join(dir, 'go.mod')).modulePath()).toBe(
        'github.com/example/q',
      );
    });
  });

  it.each([
    ['a grouped declaration', 'module (\n\t"github.com/example/q"\n)\n'],
    [
      'a grouped declaration on one line',
      'module ( "github.com/example/q" )\n',
    ],
    ['a grouped declaration without a space', 'module(\n"x"\n)\n'],
  ])('says it cannot read %s', async (_name, content) => {
    await withTmp({ 'go.mod': content }, async (dir) => {
      expect(() => GoModule.open(join(dir, 'go.mod')).modulePath()).toThrow(
        /Grouped module declarations .* are not supported/,
      );
    });
  });

  it.each([
    ['an unterminated double quote', 'module "github.com/example/q\n'],
    ['an unterminated raw quote', 'module `github.com/example/q\n'],
    ['mismatched quotes', 'module "github.com/example/q`\n'],
  ])('refuses %s', async (_name, content) => {
    await withTmp({ 'go.mod': content }, async (dir) => {
      expect(() => GoModule.open(join(dir, 'go.mod')).modulePath()).toThrow(
        /Unterminated quote/,
      );
    });
  });

  it.each([
    ['an empty declaration', 'module\n'],
    ['a word that only starts with module', 'modules github.com/x\n'],
  ])('throws for %s', async (_name, content) => {
    await withTmp({ 'go.mod': content }, async (dir) => {
      expect(() => GoModule.open(join(dir, 'go.mod')).modulePath()).toThrow(
        /No module declaration found/,
      );
    });
  });

  it('throws if no module line is present', async () => {
    await withTmp({ 'go.mod': 'go 1.21\n' }, async (dir) => {
      expect(() => GoModule.open(join(dir, 'go.mod')).modulePath()).toThrow(
        /No module declaration found in .*go\.mod/,
      );
    });
  });
});

describe('GoModule.pin', () => {
  const update = async (
    requires: readonly string[],
    version = '2.0.0',
  ): Promise<string> =>
    withTmp(
      { 'go.mod': goMod('github.com/example/sub', requires) },
      async (dir) => {
        GoModule.open(join(dir, 'go.mod')).pin(
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
      GoModule.open(join(dir, 'go.mod')).pin(
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
      GoModule.open(join(dir, 'go.mod')).pin(
        'github.com/example/repo',
        '2.0.0',
      );
      expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe(file('v2.0.0'));
    });
  });

  it.each([
    [
      'an indented opener',
      '  require (\n\tgithub.com/example/repo v1.0.0\n  )\n',
    ],
    [
      'a tab-indented opener',
      '\trequire (\n\tgithub.com/example/repo v1.0.0\n)\n',
    ],
    [
      'an indented single-line require',
      '  require github.com/example/repo v1.0.0\n',
    ],
    ['a quoted single-line path', 'require "github.com/example/repo" v1.0.0\n'],
    [
      'a raw-quoted single-line path',
      'require `github.com/example/repo` v1.0.0\n',
    ],
    [
      'a quoted path in a block',
      'require (\n\t"github.com/example/repo" v1.0.0\n)\n',
    ],
    [
      'a quoted sub-path in a block',
      'require (\n\t"github.com/example/repo/sub" v1.0.0\n)\n',
    ],
    [
      'an indented entry in a block',
      'require (\n    github.com/example/repo v1.0.0\n)\n',
    ],
  ])('pins %s', async (_name, body) => {
    const file = `module x\n\n${body}`;
    await withTmp({ 'go.mod': file }, async (dir) => {
      GoModule.open(join(dir, 'go.mod')).pin(
        'github.com/example/repo',
        '2.0.0',
      );
      expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe(
        file.replace('v1.0.0', 'v2.0.0'),
      );
    });
  });

  it('leaves a quoted longer module name alone', async () => {
    expect(await update(['"github.com/example/repository" v1.0.0'])).toContain(
      '"github.com/example/repository" v1.0.0',
    );
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
      GoModule.open(join(dir, 'go.mod')).pin(
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
        GoModule.open(join(dir, 'go.mod')).pin(
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
      GoModule.open(join(dir, 'go.mod')).pin(
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
        GoModule.open(join(dir, 'go.mod')).pin('github.com/a.b/repo', '2.0.0');
        expect(await readFile(join(dir, 'go.mod'), 'utf8')).toContain(
          'github.com/aXb/repo v1.0.0',
        );
      },
    );
  });
});

describe('tagPrefix', () => {
  it('returns an empty string for the root go.mod', () => {
    expect(tagPrefix(join('/repo', 'go.mod'), '/repo')).toBe('');
  });

  it('uses forward slashes whatever the platform separator', () => {
    expect(
      tagPrefix('C:\\repo\\assert\\cert\\go.mod', 'C:\\repo', path.win32),
    ).toBe('assert/cert');
  });

  it('returns the relative directory for submodules', () => {
    expect(
      tagPrefix(join('/repo', 'assert/cert/manager', 'go.mod'), '/repo'),
    ).toBe('assert/cert/manager');
  });
});

describe('GoModule', () => {
  it('opens a go.mod without reading it, so a broken file fails only when asked', async () => {
    await withTmp({ 'go.mod': 'module (\n' }, async (dir) => {
      const module = GoModule.open(join(dir, 'go.mod'));
      expect(module.file).toBe(join(dir, 'go.mod'));
      expect(() => module.modulePath()).toThrow(/Grouped module/);
    });
  });

  it('names the tag a release gives it', () => {
    const root = join('/repo');
    expect(GoModule.open(join(root, 'go.mod')).tagName(root, '1.2.3')).toBe(
      'v1.2.3',
    );
    expect(
      GoModule.open(join(root, 'assert/cert/go.mod')).tagName(root, '1.2.3'),
    ).toBe('assert/cert/v1.2.3');
  });

  it('pins and returns itself, so calls chain', async () => {
    await withTmp(
      { 'go.mod': goMod('x', ['github.com/example/repo v1.0.0']) },
      async (dir) => {
        const module = GoModule.open(join(dir, 'go.mod'));
        expect(module.pin('github.com/example/repo', '2.0.0')).toBe(module);
        expect(await readFile(join(dir, 'go.mod'), 'utf8')).toContain(
          'github.com/example/repo v2.0.0',
        );
      },
    );
  });

  it('discovers modules that carry the runner they were given', async () => {
    await withTmp(
      { 'a/go.mod': goMod('github.com/example/repo/a') },
      async (dir) => {
        const run = jest.fn<Runner>(async () => '');
        const [module] = GoModule.discover(
          dir,
          undefined,
          recordingLogger().logger,
          {
            run,
          },
        );
        await module?.tidy();
        expect(run).toHaveBeenCalledWith('go', ['mod', 'tidy'], {
          cwd: join(dir, 'a'),
        });
      },
    );
  });

  describe('tidy', () => {
    it('runs go mod tidy in the module directory and returns the module', async () => {
      const run = jest.fn<Runner>(async () => '');
      const module = GoModule.open('/repo/sub/go.mod', { run });
      expect(await module.tidy()).toBe(module);
      expect(run.mock.calls).toEqual([
        ['go', ['mod', 'tidy'], { cwd: '/repo/sub' }],
      ]);
    });

    it('passes a hostile directory name as a cwd, never as shell text', async () => {
      const run = jest.fn<Runner>(async () => '');
      await GoModule.open('/repo/$(id);x y/go.mod', { run }).tidy();
      expect(run.mock.calls).toEqual([
        ['go', ['mod', 'tidy'], { cwd: '/repo/$(id);x y' }],
      ]);
    });

    it('lets a failure propagate for the caller to report', async () => {
      const failure = new Error('go: no network');
      const run = jest.fn<Runner>(async () => {
        throw failure;
      });
      await expect(
        GoModule.open('/repo/sub/go.mod', { run }).tidy(),
      ).rejects.toBe(failure);
    });

    it('uses the real runner when none is given', async () => {
      await expect(
        GoModule.open('/nonexistent-gomod/go.mod').tidy(),
      ).rejects.toBeInstanceOf(Error);
    });
  });
});
