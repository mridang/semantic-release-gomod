import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { verifyConditions, prepare, publish } from '../src/index.js';
import type {
  VerifyConditionsContext,
  PrepareContext,
  PublishContext,
} from 'semantic-release';
import type { GomodPluginConfig } from '../src/plugin-config.js';
import type { ExecFn } from '../src/exec.js';
import {
  discoverSubmoduleGoMods,
  readModulePath,
  updateGoModRequires,
  deriveTagPrefix,
} from '../src/gomod.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(suffix: string): string {
  const dir = path.join(__dirname, `tmp-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeGoMod(
  dir: string,
  modulePath: string,
  requires: string[] = [],
): void {
  const requireBlock =
    requires.length > 0
      ? `\nrequire (\n${requires.map((r) => `\t${r}`).join('\n')}\n)\n`
      : '';
  fs.writeFileSync(
    path.join(dir, 'go.mod'),
    `module ${modulePath}\n\ngo 1.21\n${requireBlock}`,
  );
}

// ---------------------------------------------------------------------------
// discoverSubmoduleGoMods
// ---------------------------------------------------------------------------

describe('discoverSubmoduleGoMods()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('discover');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when only root go.mod exists', () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const result = discoverSubmoduleGoMods(tmpDir);
    expect(result).toEqual([]);
  });

  it('auto-detects submodule go.mod files', () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const subDir = path.join(tmpDir, 'pkg', 'foo');
    fs.mkdirSync(subDir, { recursive: true });
    writeGoMod(subDir, 'github.com/example/repo/pkg/foo');
    const result = discoverSubmoduleGoMods(tmpDir);
    expect(result).toEqual([path.join(subDir, 'go.mod')]);
  });

  it('respects glob patterns when provided', () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const assertDir = path.join(tmpDir, 'assert', 'foo');
    const envDir = path.join(tmpDir, 'env', 'bar');
    const otherDir = path.join(tmpDir, 'other', 'baz');
    fs.mkdirSync(assertDir, { recursive: true });
    fs.mkdirSync(envDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    writeGoMod(assertDir, 'github.com/example/repo/assert/foo');
    writeGoMod(envDir, 'github.com/example/repo/env/bar');
    writeGoMod(otherDir, 'github.com/example/repo/other/baz');

    const result = discoverSubmoduleGoMods(tmpDir, [
      'assert/**/go.mod',
      'env/**/go.mod',
    ]);
    expect(result).toContain(path.join(assertDir, 'go.mod'));
    expect(result).toContain(path.join(envDir, 'go.mod'));
    expect(result).not.toContain(path.join(otherDir, 'go.mod'));
  });

  it('skips vendor and node_modules directories', () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const vendorDir = path.join(tmpDir, 'vendor', 'pkg');
    fs.mkdirSync(vendorDir, { recursive: true });
    writeGoMod(vendorDir, 'github.com/example/vendored');
    const result = discoverSubmoduleGoMods(tmpDir);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readModulePath
// ---------------------------------------------------------------------------

describe('readModulePath()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('readmodule');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts the module path from a go.mod file', () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    expect(readModulePath(path.join(tmpDir, 'go.mod'))).toBe(
      'github.com/example/repo',
    );
  });

  it('throws if no module line is present', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'go 1.21\n');
    expect(() => readModulePath(path.join(tmpDir, 'go.mod'))).toThrow(
      /No module declaration/,
    );
  });
});

// ---------------------------------------------------------------------------
// updateGoModRequires
// ---------------------------------------------------------------------------

describe('updateGoModRequires()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('update');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces the version of a direct require', () => {
    writeGoMod(tmpDir, 'github.com/example/sub', [
      'github.com/example/repo v1.0.0',
    ]);
    updateGoModRequires(
      path.join(tmpDir, 'go.mod'),
      'github.com/example/repo',
      '2.0.0',
    );
    const content = fs.readFileSync(path.join(tmpDir, 'go.mod'), 'utf8');
    expect(content).toContain('github.com/example/repo v2.0.0');
    expect(content).not.toContain('v1.0.0');
  });

  it('preserves // indirect comments', () => {
    writeGoMod(tmpDir, 'github.com/example/sub', [
      'github.com/example/repo v1.0.0 // indirect',
    ]);
    updateGoModRequires(
      path.join(tmpDir, 'go.mod'),
      'github.com/example/repo',
      '2.0.0',
    );
    const content = fs.readFileSync(path.join(tmpDir, 'go.mod'), 'utf8');
    expect(content).toContain('github.com/example/repo v2.0.0 // indirect');
  });

  it('updates sub-path requires of the root module', () => {
    writeGoMod(tmpDir, 'github.com/example/sub', [
      'github.com/example/repo/pkg/foo v1.0.0',
    ]);
    updateGoModRequires(
      path.join(tmpDir, 'go.mod'),
      'github.com/example/repo',
      '2.0.0',
    );
    const content = fs.readFileSync(path.join(tmpDir, 'go.mod'), 'utf8');
    expect(content).toContain('github.com/example/repo/pkg/foo v2.0.0');
  });

  it('does not modify unrelated requires', () => {
    writeGoMod(tmpDir, 'github.com/example/sub', [
      'github.com/other/lib v3.0.0',
    ]);
    updateGoModRequires(
      path.join(tmpDir, 'go.mod'),
      'github.com/example/repo',
      '2.0.0',
    );
    const content = fs.readFileSync(path.join(tmpDir, 'go.mod'), 'utf8');
    expect(content).toContain('github.com/other/lib v3.0.0');
  });

  it('is a no-op when there is nothing to update', () => {
    writeGoMod(tmpDir, 'github.com/example/sub');
    const before = fs.readFileSync(path.join(tmpDir, 'go.mod'), 'utf8');
    updateGoModRequires(
      path.join(tmpDir, 'go.mod'),
      'github.com/example/repo',
      '2.0.0',
    );
    const after = fs.readFileSync(path.join(tmpDir, 'go.mod'), 'utf8');
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// deriveTagPrefix
// ---------------------------------------------------------------------------

describe('deriveTagPrefix()', () => {
  it('returns empty string for the root go.mod', () => {
    const root = '/repo';
    expect(deriveTagPrefix(path.join(root, 'go.mod'), root)).toBe('');
  });

  it('returns relative directory path for submodules', () => {
    const root = '/repo';
    expect(
      deriveTagPrefix(
        path.join(root, 'assert', 'cert', 'manager', 'go.mod'),
        root,
      ),
    ).toBe('assert/cert/manager');
  });
});

// ---------------------------------------------------------------------------
// verifyConditions()
// ---------------------------------------------------------------------------

describe('verifyConditions()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('verify');
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseCtx = () =>
    ({
      logger,
      cwd: tmpDir,
    }) as unknown as VerifyConditionsContext;

  it('passes when go.mod exists and git is available', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const mockExec = jest.fn() as unknown as ExecFn;
    await expect(
      verifyConditions({} as GomodPluginConfig, baseCtx(), mockExec),
    ).resolves.toBeUndefined();
  });

  it('throws EMISSINGGOMOD when go.mod is absent', async () => {
    await expect(
      verifyConditions({} as GomodPluginConfig, baseCtx()),
    ).rejects.toThrow(/go.mod not found/);
  });

  it('throws ENOGIT when git is not available', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const mockExec = jest.fn().mockImplementationOnce(() => {
      throw new Error('git not found');
    }) as unknown as ExecFn;
    await expect(
      verifyConditions({} as GomodPluginConfig, baseCtx(), mockExec),
    ).rejects.toThrow(/git is not available/);
  });

  it('logs a warning (not an error) when no submodules exist', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const mockExec = jest.fn() as unknown as ExecFn;
    await verifyConditions({} as GomodPluginConfig, baseCtx(), mockExec);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('single-module mode'),
    );
  });
});

// ---------------------------------------------------------------------------
// prepare()
// ---------------------------------------------------------------------------

describe('prepare()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('prepare');
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(version: string): PrepareContext {
    return {
      logger,
      cwd: tmpDir,
      nextRelease: { version },
    } as unknown as PrepareContext;
  }

  it('updates submodule requires to the new version', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    writeGoMod(subDir, 'github.com/example/repo/sub', [
      'github.com/example/repo v1.0.0',
    ]);

    await prepare(
      { skipGoModTidy: true } as GomodPluginConfig,
      makeCtx('2.0.0'),
      jest.fn() as unknown as ExecFn,
    );

    const content = fs.readFileSync(path.join(subDir, 'go.mod'), 'utf8');
    expect(content).toContain('github.com/example/repo v2.0.0');
  });

  it('runs go mod tidy by default', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    writeGoMod(subDir, 'github.com/example/repo/sub', [
      'github.com/example/repo v1.0.0',
    ]);

    const mockExec = jest.fn() as jest.Mock;
    await prepare(
      {} as GomodPluginConfig,
      makeCtx('2.0.0'),
      mockExec as unknown as ExecFn,
    );

    const tidyCalls = mockExec.mock.calls.filter((c) =>
      String(c[0]).includes('go mod tidy'),
    );
    expect(tidyCalls.length).toBe(1);
  });

  it('skips go mod tidy when skipGoModTidy is true', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    writeGoMod(subDir, 'github.com/example/repo/sub', [
      'github.com/example/repo v1.0.0',
    ]);

    const mockExec = jest.fn() as jest.Mock;
    await prepare(
      { skipGoModTidy: true } as GomodPluginConfig,
      makeCtx('2.0.0'),
      mockExec as unknown as ExecFn,
    );

    const tidyCalls = mockExec.mock.calls.filter((c) =>
      String(c[0]).includes('go mod tidy'),
    );
    expect(tidyCalls.length).toBe(0);
  });

  it('logs and continues when no submodules exist', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    await prepare(
      { skipGoModTidy: true } as GomodPluginConfig,
      makeCtx('2.0.0'),
      jest.fn() as unknown as ExecFn,
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('No submodules'),
    );
  });
});

// ---------------------------------------------------------------------------
// publish()
// ---------------------------------------------------------------------------

describe('publish()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir('publish');
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(version: string): PublishContext {
    return {
      logger,
      cwd: tmpDir,
      nextRelease: { version },
    } as unknown as PublishContext;
  }

  it('creates and pushes tags for root + all submodules', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');
    const subDir = path.join(tmpDir, 'pkg', 'foo');
    fs.mkdirSync(subDir, { recursive: true });
    writeGoMod(subDir, 'github.com/example/repo/pkg/foo');

    const mockExec = jest.fn() as jest.Mock;
    await publish(
      {} as GomodPluginConfig,
      makeCtx('1.2.3'),
      mockExec as unknown as ExecFn,
    );

    const tagCalls = mockExec.mock.calls
      .filter((c) => String(c[0]).startsWith('git tag'))
      .map((c) => String(c[0]));

    expect(tagCalls).toContain('git tag "v1.2.3"');
    expect(tagCalls).toContain('git tag "pkg/foo/v1.2.3"');
  });

  it('pushes tags when pushTags is true (default)', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');

    const mockExec = jest.fn() as jest.Mock;
    await publish(
      {} as GomodPluginConfig,
      makeCtx('1.2.3'),
      mockExec as unknown as ExecFn,
    );

    const pushCalls = mockExec.mock.calls.filter((c) =>
      String(c[0]).includes('git push origin'),
    );
    expect(pushCalls.length).toBeGreaterThan(0);
  });

  it('does not push tags when pushTags is false', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');

    const mockExec = jest.fn() as jest.Mock;
    await publish(
      { pushTags: false } as GomodPluginConfig,
      makeCtx('1.2.3'),
      mockExec as unknown as ExecFn,
    );

    const pushCalls = mockExec.mock.calls.filter((c) =>
      String(c[0]).includes('git push origin'),
    );
    expect(pushCalls.length).toBe(0);
  });

  it('silently skips tags that already exist', async () => {
    writeGoMod(tmpDir, 'github.com/example/repo');

    const mockExec = jest.fn().mockImplementation((cmd: unknown) => {
      if (String(cmd).startsWith('git tag')) {
        throw new Error('fatal: tag already exists');
      }
    }) as unknown as ExecFn;

    await expect(
      publish({} as GomodPluginConfig, makeCtx('1.2.3'), mockExec),
    ).resolves.toBeUndefined();
  });
});
