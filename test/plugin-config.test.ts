import { describe, expect, it } from '@jest/globals';
import { resolveConfig } from '../src/plugin-config.js';

describe('resolveConfig', () => {
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
