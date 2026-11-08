import { describe, expect, it } from '@jest/globals';
import { resolveConfig } from '../src/plugin-config.js';
import { rawConfig } from './utils/context.js';

describe('resolveConfig', () => {
  it.each([[null], [undefined]])(
    'treats %s like an unset option for every option with a default',
    (unset) => {
      expect(
        resolveConfig(
          rawConfig({
            modules: unset,
            skipGoModTidy: unset,
            pushTags: unset,
          }),
        ),
      ).toEqual({ modules: undefined, skipGoModTidy: false, pushTags: true });
    },
  );

  it.each([[false], [0], ['']])(
    'treats modules %j like an unset option, as before',
    (modules) => {
      expect(resolveConfig(rawConfig({ modules })).modules).toBeUndefined();
    },
  );

  it.each([[5], [true], [{}], [[1]], [['a', null]], [[['a']]]])(
    'rejects modules %j with a coded error instead of crashing',
    (modules) => {
      expect(() => resolveConfig(rawConfig({ modules }))).toThrow(
        expect.objectContaining({
          code: 'EINVALIDMODULES',
          message:
            "Option 'modules' must be a glob string or an array of glob strings.",
        }),
      );
    },
  );

  it.each([
    ['skipGoModTidy', 'EINVALIDSKIPGOMODTIDY', 'true'],
    ['skipGoModTidy', 'EINVALIDSKIPGOMODTIDY', 1],
    ['pushTags', 'EINVALIDPUSHTAGS', 'false'],
    ['pushTags', 'EINVALIDPUSHTAGS', 0],
  ])('rejects %s set to %j with %s', (option, code, value) => {
    expect(() => resolveConfig(rawConfig({ [option]: value }))).toThrow(
      expect.objectContaining({
        code,
        message: `Option '${option}' must be true or false.`,
      }),
    );
  });

  it.each([
    ['a partial-segment wildcard', 'svc-*/go.mod'],
    ['a single-character wildcard', 'svc-?/go.mod'],
    ['a brace list', '{a,b}/go.mod'],
    ['a character class', 'svc-[ab]/go.mod'],
    ['a double star inside a name', 'a**/go.mod'],
    ['a path that leaves the repository', '../other/go.mod'],
    ['a path that climbs out in the middle', 'a/../../go.mod'],
  ])('rejects %s', (_name, pattern) => {
    expect(() => resolveConfig(rawConfig({ modules: [pattern] }))).toThrow(
      expect.objectContaining({
        code: 'EINVALIDMODULES',
        message: expect.stringContaining(pattern),
      }),
    );
  });

  it.each([
    ['assert/**/go.mod'],
    ['*/go.mod'],
    ['pkg/*/sub/go.mod'],
    ['**/go.mod'],
    ['vendor/x/go.mod'],
    ['sub.dir/go.mod'],
  ])('accepts the supported pattern %s', (pattern) => {
    expect(resolveConfig({ modules: pattern }).modules).toEqual([pattern]);
  });

  it('keeps false as a real value for the boolean options', () => {
    expect(resolveConfig({ pushTags: false, skipGoModTidy: false })).toEqual({
      modules: undefined,
      skipGoModTidy: false,
      pushTags: false,
    });
  });

  it('applies the defaults to an empty config', () => {
    expect(resolveConfig({})).toEqual({
      modules: undefined,
      skipGoModTidy: false,
      pushTags: true,
    });
  });

  it('normalises a single glob string to an array', () => {
    expect(resolveConfig({ modules: 'sub/go.mod' }).modules).toEqual([
      'sub/go.mod',
    ]);
  });

  it('passes an array of globs through', () => {
    expect(
      resolveConfig({ modules: ['a/go.mod', 'b/go.mod'] }).modules,
    ).toEqual(['a/go.mod', 'b/go.mod']);
  });

  it('treats an empty string as not configured', () => {
    expect(resolveConfig({ modules: '' }).modules).toBeUndefined();
  });

  it('keeps an empty array', () => {
    expect(resolveConfig({ modules: [] }).modules).toEqual([]);
  });

  it('skips go mod tidy only when explicitly true', () => {
    expect(resolveConfig({ skipGoModTidy: true }).skipGoModTidy).toBe(true);
    expect(resolveConfig({ skipGoModTidy: false }).skipGoModTidy).toBe(false);
  });

  it('pushes tags unless explicitly disabled', () => {
    expect(resolveConfig({ pushTags: false }).pushTags).toBe(false);
    expect(resolveConfig({ pushTags: true }).pushTags).toBe(true);
  });
});
