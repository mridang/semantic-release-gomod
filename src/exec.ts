import { execSync as nodeExecSync, type ExecSyncOptions } from 'child_process';

/**
 * A function that executes a shell command synchronously.
 * Accepting this as a parameter makes the callers unit-testable
 * without needing to mock Node.js built-in modules.
 *
 * Implementations must throw when the command exits with a non-zero
 * status (matching the default behaviour of Node's `execSync`).
 * Callers are responsible for catching and handling failures.
 */
export type ExecFn = (cmd: string, opts?: ExecSyncOptions) => void;

/**
 * Default executor that delegates to Node's built-in `execSync`.
 */
export const defaultExec: ExecFn = (cmd, opts) => {
  nodeExecSync(cmd, opts);
};
