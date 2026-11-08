import SemanticReleaseError from '@semantic-release/error';
import type { Config } from 'semantic-release';

/**
 * Raw plugin configuration as provided by the user in their
 * semantic-release config file. All fields are optional — the
 * plugin works with zero configuration by auto-detecting all
 * submodule go.mod files in the repository.
 */
export interface GomodPluginConfig extends Config {
  /**
   * Glob patterns (relative to cwd) that match submodule go.mod files.
   * When omitted, the plugin walks the repository and treats every
   * go.mod file except the root-level one as a submodule.
   *
   * @example ["assert/**\/go.mod", "env/**\/go.mod"]
   */
  readonly modules?: string | readonly string[];

  /**
   * Skip running `go mod tidy` in each submodule directory after
   * pinning the require version. Useful when Go is not available in
   * the CI environment or for debugging. Defaults to false.
   */
  readonly skipGoModTidy?: boolean;

  /**
   * Push the created submodule tags to the remote origin after
   * creating them locally. Set to false to create tags locally only.
   * Defaults to true.
   */
  readonly pushTags?: boolean;
}

/**
 * The plugin options with their defaults applied, so the lifecycle steps read
 * plain values instead of repeating the defaulting rules.
 */
export interface ResolvedConfig {
  /**
   * Glob patterns for submodule go.mod files, or undefined to auto-discover.
   */
  readonly modules: readonly string[] | undefined;

  /**
   * True only when `skipGoModTidy` is explicitly set to true.
   */
  readonly skipGoModTidy: boolean;

  /**
   * True unless `pushTags` is explicitly set to false.
   */
  readonly pushTags: boolean;
}

/**
 * Apply the defaults to the user-supplied options. A single glob string is
 * normalised to an array, and an unset or `null` `modules` stays undefined,
 * which signals the plugin to auto-discover. `null` (as config files such as
 * JSON and YAML write it) counts as unset for every option with a default, and
 * so does any other falsy `modules`.
 *
 * @param config The plugin configuration.
 * @returns The resolved options.
 * @throws SemanticReleaseError `EINVALIDMODULES` when `modules` is neither a
 * string nor an array of strings.
 */
export function resolveConfig(config: GomodPluginConfig): ResolvedConfig {
  const modules: unknown = config.modules;
  return {
    modules: resolveModules(modules),
    skipGoModTidy: config.skipGoModTidy === true,
    pushTags: config.pushTags !== false,
  };
}

/**
 * Check and normalise the `modules` option.
 *
 * @param modules The raw option value.
 * @returns The glob patterns, or undefined to auto-discover.
 * @throws SemanticReleaseError `EINVALIDMODULES` for any other type.
 */
function resolveModules(modules: unknown): readonly string[] | undefined {
  // Any falsy value (undefined, null, false, 0, '') means "not configured".
  if (!modules) return undefined;
  if (typeof modules === 'string') return [modules];
  if (
    Array.isArray(modules) &&
    modules.every((pattern): pattern is string => typeof pattern === 'string')
  ) {
    return modules;
  }
  throw new SemanticReleaseError(
    "Option 'modules' must be a glob string or an array of glob strings.",
    'EINVALIDMODULES',
    'Set `modules` to a pattern such as "assert/**/go.mod", or a list of them, or remove it to detect submodules automatically.',
  );
}
