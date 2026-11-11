/**
 * @file The semantic-release lifecycle steps for a multi-module Go repository:
 * verifying preconditions, pinning submodule requires, and tagging modules.
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { GitRepository } from './git.js';
import { GoModule } from './gomod.js';
import {
  cwdOf,
  resolveConfig,
  type GomodPluginConfig,
} from './plugin-config.js';
import { Release } from './release.js';
import { messageOf } from './utils/error.js';
import { run, type Runner } from './utils/exec.js';
import { redactCredentials } from './utils/redact.js';

/**
 * A logger that says nothing. Skipped directories and empty patterns are
 * reported once, by `verifyConditions`, not again by every later step.
 */
const QUIET = { log: (): void => undefined, warn: (): void => undefined };

/**
 * Whether a file exists, without throwing when it does not.
 * @param file - Absolute path to the file.
 * @returns True when the file can be accessed.
 * @example
 * if (await exists('/repo/go.mod')) console.log('Found the root module.');
 */
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
/* eslint-disable jsdoc/check-tag-names -- @rejects is required by jsdoc/require-rejects but is not in the plugin tag list; preset fix needed */

/**
 * Verify that all preconditions for the plugin are met:
 * - A root `go.mod` exists in the working directory.
 * - `git` is available on PATH.
 * - Every module directory can be used in a git tag.
 *
 * An informational message (not an error) is logged when no submodule go.mod
 * files are found, since the plugin is still useful for single-module repos
 * (it will create the root tag in the publish step).
 * @param pluginConfig - The plugin configuration.
 * @param context - The semantic-release context.
 * @param runner - Program runner (injectable for testing).
 * @throws SemanticReleaseError `EMISSINGGOMOD` when the root go.mod is missing.
 * @rejects SemanticReleaseError `EMISSINGGOMOD` when the root go.mod is missing,
 * or when git or a module tag is unusable.
 * @example
 * await verifyConditions({ modules: 'assert/**\/go.mod' }, context);
 */
export async function verifyConditions(
  pluginConfig: GomodPluginConfig,
  context: VerifyConditionsContext,
  runner: Runner = run,
): Promise<void> {
  const { logger } = context;
  const cwd = cwdOf(context);
  const config = resolveConfig(pluginConfig);

  const rootGoMod = path.join(cwd, 'go.mod');
  if (!(await exists(rootGoMod))) {
    throw new SemanticReleaseError(
      'go.mod not found.',
      'EMISSINGGOMOD',
      `A \`go.mod\` file is required at the repository root but was not found in ${cwd}. Ensure the plugin is configured for a Go module repository.`,
    );
  }

  const repository = GitRepository.open({ cwd, run: runner });
  await repository.version();

  const submodules = await GoModule.discover(cwd, config.modules, logger);
  // A directory git cannot tag is found now, not after the release commit.
  const modules = [GoModule.open(rootGoMod), ...submodules];
  await Release.check(
    modules.map((module) => repository.tag(module.tagName(cwd, '0.0.0'))),
  );
  if (submodules.length === 0) {
    logger.log(
      'No submodule go.mod files found — operating in single-module mode.',
    );
  } else {
    logger.log('Found %d submodule(s).', submodules.length);
  }
}
/* eslint-enable jsdoc/check-tag-names -- @rejects is required by jsdoc/require-rejects but is not in the plugin tag list; preset fix needed */
/* eslint-disable jsdoc/check-tag-names -- @rejects is required by jsdoc/require-rejects but is not in the plugin tag list; preset fix needed */

/**
 * Pin every submodule `go.mod` require line that references the root
 * module (or any of its sub-paths) to the new release version.
 *
 * Optionally runs `go mod tidy` in each submodule directory afterward.
 * The actual commit is handled by `@semantic-release/git`.
 * @param pluginConfig - The plugin configuration.
 * @param context - The semantic-release context.
 * @param runner - Program runner (injectable for testing).
 * @throws SemanticReleaseError `ETAGMISMATCH` or `EINVALIDTAG` when a tag is unusable.
 * @rejects SemanticReleaseError `ETAGMISMATCH` or `EINVALIDTAG` when a tag is unusable.
 * @example
 * await prepare({ skipGoModTidy: true }, context);
 */
export async function prepare(
  pluginConfig: GomodPluginConfig,
  context: PrepareContext,
  runner: Runner = run,
): Promise<void> {
  const {
    logger,
    nextRelease: { version },
  } = context;
  const cwd = cwdOf(context);
  const config = resolveConfig(pluginConfig);

  const root = GoModule.open(path.join(cwd, 'go.mod'), { run: runner });
  const rootModule = await root.modulePath();
  logger.log('Root module: %s', rootModule);

  const submodules = await GoModule.discover(cwd, config.modules, QUIET, {
    run: runner,
  });
  // Stop before any file is rewritten if a tag cannot be created later.
  const repository = GitRepository.open({ cwd, run: runner });
  await Release.plan(
    repository,
    [root, ...submodules].map((module) =>
      repository.tag(module.tagName(cwd, version)),
    ),
    config.pushTags,
  );
  if (submodules.length === 0) {
    logger.log('No submodules to update.');
    return;
  }

  for (const submodule of submodules) {
    logger.log('Pinning requires in %s', path.relative(cwd, submodule.file));
    await submodule.pin(rootModule, version);

    if (config.skipGoModTidy) continue;
    const directory = path.relative(cwd, path.dirname(submodule.file));
    try {
      await submodule.tidy();
      logger.log('go mod tidy OK in %s', directory);
    } catch (error: unknown) {
      logger.warn(
        'go mod tidy failed in %s: %s',
        directory,
        redactCredentials(messageOf(error)),
      );
    }
  }

  logger.log('Prepared %d submodule(s) for v%s.', submodules.length, version);
}
/* eslint-enable jsdoc/check-tag-names -- @rejects is required by jsdoc/require-rejects but is not in the plugin tag list; preset fix needed */
/* eslint-disable jsdoc/check-tag-names -- @rejects is required by jsdoc/require-rejects but is not in the plugin tag list; preset fix needed */

/**
 * Create and push a git tag for every module in the repository,
 * including the root module.
 *
 * Semantic-release creates the root tag (`vX.Y.Z`) before calling
 * publish; this step skips it when it already exists at `HEAD` and then
 * creates all submodule tags (e.g. `assert/cert/manager/vX.Y.Z`).
 * @param pluginConfig - The plugin configuration.
 * @param context - The semantic-release context.
 * @param runner - Program runner (injectable for testing).
 * @throws SemanticReleaseError `ETAGMISMATCH` or `EINVALIDTAG` when a tag is unusable.
 * @rejects SemanticReleaseError `ETAGMISMATCH` or `EINVALIDTAG` when a tag is unusable,
 * or when git fails to create or push a tag.
 * @example
 * await publish({ pushTags: true }, context);
 */
export async function publish(
  pluginConfig: GomodPluginConfig,
  context: PublishContext,
  runner: Runner = run,
): Promise<void> {
  const {
    logger,
    nextRelease: { version },
  } = context;
  const cwd = cwdOf(context);
  const config = resolveConfig(pluginConfig);

  const submodules = await GoModule.discover(cwd, config.modules, QUIET);
  const modules = [GoModule.open(path.join(cwd, 'go.mod')), ...submodules];
  // Validate every tag before the first one is created or pushed.
  const repository = GitRepository.open({ cwd, run: runner });
  const release = await Release.plan(
    repository,
    modules.map((module) => repository.tag(module.tagName(cwd, version))),
    config.pushTags,
  );
  await release.publish(logger);

  logger.log('Tagged %d module(s) at v%s.', modules.length, version);
}
/* eslint-enable jsdoc/check-tag-names -- @rejects is required by jsdoc/require-rejects but is not in the plugin tag list; preset fix needed */

export default { verifyConditions, prepare, publish } as const;
