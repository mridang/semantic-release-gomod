import { describe, expect, it } from '@jest/globals';
import { messageOf, redactCredentials } from '../../src/utils/error.js';

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

describe('redactCredentials', () => {
  it.each([
    ['https://user:token@github.com/o/r.git', 'https://***@github.com/o/r.git'],
    ['https://token@github.com/o/r', 'https://***@github.com/o/r'],
    ['ssh://git@host:22/o/r', 'ssh://***@host:22/o/r'],
    ['no url here', 'no url here'],
    ['https://github.com/o/r', 'https://github.com/o/r'],
    [
      'a https://u:p@a.com b http://x:y@b.com',
      'a https://***@a.com b http://***@b.com',
    ],
    ['mailto me@example.com', 'mailto me@example.com'],
  ])('redacts %s', (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });
});
