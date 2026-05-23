import { execSync as nodeExecSync, type ExecSyncOptions } from 'child_process';

/**
 * A function that executes a shell command synchronously.
 * Accepting this as a parameter makes the callers unit-testable
 * without needing to mock Node.js built-in modules.
 */
export type ExecFn = (cmd: string, opts?: ExecSyncOptions) => void;

/**
 * Default executor that delegates to Node's built-in `execSync`.
 */
export const defaultExec: ExecFn = (cmd, opts) => {
  nodeExecSync(cmd, opts);
};
