/**
 * @file Runs external programs without a shell and turns their failures into
 * credential-safe errors.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { codeOf, messageOf, signalOf, statusOf } from './error.js';
import { isRecord } from './object.js';
import { redactCredentials } from './redact.js';

/**
 * Largest output captured from a command: 64 MiB, so a long listing is not
 * mistaken for a failure.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Options for running a command.
 */
export interface ExecOptions {
  /** Working directory of the command. */
  readonly cwd?: string;
  /** Variables added to the current environment for the command. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Text written to the command's standard input, which is then closed. */
  readonly input?: string;
  /** Milliseconds after which the command is killed (code `ETIMEDOUT`). */
  readonly timeout?: number;
  /** Largest stdout or stderr captured, in bytes. */
  readonly maxBuffer?: number;
}

/**
 * Runs a program without a shell and resolves with its standard output.
 */
export type Runner = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<string>;

/**
 * The error raised when a command cannot be started or exits unsuccessfully.
 * It carries the same shape in every plugin: `code` (a system error such as
 * `ENOENT`), `status` (the exit code), `signal`, and the captured output.
 * Credentials are removed from the message and the output.
 */
export class ExecError extends Error {
  /** The system error code, such as `ENOENT` or `ETIMEDOUT`. */
  readonly code: string | undefined;

  /** The exit code of a command that ran and failed. */
  readonly status: number | undefined;

  /** The signal that killed the command. */
  readonly signal: string | undefined;

  /** What the command wrote to stdout, with credentials removed. */
  readonly stdout: string;

  /** What the command wrote to stderr, with credentials removed. */
  readonly stderr: string;

  /**
   * Create the error for a command that could not start or failed.
   * @param message - Description of the failure, already free of credentials.
   * @param details - The code, exit status, signal and captured output.
   * @param details.code - System error code, such as `ENOENT`.
   * @param details.status - Exit code of a command that ran and failed.
   * @param details.signal - Signal that killed the command.
   * @param details.stdout - Captured standard output.
   * @param details.stderr - Captured standard error.
   * @example
   * throw new ExecError('git failed', { code: undefined, status: 1, signal: undefined, stdout: '', stderr: '' });
   */
  constructor(
    message: string,
    details: {
      readonly code: string | undefined;
      readonly status: number | undefined;
      readonly signal: string | undefined;
      readonly stdout: string;
      readonly stderr: string;
    },
  ) {
    super(message);
    this.name = 'ExecError';
    this.code = details.code;
    this.status = details.status;
    this.signal = details.signal;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}

const execFileAsync = promisify(execFile);

/**
 * Turn the error a failed command rejects with into an `ExecError`. The
 * promisified `execFile` rejects with an `Error` that carries the exit
 * status or system code in `code`, plus `signal`, `killed`, `stdout` and
 * `stderr`.
 * @param error - What the command rejected with.
 * @param options - The options the command ran with.
 * @returns The credential-safe error.
 */
function toExecError(error: unknown, options: ExecOptions): ExecError {
  const text = (name: 'stdout' | 'stderr'): string => {
    const value = isRecord(error) ? error[name] : undefined;
    return redactCredentials(typeof value === 'string' ? value : '');
  };
  const timedOut =
    isRecord(error) && error.killed === true && options.timeout !== undefined;
  return new ExecError(redactCredentials(messageOf(error)), {
    code: timedOut ? 'ETIMEDOUT' : codeOf(error),
    status:
      statusOf(error) ??
      (isRecord(error) && typeof error.code === 'number'
        ? error.code
        : undefined),
    signal: signalOf(error),
    stdout: text('stdout'),
    stderr: text('stderr'),
  });
}

/**
 * Run a program without a shell. Arguments are passed as an array, so nothing
 * in them is interpreted; the environment is the current one plus
 * `options.env`. The standard input is always closed, after `options.input`
 * has been written, so a command never waits for input.
 * @param file - Program to run.
 * @param args - Its arguments.
 * @param options - Working directory, extra environment, input, timeout and
 * output limit.
 * @returns The standard output as a string.
 * @throws ExecError when the program cannot be started, fails or times out;
 * its message and output have credentials redacted.
 * @example
 * const version = await run('git', ['--version']);
 * console.log(version.trim()); // 'git version 2.45.0'
 */
export const run: Runner = async (file, args, options = {}) => {
  const pending = execFileAsync(file, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    timeout: options.timeout,
    encoding: 'utf8',
  });
  // The command may exit before it has read its input (EPIPE).
  pending.child.stdin?.on('error', () => undefined);
  pending.child.stdin?.end(options.input);
  try {
    const { stdout } = await pending;
    return stdout;
  } catch (error: unknown) {
    throw toExecError(error, options);
  }
};
