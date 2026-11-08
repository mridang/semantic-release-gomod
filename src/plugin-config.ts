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
 * string nor an array of strings, or `EINVALIDSKIPGOMODTIDY` and
 * `EINVALIDPUSHTAGS` when those options are not booleans.
 */
export function resolveConfig(config: GomodPluginConfig): ResolvedConfig {
  const modules: unknown = config.modules;
  return {
    modules: resolveModules(modules),
    skipGoModTidy: resolveFlag(
      'skipGoModTidy',
      'EINVALIDSKIPGOMODTIDY',
      config.skipGoModTidy,
      false,
    ),
    pushTags: resolveFlag(
      'pushTags',
      'EINVALIDPUSHTAGS',
      config.pushTags,
      true,
    ),
  };
}

/**
 * Check a boolean option. `undefined` and `null` take the default. The
 * spellings a config file or an environment variable easily produces are
 * accepted too: the strings `"true"` and `"false"` in any case, and `1` and
 * `0`.
 *
 * @param name The option name, for the error.
 * @param code The error code to throw for a value that is none of these.
 * @param value The raw option value.
 * @param fallback The value when the option is not set.
 * @returns The option as a boolean.
 * @throws SemanticReleaseError with `code` for any other value.
 */
function resolveFlag(
  name: string,
  code: string,
  value: unknown,
  fallback: boolean,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (word === 'true') return true;
    if (word === 'false') return false;
  }
  throw new SemanticReleaseError(
    `Option '${name}' must be true or false.`,
    code,
    `Use a boolean such as \`${name}: ${String(!fallback)}\`, not the ${typeof value} ${JSON.stringify(value)}.`,
  );
}

/**
 * Whether a glob pattern uses only what the matcher supports: literal names,
 * and `*` or `**` as a whole segment, without leaving the repository.
 *
 * @param pattern A glob pattern using `/` separators.
 * @returns True when every segment is supported.
 */
function isSupportedPattern(pattern: string): boolean {
  return pattern
    .split('/')
    .every(
      (segment) =>
        segment !== '..' &&
        (segment === '*' || segment === '**' || !/[*?[\]{}]/.test(segment)),
    );
}

/**
 * Reject glob patterns the matcher would silently treat as literal names.
 *
 * @param patterns The glob patterns.
 * @returns The same patterns.
 * @throws SemanticReleaseError `EINVALIDMODULES` listing the unsupported ones.
 */
function checkPatterns(patterns: readonly string[]): readonly string[] {
  const unsupported = patterns.filter((p) => !isSupportedPattern(p));
  if (unsupported.length > 0) {
    throw new SemanticReleaseError(
      `Option 'modules' has unsupported glob pattern(s): ${unsupported.join(', ')}.`,
      'EINVALIDMODULES',
      'Only literal names and whole-segment `*` and `**` wildcards are supported (for example "assert/**/go.mod" or "services/*/go.mod"), and a pattern must not use `..` to leave the repository. `?`, `[...]`, `{a,b}` and partial wildcards such as "svc-*" are not supported.',
    );
  }
  return patterns;
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
  if (typeof modules === 'string') return checkPatterns([modules]);
  if (
    Array.isArray(modules) &&
    modules.every((pattern): pattern is string => typeof pattern === 'string')
  ) {
    return checkPatterns(modules);
  }
  throw new SemanticReleaseError(
    "Option 'modules' must be a glob string or an array of glob strings.",
    'EINVALIDMODULES',
    'Set `modules` to a pattern such as "assert/**/go.mod", or a list of them, or remove it to detect submodules automatically.',
  );
}
