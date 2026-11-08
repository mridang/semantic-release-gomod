import { execFileSync } from 'node:child_process';
import { codeOf, messageOf, signalOf, statusOf } from './error.js';
import { redactCredentials } from './redact.js';

/**
 * Options for running a program.
 */
interface RunOptions {
  /** The directory to run the program in. */
  readonly cwd?: string | undefined;
  /** The environment of the program; the current one when omitted. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Runs a program synchronously, without a shell: the program and each
 * argument are passed separately, so values such as tag names and directory
 * names are never interpreted as shell syntax. It returns what the program
 * wrote to stdout and throws when it exits with a non-zero status.
 * Accepting this as a parameter lets callers be unit-tested with a fake.
 */
export type Run = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => string;

/**
 * The largest output, in bytes, a child process may write before it is
 * killed. Node's default of 1 MiB makes chatty tools fail with `ENOBUFS`.
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
 * Run a program with `execFileSync`. A failure is rethrown with credentials
 * in URLs (such as a token in a remote) redacted from its message, since
 * tools echo the remote in their errors, and with the `code`, `status` and
 * `signal` of the original kept.
 *
 * @param file The program to run.
 * @param args Its arguments.
 * @param options Where and with what environment to run it.
 * @returns What the program wrote to stdout.
 * @throws Error when the program cannot be run or exits unsuccessfully.
 */
export const run: Run = (file, args, options) => {
  try {
    return execFileSync(file, args, {
      maxBuffer: MAX_BUFFER,
      ...options,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err: unknown) {
    throw new ExecError(err);
  }
};
