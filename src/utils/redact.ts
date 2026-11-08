/**
 * Bare access tokens recognised by their well-known prefixes: GitHub
 * (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), GitLab (`glpat-`),
 * npm (`npm_`) and Slack (`xox*-`).
 */
const TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g;

/**
 * Hide secrets in a text, such as a command's error output or a URL, so they
 * never reach a log or an error message. It hides:
 * - the user name and password of a URL (`scheme://user:password@host`), up
 *   to the last `@` before the host so a password containing `@` or `/` is
 *   covered, also when percent-encoded or when the scheme is in capitals;
 * - the values of query parameters that look like secrets (`?token=`,
 *   `&access_token=`, `api_key=`, `password=`, `secret=`, `signature=`);
 * - `Authorization` and `Proxy-Authorization` header values and `Bearer`
 *   tokens;
 * - bare GitHub, GitLab, npm and Slack tokens.
 *
 * An `@` directly after a `/` (as in the Go proxy's `.../@v/list`) is not
 * treated as the end of a user name.
 *
 * @param text Text that may contain secrets.
 * @returns The text with each secret replaced by `***`.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s]*[^\s/]@/gi, '$1***@')
    .replace(
      /([?&](?:[\w.-]*[_.-])?(?:token|apikey|key|secret|password|passwd|signature|sig)=)[^&\s#'"]*/gi,
      '$1***',
    )
    .replace(
      /\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;'"]+/gi,
      '$1***',
    )
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(TOKEN, '***');
}
