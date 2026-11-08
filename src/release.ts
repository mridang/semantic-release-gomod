import SemanticReleaseError from '@semantic-release/error';
import type { GitRepository, Tag } from './git.js';
import type { StepLogger } from './plugin-config.js';

/**
 * A tag of a release, and whether it already exists at `HEAD`.
 */
interface PlannedTag {
  readonly tag: Tag;
  readonly exists: boolean;
}

/**
 * The tags a release will create and push, checked before any of them is
 * touched so that a bad one cannot leave the release half published.
 */
export class Release {
  private readonly planned: readonly PlannedTag[];
  private readonly push: boolean;

  private constructor(planned: readonly PlannedTag[], push: boolean) {
    this.planned = planned;
    this.push = push;
  }

  /**
   * Refuse tag names git would reject, so a bad directory name stops the
   * release before anything is changed. Run it as early as the lifecycle
   * allows: once semantic-release has pushed the release commit and the root
   * tag, a later failure leaves a half published release.
   *
   * @param repository The repository.
   * @param names      Every tag name the release will create.
   * @throws SemanticReleaseError `EINVALIDTAG` listing every refused name.
   */
  static async check(
    repository: GitRepository,
    names: readonly string[],
  ): Promise<void> {
    const valid = await Promise.all(
      names.map((name) => repository.isValidTagName(name)),
    );
    const invalid = names.filter((_name, index) => !valid[index]);
    if (invalid.length === 0) return;
    throw new SemanticReleaseError(
      `Cannot create tag(s) git rejects: ${invalid.join(', ')}.`,
      'EINVALIDTAG',
      'A tag is the module directory plus the version, so rename the directory. Git refuses a tag with a space, `~`, `^`, `:`, `?`, `*`, `[`, `\\`, `..` or `@{`, a component that starts with `.` or ends with `.lock`, a trailing `.` or `/`, and a name starting with `-`. The `modules` option only lists modules to include (there is no exclusion syntax), so to leave a directory out, list the other modules explicitly.',
    );
  }

  /**
   * Plan a release: check the names, then compare every existing tag, local
   * or (when pushing) on the remote, with `HEAD`. A tag at another commit
   * would publish old code under the new version, so it stops the release;
   * a tag at `HEAD` is left as it is, so a re-run is safe.
   *
   * @param repository The repository.
   * @param names      Every tag name the release will create.
   * @param push       Whether the tags will be pushed, so the remote is read.
   * @returns The release, ready to publish.
   * @throws SemanticReleaseError `EINVALIDTAG` or `ETAGMISMATCH`.
   */
  static async plan(
    repository: GitRepository,
    names: readonly string[],
    push: boolean,
  ): Promise<Release> {
    await Release.check(repository, names);
    const head = await repository.head();
    const remote = push
      ? await repository.remoteTags()
      : new Map<string, string>();
    const found = await Promise.all(
      names.map(async (name) => {
        const tag = repository.tag(name);
        return { tag, local: await tag.commit(), remote: remote.get(name) };
      }),
    );
    const stale = found.flatMap(({ tag, local, remote: onRemote }) => {
      const problems: string[] = [];
      if (local !== undefined && local !== head) {
        problems.push(`${tag.name} (${local})`);
      }
      if (onRemote !== undefined && onRemote !== head) {
        problems.push(`${tag.name} on origin (${onRemote})`);
      }
      return problems;
    });
    if (stale.length > 0) {
      throw new SemanticReleaseError(
        `Tag(s) already exist at another commit than HEAD (${head}): ${stale.join(', ')}.`,
        'ETAGMISMATCH',
        'Pushing them would publish old code under this version. Delete the stale tag(s) locally (`git tag -d <tag>`) and on the remote if they were pushed, or release a new version.',
      );
    }
    return new Release(
      found.map(({ tag, local }) => ({ tag, exists: local !== undefined })),
      push,
    );
  }

  /**
   * Create each missing tag and, when pushing, push every tag (one push per
   * tag), one after the other.
   *
   * @param logger semantic-release logger.
   * @returns The tags of the release.
   */
  async publish(logger: Pick<StepLogger, 'log'>): Promise<readonly Tag[]> {
    for (const { tag, exists } of this.planned) {
      if (exists) {
        logger.log('Tag %s already exists, skipping', tag.name);
      } else {
        await tag.create();
        logger.log('Created tag %s', tag.name);
      }
      if (this.push) {
        await tag.push();
        logger.log('Pushed tag %s', tag.name);
      }
    }
    return this.planned.map(({ tag }) => tag);
  }
}
