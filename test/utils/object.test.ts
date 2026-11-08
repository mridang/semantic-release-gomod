import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { isRecord, numberAt, stringAt } from '../../src/utils/object.js';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it.each([null, undefined, [], [1], 'x', 1, true])('rejects %s', (value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe('stringAt', () => {
  const record = { s: 'x', n: 0, other: null };

  it('reads a string property', () => {
    expect(stringAt(record, 's')).toBe('x');
  });

  it('ignores inherited properties', () => {
    expect(stringAt(Object.create({ s: 'inherited' }), 's')).toBeUndefined();
  });

  it('gives undefined for a missing property or the wrong type', () => {
    expect(stringAt(record, 'n')).toBeUndefined();
    expect(stringAt(record, 'other')).toBeUndefined();
    expect(stringAt(record, 'missing')).toBeUndefined();
  });
});

describe('numberAt', () => {
  const record = { s: 'x', n: 0, other: null };

  it('reads a number property', () => {
    expect(numberAt(record, 'n')).toBe(0);
  });

  it('ignores inherited properties', () => {
    expect(numberAt(Object.create({ n: 1 }), 'n')).toBeUndefined();
  });

  it('gives undefined for a missing property or the wrong type', () => {
    expect(numberAt(record, 's')).toBeUndefined();
    expect(numberAt(record, 'other')).toBeUndefined();
    expect(numberAt(record, 'missing')).toBeUndefined();
  });
});
