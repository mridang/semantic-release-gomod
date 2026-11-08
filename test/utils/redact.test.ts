import { describe, expect, it } from '@jest/globals';
import { redactCredentials } from '../../src/utils/redact.js';

describe('redactCredentials', () => {
  it.each([
    [
      'user and password',
      'https://user:token@github.com/o/r.git',
      'https://***@github.com/o/r.git',
    ],
    [
      'a token as user',
      'https://token@github.com/o/r',
      'https://***@github.com/o/r',
    ],
    ['ssh with a port', 'ssh://git@host:22/o/r', 'ssh://***@host:22/o/r'],
    [
      'an @ in the password',
      'https://u:p@ss@host.com/r',
      'https://***@host.com/r',
    ],
    [
      'a / in the password',
      'https://u:p/ss@host.com/r',
      'https://***@host.com/r',
    ],
    [
      'percent-encoded userinfo',
      'https://u%40x:p%2Fw@host.com/r',
      'https://***@host.com/r',
    ],
    ['an uppercase scheme', 'HTTPS://u:p@host.com/r', 'HTTPS://***@host.com/r'],
    [
      'two URLs',
      'a https://u:p@a.com b http://x:y@b.com',
      'a https://***@a.com b http://***@b.com',
    ],
    [
      'a quoted URL',
      "fatal: unable to access 'https://u:p@h.com/r/'",
      "fatal: unable to access 'https://***@h.com/r/'",
    ],
  ])('hides the userinfo of a URL with %s', (_name, input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it.each([
    [
      '?token=',
      'https://h.com/x?token=abc123&a=1',
      'https://h.com/x?token=***&a=1',
    ],
    [
      '&access_token=',
      'https://h.com/x?a=1&access_token=abc123',
      'https://h.com/x?a=1&access_token=***',
    ],
    ['api_key', 'https://h.com/x?api_key=abc', 'https://h.com/x?api_key=***'],
    [
      'password',
      'https://h.com/x?user=a&password=p%40ss#frag',
      'https://h.com/x?user=a&password=***#frag',
    ],
    [
      'a capitalised name',
      'https://h.com/x?Access_Token=abc',
      'https://h.com/x?Access_Token=***',
    ],
  ])('hides the value of the query parameter %s', (_name, input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it.each([
    ['a GitHub token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end'],
    [
      'a fine-grained GitHub token',
      'x github_pat_11ABCDEFG0abcdefghijklmnopqrstuv_abcdefghijklmnopqrstu y',
    ],
    ['a GitLab token', 'glpat-abcdefghij0123456789'],
    ['an npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('hides %s that stands alone', (_name, input) => {
    const out = redactCredentials(input);
    expect(out).toContain('***');
    expect(out).not.toMatch(/abcdefghij/);
  });

  it.each([
    [
      'an Authorization header',
      'Authorization: Bearer abc.def.ghi',
      'Authorization: ***',
    ],
    [
      'a lowercase header',
      'authorization: Basic dXNlcjpwYXNz',
      'authorization: ***',
    ],
    [
      'a Proxy-Authorization header',
      'Proxy-Authorization: Basic dXNlcjpwYXNz',
      'Proxy-Authorization: ***',
    ],
    ['a bare Bearer token', 'sent Bearer abcdef0123456789', 'sent Bearer ***'],
  ])('hides %s', (_name, input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  it.each([
    ['plain text', 'no url here'],
    ['a URL without credentials', 'https://github.com/o/r'],
    ['an email address', 'mailto me@example.com'],
    [
      'the Go proxy version list',
      'Get "https://proxy.golang.org/github.com/x/y/@v/list": EOF',
    ],
    ['a short word after Bearer', 'the Bearer is short'],
    ['a harmless query', 'https://h.com/x?page=2&monkey=1'],
  ])('leaves %s alone', (_name, input) => {
    expect(redactCredentials(input)).toBe(input);
  });
});
