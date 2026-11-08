import { run as defaultRun, type Run } from './utils/exec.js';

/**
 * How to build a `GoClient`.
 */
export interface GoClientOptions {
  /** Runs a program; defaults to the real, shell-free runner. */
  readonly run?: Run | undefined;
}

/**
 * A handle on the `go` commands the plugin needs.
 */
export class GoClient {
  private readonly run: Run;

  /**
   * @param options For tests, a runner.
   */
  constructor(options: GoClientOptions = {}) {
    this.run = options.run ?? defaultRun;
  }

  /**
   * Run `go mod tidy` in a module directory.
   *
   * @param dir The directory holding the go.mod file.
   * @throws Whatever `go` failed with, for the caller to report.
   */
  modTidy(dir: string): void {
    this.run('go', ['mod', 'tidy'], { cwd: dir });
  }
}
