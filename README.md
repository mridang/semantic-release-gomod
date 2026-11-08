# Semantic Release - Gomod

A [semantic-release](https://github.com/semantic-release/semantic-release)
plugin to automatically tag and release multi-module Go repositories.

This plugin automates the release workflow for Go monorepos that use the
multi-module pattern. During `prepare`, it pins every submodule `go.mod`
require line that references the root module to the new release version and
optionally runs `go mod tidy`. During `publish`, it creates and pushes a
per-module git tag for every `go.mod` in the repository, following the
standard `<subpath>/vX.Y.Z` naming that the Go module proxy requires. This
eliminates the need for manual tagging scripts, ensuring every module in
your monorepo is consistently released together.

## Why?

Releasing a multi-module Go repository involves more than just creating a
single Git tag. For each submodule to be resolvable by the Go module proxy
and `go get`, it must have its own version tag in the form
`<path>/vX.Y.Z` (e.g., `assert/cert/manager/v1.2.3`). Keeping require
lines pinned to the new version across all submodules adds further
complexity. This multi-step process is a common point of friction in an
otherwise automated pipeline.

Without this plugin, developers typically face one of two issues:

- **Manual Tagging:** The most common method is a shell script that walks
  the repository, updates require lines, and pushes tags for each `go.mod`.
  This adds toil, is error-prone, and is not reusable across projects.
- **Incomplete Automation:** Other tooling may create the root tag but
  skip submodule tags, leaving submodules unreachable via `go get` until
  someone manually creates the missing tags.

This plugin provides a lightweight and direct solution. It auto-discovers
every `go.mod` in the repository, pins inter-module dependencies to the
new version, and creates the correct per-module tag for each one — all
within a standard `semantic-release` pipeline with zero required
configuration.

## Installation

Install using NPM with the following command:

```sh
npm install --save-dev @mridang/semantic-release-gomod
```

## Usage

To use this plugin, add it to your semantic-release configuration file
(e.g., `.releaserc.js`, `release.config.js`, or in your `package.json`).

The plugin's `prepare` step pins require lines in submodule `go.mod` files.
For these changes to be included in the release commit, the plugin should be
placed **before** `@semantic-release/git` in the `plugins` array.

> [!IMPORTANT]
> This plugin updates `go.mod` files during the `prepare` step. For these
> changes to be included in your release commit, you **must** configure
> the `@semantic-release/git` plugin to include your `go.mod` and `go.sum`
> files in its `assets` array.

### Example Configuration (`.releaserc.js`)

```javascript
module.exports = {
  branches: ['main', 'next'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@mridang/semantic-release-gomod',
    '@semantic-release/release-notes-generator',
    '@semantic-release/github',
    [
      '@semantic-release/git',
      {
        assets: ['go.mod', 'go.sum', '**/go.mod', '**/go.sum'],
        message:
          'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
};
```

### Configuration Options

All options are case-sensitive and lowercased in the JSON configuration.

- **`modules` (string | string[], optional):**
  Glob patterns (relative to the repository root) matching submodule
  `go.mod` files. When omitted, the plugin auto-discovers every `go.mod`
  in the repository except the root-level one.
  Example: `["assert/**/go.mod", "env/**/go.mod"]`.
  Only literal names and whole-segment `*` (one directory) and `**` (any
  number of directories) wildcards are supported; `?`, `[...]`, `{a,b}`,
  partial wildcards such as `svc-*`, and `..` are rejected with
  `EINVALIDMODULES`. A pattern that matches nothing is reported with a
  warning. A value that is not set, `null` or `false` means
  auto-discovery.

  Which `go.mod` files are found: the root-level `go.mod` is never a
  submodule. Auto-discovery and wildcards do not search `.git`, `vendor` or
  `node_modules`, and each skipped `vendor` or `node_modules` directory is
  logged. Other dot-directories such as `.tools` are searched. Name a
  `go.mod` literally, such as `vendor/x/go.mod`, to include one in a skipped
  directory. Symlinked `go.mod` files are ignored. Go also ignores
  directories named `testdata` or starting with `_`; this plugin does not,
  so list the modules explicitly with `modules` if you have fixture modules
  there.

- **`skipGoModTidy` (boolean, optional):**
  Skip running `go mod tidy` in each submodule directory after pinning the
  require version. Useful when Go is not available in the CI environment or
  for debugging. Default: `false`. Must be a boolean.

- **`pushTags` (boolean, optional):**
  Push the created submodule tags to the remote origin after creating them
  locally. Set to `false` to create tags locally only. Default: `true`. Must be a boolean; a string such as `"false"` is rejected
  with `EINVALIDPUSHTAGS`.

## Tag Naming

The git tag created for each module is derived from the relative path of
its `go.mod` directory to the repository root:

| `go.mod` location              | Git tag                      |
| ------------------------------ | ---------------------------- |
| `./go.mod`                     | `v1.2.3`                     |
| `./assert/cert/manager/go.mod` | `assert/cert/manager/v1.2.3` |
| `./env/flux/helm/go.mod`       | `env/flux/helm/v1.2.3`       |

Every tag is checked before any is created or pushed. A directory name git
cannot use in a tag (spaces, `~`, `^`, `:`, a leading `-`, and so on) stops
the release with `EINVALIDTAG`, and a tag that already exists at another
commit than `HEAD` stops it with `ETAGMISMATCH`, because pushing it would
publish old code under the new version. A tag that already points at `HEAD`
is left as it is, so a re-run is safe.

## Known Issues

- None.

## Useful links

- **[Go Modules Reference](https://go.dev/ref/mod):** Official Go modules
  documentation.
- **[Module version numbering](https://go.dev/doc/modules/version-numbers):**
  How Go module version numbers work.

## Contributing

If you have suggestions for how this plugin could be improved, or
want to report a bug, open an issue — we'd love all and any
contributions.

## License

Apache License 2.0 © 2024 Mridang Agarwalla
