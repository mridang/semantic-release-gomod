/**
 * @file Jest global teardown, run once after the whole test suite finishes.
 */

/**
 * Release anything the whole test run shared. No external services are used.
 * @returns A promise that resolves once the teardown is done.
 * @example
 * // Registered as `globalTeardown` in jest.config.mjs; Jest calls it once.
 */
export default async function teardown(): Promise<void> {
  // Nothing to tear down: the suite used no external services.
}
