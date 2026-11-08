import { isRecord, numberAt, stringAt } from './object.js';

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

/**
 * The `code` of anything that was thrown, such as `ENOENT` or a
 * `SemanticReleaseError` code.
 *
 * @param error A caught value.
 * @returns Its string `code`, or undefined when it has none.
 */
export function codeOf(error: unknown): string | undefined {
  return isRecord(error) ? stringAt(error, 'code') : undefined;
}

/**
 * The exit `status` of a failed child process.
 *
 * @param error A caught value.
 * @returns Its numeric `status`, or undefined when it has none (a process
 * killed by a signal has a `null` status).
 */
export function statusOf(error: unknown): number | undefined {
  return isRecord(error) ? numberAt(error, 'status') : undefined;
}

/**
 * The `signal` that killed a child process.
 *
 * @param error A caught value.
 * @returns Its string `signal`, or undefined when it has none.
 */
export function signalOf(error: unknown): string | undefined {
  return isRecord(error) ? stringAt(error, 'signal') : undefined;
}
