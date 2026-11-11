/**
 * @file Jest global setup, run once before the whole test suite starts.
 */

/**
 * Prepare anything the whole test run shares. No external services are needed.
 * @returns A promise that resolves once the setup is done.
 * @example
 * // Registered as `globalSetup` in jest.config.mjs; Jest calls it once.
 */
export default async function setup(): Promise<void> {
  // Nothing to prepare: the suite needs no external services.
}
