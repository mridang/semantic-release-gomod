/**
 * The message of anything that was thrown.
 *
 * @param error A caught value, which is not necessarily an `Error`.
 * @returns Its message, or its string form when it is not an `Error`.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hide the user name and password of every URL in a text, such as the token
 * in `https://user:token@github.com/owner/repo`.
 *
 * @param text Text that may contain URLs, for example a command's error output.
 * @returns The text with `scheme://user:password@` replaced by `scheme://***@`.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@');
}
