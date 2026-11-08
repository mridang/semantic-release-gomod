import { describe, expect, it, jest } from '@jest/globals';
import { GoClient } from '../src/go.js';
import type { Run } from '../src/utils/exec.js';

describe('GoClient', () => {
  describe('modTidy', () => {
    it('runs go mod tidy in the module directory', () => {
      const run = jest.fn<Run>(() => '');
      new GoClient({ run }).modTidy('/repo/sub');
      expect(run).toHaveBeenCalledWith('go', ['mod', 'tidy'], {
        cwd: '/repo/sub',
      });
    });

    it('treats a directory name as one cwd, never as shell text', () => {
      const run = jest.fn<Run>(() => '');
      new GoClient({ run }).modTidy('/repo/$(id);x y');
      expect(run.mock.calls).toEqual([
        ['go', ['mod', 'tidy'], { cwd: '/repo/$(id);x y' }],
      ]);
    });

    it('lets a failure propagate for the caller to report', () => {
      const failure = new Error('go: no network');
      const run = jest.fn<Run>(() => {
        throw failure;
      });
      expect(() => new GoClient({ run }).modTidy('/repo/sub')).toThrow(failure);
    });

    it('can be built without options, using the real runner', () => {
      expect(() => new GoClient()).not.toThrow();
    });
  });
});
