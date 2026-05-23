import * as fs from 'fs';
import * as path from 'path';
// @ts-expect-error semantic-release types are not bundled
import { Context } from 'semantic-release';
import SemanticReleaseError from '@semantic-release/error';
import { defaultExec, type ExecFn } from './exec.js';
import { GomodConfig, GomodPluginConfig } from './plugin-config.js';
import {
  createAndPushTag,
  deriveTagPrefix,
  discoverSubmoduleGoMods,
  readModulePath,
  updateGoModRequires,
} from './gomod.js';

/**
 * Verify that all preconditions for the plugin are met:
 *  - A root `go.mod` exists in the working directory.
 *  - `git` is available on PATH.
 *
 * A warning (not an error) is emitted when no submodule go.mod files
 * are found, since the plugin is still useful for single-module repos
 * (it will create the root tag in the publish step).
 *
 * @param pluginConfig The plugin configuration.
 * @param context      The semantic-release context.
 * @param exec         Command executor (injectable for testing).
 */
export async function verifyConditions(
  pluginConfig: GomodPluginConfig,
  context: Context,
  exec: ExecFn = defaultExec,
): Promise<void> {
  const { logger, cwd } = context;
  const config = new GomodConfig(pluginConfig);

  const rootGoMod = path.join(cwd, 'go.mod');
  if (!fs.existsSync(rootGoMod)) {
    throw new SemanticReleaseError(
      'go.mod not found.',
      'EMISSINGGOMOD',
      `A \`go.mod\` file is required at the repository root but was not found in ${cwd}. Ensure the plugin is configured for a Go module repository.`,
    );
  }

  try {
    exec('git --version', { stdio: 'pipe' });
  } catch {
    throw new SemanticReleaseError(
      'git is not available.',
      'ENOGIT',
      'The `git` executable could not be found. Ensure git is installed and available on PATH.',
    );
  }

  const submodules = discoverSubmoduleGoMods(cwd, config.getModules());
  if (submodules.length === 0) {
    logger.log(
      'No submodule go.mod files found — operating in single-module mode.',
    );
  } else {
    logger.log('Found %d submodule(s).', submodules.length);
  }
}

/**
 * Pin every submodule `go.mod` require line that references the root
 * module (or any of its sub-paths) to the new release version.
 *
 * Optionally runs `go mod tidy` in each submodule directory afterward.
 * The actual commit is handled by `@semantic-release/git`.
 *
 * @param pluginConfig The plugin configuration.
 * @param context      The semantic-release context.
 * @param exec         Command executor (injectable for testing).
 */
export async function prepare(
  pluginConfig: GomodPluginConfig,
  context: Context,
  exec: ExecFn = defaultExec,
): Promise<void> {
  const {
    logger,
    cwd,
    nextRelease: { version },
  } = context;
  const config = new GomodConfig(pluginConfig);

  const rootGoMod = path.join(cwd, 'go.mod');
  const rootModule = readModulePath(rootGoMod);
  logger.log('Root module: %s', rootModule);

  const submodules = discoverSubmoduleGoMods(cwd, config.getModules());
  if (submodules.length === 0) {
    logger.log('No submodules to update.');
    return;
  }

  for (const goModPath of submodules) {
    logger.log('Pinning requires in %s', path.relative(cwd, goModPath));
    updateGoModRequires(goModPath, rootModule, version);

    if (!config.isSkipGoModTidy()) {
      const modDir = path.dirname(goModPath);
      try {
        exec('go mod tidy', { cwd: modDir, stdio: 'pipe' });
        logger.log('go mod tidy OK in %s', path.relative(cwd, modDir));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          'go mod tidy failed in %s: %s',
          path.relative(cwd, modDir),
          msg,
        );
      }
    }
  }

  logger.log('Prepared %d submodule(s) for v%s.', submodules.length, version);
}

/**
 * Create and push a git tag for every module in the repository,
 * including the root module.
 *
 * semantic-release creates the root tag (`vX.Y.Z`) before calling
 * publish; this step creates it silently when it already exists and
 * then creates all submodule tags
 * (e.g. `assert/cert/manager/vX.Y.Z`).
 *
 * @param pluginConfig The plugin configuration.
 * @param context      The semantic-release context.
 * @param exec         Command executor (injectable for testing).
 */
export async function publish(
  pluginConfig: GomodPluginConfig,
  context: Context,
  exec: ExecFn = defaultExec,
): Promise<void> {
  const {
    logger,
    cwd,
    nextRelease: { version },
  } = context;
  const config = new GomodConfig(pluginConfig);

  // All go.mod files: submodules + root
  const submodules = discoverSubmoduleGoMods(cwd, config.getModules());
  const allGoMods: readonly string[] = [
    path.join(cwd, 'go.mod'),
    ...submodules,
  ];

  for (const goModPath of allGoMods) {
    const prefix = deriveTagPrefix(goModPath, cwd);
    const tag = prefix ? `${prefix}/v${version}` : `v${version}`;
    createAndPushTag(cwd, tag, config.isPushTagsEnabled(), logger, exec);
  }

  logger.log('Tagged %d module(s) at v%s.', allGoMods.length, version);
}

export default { verifyConditions, prepare, publish } as const;
