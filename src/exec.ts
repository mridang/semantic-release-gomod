import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  codeOf,
  messageOf,
  redactCredentials,
  signalOf,
  statusOf,
} from './utils/error.js';

/**
 * A function that runs a program synchronously, without a shell. The program
 * and each argument are passed separately, so values such as tag names and
 * directory names are never interpreted as shell syntax.
 * Accepting this as a parameter makes the callers unit-testable
 * without needing to mock Node.js built-in modules.
 *
 * Implementations return what the program wrote to stdout, and must throw
 * when it exits with a non-zero status. Callers are responsible for catching and handling failures.
 */
export type ExecFn = (
  file: string,
  args: readonly string[],
  opts?: Omit<ExecFileSyncOptions, 'encoding'>,
) => string;

/**
 * The largest output, in bytes, a child process may write before it is
 * killed. Node's default of 1 MiB makes chatty `go mod tidy` or git output
 * fail with `ENOBUFS`.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * A failed child process whose message has been redacted. It keeps the
 * machine-readable fields of the original error, so callers can tell a
 * missing program (`ENOENT`) from a failing one (`status`) or a kill
 * (`signal`), without carrying the unredacted original along.
 */
class ExecError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly signal: string | undefined;

  /**
   * @param source The error thrown by `execFileSync`.
   */
  constructor(source: unknown) {
    super(redactCredentials(messageOf(source)));
    this.name = 'ExecError';
    this.code = codeOf(source);
    this.status = statusOf(source);
    this.signal = signalOf(source);
  }
}

/**
 * Default executor that delegates to Node's `execFileSync`. A failure is
 * rethrown with credentials in URLs (such as a token in a remote) redacted
 * from its message, since git echoes the remote in its errors, and with the
 * `code`, `status` and `signal` of the original kept.
 *
 * @param file The program to run.
 * @param args Its arguments.
 * @param opts Options passed to `execFileSync`.
 * @returns What the program wrote to stdout.
 * @throws Error when the program cannot be run or exits unsuccessfully.
 */
export const defaultExec: ExecFn = (file, args, opts) => {
  try {
    return execFileSync(file, args, {
      maxBuffer: MAX_BUFFER,
      ...opts,
      encoding: 'utf8',
    });
  } catch (err: unknown) {
    throw new ExecError(err);
  }
};
