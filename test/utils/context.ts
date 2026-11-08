import { jest } from '@jest/globals';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import type { ExecFn } from '../../src/exec.js';

/**
 * A logger whose calls can be inspected.
 *
 * @returns Mock functions for each logger method the plugin may use.
 */
export function mockLogger(): {
  readonly log: jest.Mock;
  readonly warn: jest.Mock;
  readonly error: jest.Mock;
} {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * A command executor that records its calls and optionally fails.
 *
 * @param behaviour Called with each command, and may throw to fail it.
 * @returns A mock usable wherever an `ExecFn` is expected.
 */
export function mockExec(
  behaviour: (cmd: string) => void = () => undefined,
): jest.Mock<ExecFn> {
  return jest.fn<ExecFn>((cmd) => behaviour(cmd));
}

/**
 * Build the semantic-release context a step receives. The real context has
 * dozens of members (streams, branches, commits) that the plugin never reads,
 * so this is the single place in the tests that builds it from the few it
 * does, and the only place that needs a cast.
 *
 * @param cwd The repository directory.
 * @param version The version being released.
 * @returns The context, typed for each step, and its logger.
 */
export function stepContext(
  cwd: string,
  version = '1.2.3',
): {
  readonly logger: ReturnType<typeof mockLogger>;
  readonly verify: VerifyConditionsContext;
  readonly prepare: PrepareContext;
  readonly publish: PublishContext;
} {
  const logger = mockLogger();
  const partial: unknown = { logger, cwd, nextRelease: { version } };
  return {
    logger,
    verify: partial as VerifyConditionsContext,
    prepare: partial as PrepareContext,
    publish: partial as PublishContext,
  };
}
