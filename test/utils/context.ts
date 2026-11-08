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
 * The error a program throws when it exits with a status.
 *
 * @param status The exit status; git answers a yes/no question with 1.
 * @returns An error carrying `status`, like the ones `defaultExec` throws.
 */
export function exitedWith(status: number): Error {
  return Object.assign(new Error(`Command failed with status ${status}`), {
    status,
  });
}

/**
 * The commit `HEAD` points at in repositories simulated by `mockExec`.
 */
export const HEAD = '0123456789abcdef0123456789abcdef01234567';

/**
 * A command executor that records its calls and optionally fails. It answers
 * the git queries the plugin makes: `HEAD` is `HEAD`, and a tag lookup
 * succeeds only for the tags that already exist.
 *
 * @param behaviour Called with each other command (program and arguments joined by spaces), and may throw to fail it.
 * @param existingTags Tags that already exist, each with the commit it points at.
 * @param remoteTags Tags on the remote, each with the commit it points at.
 * @returns A mock usable wherever an `ExecFn` is expected.
 */
export function mockExec(
  behaviour: (cmd: string) => void = () => undefined,
  existingTags: Readonly<Record<string, string>> = {},
  remoteTags: Readonly<Record<string, string>> = {},
): jest.Mock<ExecFn> {
  const lookup = 'git rev-parse -q --verify refs/tags/';
  return jest.fn<ExecFn>((file, args) => {
    const cmd = [file, ...args].join(' ');
    if (cmd === 'git rev-parse HEAD') return HEAD;
    if (cmd === 'git ls-remote --tags origin') {
      return Object.entries(remoteTags)
        .map(([tag, commit]) => `${commit}\trefs/tags/${tag}`)
        .join('\n');
    }
    if (cmd.startsWith(lookup)) {
      const tag = cmd.slice(lookup.length).replace(/\^\{commit\}$/, '');
      const commit = Object.hasOwn(existingTags, tag)
        ? existingTags[tag]
        : undefined;
      if (commit === undefined) throw exitedWith(1);
      return commit;
    }
    behaviour(cmd);
    return '';
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
