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
  readonly modules?: string | string[];

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
 * GomodConfig wraps the raw plugin config and exposes derived values
 * with sensible defaults. It centralises option reading so the plugin
 * lifecycle hooks stay small and consistent.
 */
export class GomodConfig {
  private readonly config: GomodPluginConfig;

  constructor(config: GomodPluginConfig) {
    this.config = config;
  }

  /**
   * Returns the user-supplied glob patterns for submodule go.mod files,
   * normalised to an array. Returns undefined when not configured,
   * which signals the plugin to auto-discover.
   *
   * @returns Array of glob strings, or undefined for auto-detection.
   */
  getModules(): string[] | undefined {
    const { modules } = this.config;
    if (!modules) return undefined;
    if (typeof modules === 'string') return [modules];
    return modules;
  }

  /**
   * Whether to skip `go mod tidy` after pinning submodule versions.
   *
   * @returns true only when explicitly set to true.
   */
  isSkipGoModTidy(): boolean {
    return this.config.skipGoModTidy === true;
  }

  /**
   * Whether to push submodule tags to origin after creating them.
   *
   * @returns true unless explicitly disabled.
   */
  isPushTagsEnabled(): boolean {
    return this.config.pushTags !== false;
  }
}
