/**
 * @file Knip configuration: which files and dependencies are exempt from the
 * unused-code check.
 */

export default {
  ignore: ['knip.config.ts'],
  ignoreDependencies: [/^@semantic-release\//],
};
