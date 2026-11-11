/**
 * @file A logger for tests that records every line it is given.
 */

/**
 * A semantic-release style logger that records everything written to it.
 * @returns The logger and the lines it has received.
 * @example
 * const { logger, lines } = recordingLogger();
 * logger.log('Tagged %s', 'v1.2.3'); // lines: ['Tagged %s v1.2.3']
 */
export function recordingLogger(): {
  logger: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  lines: string[];
} {
  const lines: string[] = [];
  const write = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  return { logger: { log: write, warn: write }, lines };
}
