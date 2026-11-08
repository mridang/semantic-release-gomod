import { describe, expect, it } from '@jest/globals';
import {
  codeOf,
  messageOf,
  redactCredentials,
  signalOf,
  statusOf,
} from '../../src/utils/error.js';

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

describe('codeOf', () => {
  it('reads the string code of an error', () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'EBOOM' }))).toBe(
      'EBOOM',
    );
  });

  it.each([[new Error('x')], [{ code: 5 }], ['ENOENT'], [null], [undefined]])(
    'gives undefined for %j',
    (thrown) => {
      expect(codeOf(thrown)).toBeUndefined();
    },
  );
});

describe('statusOf and signalOf', () => {
  it('read the exit status and the signal of a failed process', () => {
    const failure = Object.assign(new Error('x'), { status: 3, signal: null });
    expect(statusOf(failure)).toBe(3);
    expect(signalOf(failure)).toBeUndefined();
    expect(signalOf({ signal: 'SIGTERM', status: null })).toBe('SIGTERM');
    expect(statusOf({ signal: 'SIGTERM', status: null })).toBeUndefined();
  });

  it.each([['x'], [null], [undefined]])('give undefined for %j', (thrown) => {
    expect(statusOf(thrown)).toBeUndefined();
    expect(signalOf(thrown)).toBeUndefined();
  });
});
