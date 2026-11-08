import { jest } from '@jest/globals';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import type { ExecFn } from '../../src/exec.js';
import type { GomodPluginConfig } from '../../src/plugin-config.js';

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
 * A command executor that records its calls and optionally fails. Looking a
 * tag up with `git rev-parse` succeeds only for the tags that already exist.
 *
 * @param behaviour Called with each other command (program and arguments joined by spaces), and may throw to fail it.
 * @param existingTags Tags that already exist in the repository.
 * @returns A mock usable wherever an `ExecFn` is expected.
 */
export function mockExec(
  behaviour: (cmd: string) => void = () => undefined,
  existingTags: readonly string[] = [],
): jest.Mock<ExecFn> {
  return jest.fn<ExecFn>((file, args) => {
    const cmd = [file, ...args].join(' ');
    if (!cmd.startsWith('git rev-parse')) return behaviour(cmd);
    if (!existingTags.some((tag) => cmd.endsWith(` refs/tags/${tag}`))) {
      throw new Error('fatal: no such tag');
    }
  });
}

/**
 * The commands an executor was asked to run, each as one string.
 *
 * @param exec A mock made by `mockExec`.
 * @returns The program and arguments of each call, joined by spaces.
 */
export function commandsOf(exec: jest.Mock<ExecFn>): readonly string[] {
  return exec.mock.calls.map(([file, args]) => [file, ...args].join(' '));
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

/**
 * A plugin config with values of any type, as a config file can contain.
 *
 * @param options The raw option values.
 * @returns The same object, typed as a plugin config.
 */
export function rawConfig(
  options: Readonly<Record<string, unknown>>,
): GomodPluginConfig {
  return options;
}
