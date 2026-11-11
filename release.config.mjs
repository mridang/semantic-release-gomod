/**
 * @file Semantic-release configuration: the plugins that analyse, document,
 * tag and publish a release of this package.
 */

import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  // eslint-disable-next-line n/no-sync -- sync is fine in a config file read once at startup
  readFileSync(new URL('package.json', import.meta.url), 'utf8'),
);

export default {
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/npm',
      {
        npmPublish: true,
        pkgRoot: '.',
        tarballDir: '.',
        access: 'public',
      },
    ],
    [
      '@semantic-release/github',
      {
        assets: [{ path: '*.tgz', label: 'Package' }],
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'package-lock.json'],
        message:
          'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
  repositoryUrl: packageJson.repository.url,
};
