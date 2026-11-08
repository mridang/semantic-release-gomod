import { describe, expect, it } from '@jest/globals';
import { messageOf } from '../../src/utils/error.js';

describe('messageOf', () => {
  it.each([
    ['an Error', new Error('boom'), 'boom'],
    ['a string', 'plain', 'plain'],
    ['a number', 42, '42'],
    ['undefined', undefined, 'undefined'],
  ])('reads %s', (_name, thrown, expected) => {
    expect(messageOf(thrown)).toBe(expected);
  });
});
