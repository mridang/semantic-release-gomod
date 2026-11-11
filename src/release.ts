import SemanticReleaseError from '@semantic-release/error';
import type { GitRepository, Tag } from './git.js';
import type { StepLogger } from './plugin-config.js';

/**
 * A tag of a release, and what is already done for it.
 */
interface PlannedTag {
  /** The tag. */
  readonly tag: Tag;
  /** True when it already exists locally at `HEAD`. */
  readonly exists: boolean;
  /** True when it already exists on `origin` at `HEAD`. */
  readonly onRemote: boolean;
}

/**
 * Run an asynchronous step for each item, one after the other, so that no
 * more than one child process runs at a time.
 * @param items - The items.
 * @param step - The step for one item.
 * @returns What the steps returned, in order.
 */
function sequentially<T, R>(
  items: readonly T[],
  step: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  return items.reduce<Promise<readonly R[]>>(
    async (done, item) => [...(await done), await step(item)],
    Promise.resolve([]),
  );
}

/**
 * The tags a release will create and push, checked before any of them is
 * touched so that a bad one cannot leave the release half published.
 */
export class Release {
  /** The tags, and what is already done for each. */
  private readonly planned: readonly PlannedTag[];
  /** Whether the tags are pushed to `origin`. */
  private readonly push: boolean;

  /**
   * @param planned - The tags, and what is already done for each.
   * @param push - Whether the tags are pushed to `origin`.
   */
  private constructor(planned: readonly PlannedTag[], push: boolean) {
    this.planned = planned;
    this.push = push;
  }

  /**
   * Refuse tag names git would reject, so a bad directory name stops the
   * release before anything is changed. Run it as early as the lifecycle
   * allows: once semantic-release has pushed the release commit and the root
   * tag, a later failure leaves a half published release.
   * @param tags - Every tag the release will create.
   * @throws SemanticReleaseError `EINVALIDTAG` listing every refused name.
   */
  static async check(tags: readonly Tag[]): Promise<void> {
    const valid = await sequentially(tags, (tag) => tag.isValid());
    const invalid = tags.filter((_tag, index) => !valid[index]);
    if (invalid.length === 0) return;
    throw new SemanticReleaseError(
      `Cannot create tag(s) git rejects: ${invalid.map((tag) => tag.name).join(', ')}.`,
      'EINVALIDTAG',
      'A tag is the module directory plus the version, so rename the directory. Git refuses a tag with a space, `~`, `^`, `:`, `?`, `*`, `[`, `\\`, `..` or `@{`, a component that starts with `.` or ends with `.lock`, a trailing `.` or `/`, and a name starting with `-`. The `modules` option only lists modules to include (there is no exclusion syntax), so to leave a directory out, list the other modules explicitly.',
    );
  }

  /**
   * Plan a release: check the names, then compare every existing tag, local
   * or (when pushing) on the remote, with `HEAD`. A tag at another commit
   * would publish old code under the new version, so it stops the release;
   * a tag at `HEAD` is left as it is, so a re-run is safe.
   * @param repository - The repository.
   * @param tags - Every tag the release will create.
   * @param push - Whether the tags will be pushed, so the remote is read.
   * @returns The release, ready to publish.
   * @throws SemanticReleaseError `EINVALIDTAG` or `ETAGMISMATCH`.
   */
  static async plan(
    repository: GitRepository,
    tags: readonly Tag[],
    push: boolean,
  ): Promise<Release> {
    await Release.check(tags);
    const head = await repository.head();
    const remote = push
      ? await repository.remoteTags()
      : new Map<string, string>();
    const found = await sequentially(tags, async (tag) => ({
      tag,
      local: await tag.commit(),
      remote: remote.get(tag.name),
    }));
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
      found.map(({ tag, local, remote: onRemote }) => ({
        tag,
        exists: local !== undefined,
        onRemote: onRemote === head,
      })),
      push,
    );
  }

  /**
   * Create each missing tag and, when pushing, push every tag (one push per
   * tag), one after the other. A tag that is already on `origin` at `HEAD`
   * is neither created nor pushed again, because its object (for example an
   * annotated tag made elsewhere) would differ and the push be rejected.
   * @param logger - Semantic-release logger.
   * @returns The tags of the release.
   */
  async publish(logger: Pick<StepLogger, 'log'>): Promise<readonly Tag[]> {
    for (const { tag, exists, onRemote } of this.planned) {
      if (onRemote && this.push) {
        logger.log('Tag %s already on origin, skipping', tag.name);
        continue;
      }
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
