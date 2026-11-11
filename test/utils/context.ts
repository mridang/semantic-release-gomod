import { jest } from '@jest/globals';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { GitRepository, type Tag } from '../../src/git.js';
import type { Runner } from '../../src/utils/exec.js';
import type { GomodPluginConfig } from '../../src/plugin-config.js';
import { recordingLogger } from './logger.js';

/**
 * The error a program throws when it exits with a status.
 * @param status - The exit status; git answers a yes/no question with 1.
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
 * @param behaviour - Called with each other command (program and arguments joined by spaces), and may throw to fail it.
 * @param existingTags - Tags that already exist, each with the commit it points at.
 * @param remoteTags - Tags on the remote, each with the commit it points at.
 * @returns A mock usable wherever an `Runner` is expected.
 */
export function mockExec(
  behaviour: (cmd: string) => void = () => undefined,
  existingTags: Readonly<Record<string, string>> = {},
  remoteTags: Readonly<Record<string, string>> = {},
): jest.Mock<Runner> {
  const lookup = 'git rev-parse -q --verify refs/tags/';
  return jest.fn<Runner>(async (file, args) => {
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
 * A repository at `/repo` whose programs run through a fake runner.
 * @param run - The fake runner, usually from `mockExec`.
 * @returns The repository.
 */
export function repoWith(run: Runner): GitRepository {
  return GitRepository.open({ cwd: '/repo', run });
}

/**
 * Tags of a repository, by name.
 * @param repository - The repository.
 * @param names - The tag names.
 * @returns A tag for each name, in order.
 */
export function tagsOf(
  repository: GitRepository,
  names: readonly string[],
): readonly Tag[] {
  return names.map((name) => repository.tag(name));
}

/**
 * The commands an executor was asked to run, each as one string.
 * @param exec - A mock made by `mockExec`.
 * @returns The program and arguments of each call, joined by spaces.
 */
export function commandsOf(exec: jest.Mock<Runner>): readonly string[] {
  return exec.mock.calls.map(([file, args]) => [file, ...args].join(' '));
}

/**
 * Build the semantic-release context a step receives. The real context has
 * dozens of members (streams, branches, commits) that the plugin never reads,
 * so this is the single place in the tests that builds it from the few it
 * does, and the only place that needs a cast.
 * @param cwd - The repository directory.
 * @param version - The version being released.
 * @returns The context, typed for each step, and the lines logged through it.
 */
export function stepContext(
  cwd: string,
  version = '1.2.3',
): {
  readonly lines: string[];
  readonly verify: VerifyConditionsContext;
  readonly prepare: PrepareContext;
  readonly publish: PublishContext;
} {
  const { logger, lines } = recordingLogger();
  const partial: unknown = { logger, cwd, nextRelease: { version } };
  return {
    lines,
    verify: partial as VerifyConditionsContext,
    prepare: partial as PrepareContext,
    publish: partial as PublishContext,
  };
}

/**
 * A plugin config with values of any type, as a config file can contain.
 * @param options - The raw option values.
 * @returns The same object, typed as a plugin config.
 */
export function rawConfig(
  options: Readonly<Record<string, unknown>>,
): GomodPluginConfig {
  return options;
}
