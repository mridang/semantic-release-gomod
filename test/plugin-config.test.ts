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
