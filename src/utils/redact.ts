/**
 * @file Removes credentials from text before it is logged or put in an error.
 */

/**
 * Hide credentials in a piece of text that is about to be logged or put in an
 * error message. This is a backstop that works on the shape of the text; the
 * primary defence is not to put secrets in text at all.
 *
 * Covered: `scheme://user:password@` (the password may contain `@` and `/`,
 * and the scheme may be any case), `scheme://token@`, `token=`,
 * `access_token=`, `password=` and `private_token=` query values,
 * `Authorization:` header lines, `Bearer` tokens, and bare GitHub and GitLab
 * tokens (`ghp_`, `github_pat_`, `glpat-`).
 * @param text - Text that may contain credentials.
 * @returns The text with every credential replaced by `***`.
 * @example
 * redactCredentials('https://user:secret@host/repo.git'); // 'https://***@host/repo.git'
 */
export function redactCredentials(text: string): string {
  return (
    text
      // eslint-disable-next-line sonarjs/super-linear-regex -- the password may contain `/` and `@`, so the match cannot be narrowed without changing behaviour
      .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:\S*@/gi, '$1***@')
      // eslint-disable-next-line sonarjs/super-linear-regex -- the bounded userinfo class is linear in practice; kept to match the password form above
      .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+@/gi, '$1***@')
      .replaceAll(
        /([?&](?:access_token|token|password|private_token)=)[^&\s#'"]+/gi,
        '$1***',
      )
      .replaceAll(/\b((?:proxy-)?authorization)\s*:[^\r\n]*/gi, '$1: ***')
      .replaceAll(/\bbearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
      .replaceAll(
        /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[A-Za-z0-9_-]{16,})/g,
        '***',
      )
  );
}
