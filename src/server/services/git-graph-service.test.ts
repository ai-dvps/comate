import '../test-utils/test-env.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  GitGraphService,
  GitGraphValidationError,
  type GitCommandRunner,
} from './git-graph-service.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'comate-git-graph-'));
  tempDirs.push(dir);
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function commit(cwd: string, subject: string): Promise<string> {
  await git(cwd, ['commit', '--allow-empty', '-m', subject]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GitGraphService', { concurrency: false }, () => {
  it('returns diverged local, remote and tag refs attached to exact commits', async () => {
    const repo = await createRepo();
    const rootHash = await commit(repo, '根提交');
    await git(repo, ['checkout', '-b', 'feature/图']);
    const featureHash = await commit(repo, 'feature subject');
    await git(repo, ['checkout', 'main']);
    const mainHash = await commit(repo, 'main subject');
    await git(repo, ['update-ref', 'refs/remotes/origin/main', mainHash]);
    await git(repo, ['tag', '版本-1', rootHash]);

    const snapshot = await new GitGraphService().getSnapshot(repo, { limit: 20 });

    assert.deepStrictEqual(snapshot.capability, {
      isGitWorktree: true,
      state: 'attached',
      branch: 'main',
      ref: 'main',
      headHash: mainHash,
    });
    assert.deepStrictEqual(
      snapshot.refs.map(({ name, type, hash }) => ({ name, type, hash })),
      [
        { name: 'feature/图', type: 'local', hash: featureHash },
        { name: 'main', type: 'local', hash: mainHash },
        { name: 'origin/main', type: 'remote', hash: mainHash },
        { name: '版本-1', type: 'tag', hash: rootHash },
      ],
    );
    assert.equal(snapshot.commits.find((item) => item.hash === mainHash)?.isHead, true);
    assert.deepStrictEqual(
      snapshot.commits.find((item) => item.hash === mainHash)?.refs.map((ref) => ref.fullName),
      ['refs/heads/main', 'refs/remotes/origin/main'],
    );
    assert.deepStrictEqual(
      snapshot.commits.find((item) => item.hash === featureHash)?.parents,
      [rootHash],
    );
  });

  it('classifies non-Git and unborn worktrees without fabricating history', async () => {
    const nonGit = await mkdtemp(path.join(os.tmpdir(), 'comate-not-git-'));
    tempDirs.push(nonGit);
    const service = new GitGraphService();

    assert.deepStrictEqual(await service.getCapability(nonGit), {
      isGitWorktree: false,
      state: 'non-git',
      branch: null,
      ref: null,
      headHash: null,
    });
    await assert.rejects(() => service.getSnapshot(nonGit), /not a Git worktree/i);

    const unborn = await createRepo();
    const snapshot = await service.getSnapshot(unborn);
    assert.deepStrictEqual(snapshot.capability, {
      isGitWorktree: true,
      state: 'unborn',
      branch: 'main',
      ref: 'main',
      headHash: null,
    });
    assert.deepStrictEqual(snapshot.commits, []);
    assert.equal(snapshot.hasMore, false);
  });

  it('reports detached HEAD without a fabricated branch', async () => {
    const repo = await createRepo();
    const hash = await commit(repo, 'initial');
    await git(repo, ['checkout', '--detach', hash]);

    const capability = await new GitGraphService().getCapability(repo);

    assert.deepStrictEqual(capability, {
      isGitWorktree: true,
      state: 'detached',
      branch: null,
      ref: hash.slice(0, 7),
      headHash: hash,
    });
  });

  it('expands a stable bounded history window', async () => {
    const repo = await createRepo();
    for (let index = 0; index < 6; index += 1) {
      await commit(repo, `commit ${index}`);
    }
    const service = new GitGraphService();

    const small = await service.getSnapshot(repo, { limit: 2 });
    const large = await service.getSnapshot(repo, { limit: 5 });

    assert.equal(small.commits.length, 2);
    assert.equal(small.limit, 2);
    assert.equal(small.hasMore, true);
    assert.equal(large.commits.length, 5);
    assert.equal(large.hasMore, true);
    assert.deepStrictEqual(large.commits.slice(0, 2), small.commits);
  });

  it('validates branch filters before starting history', async () => {
    const repo = await createRepo();
    await commit(repo, 'initial');
    let historyWasRun = false;
    const runner: GitCommandRunner = async (cwd, args, options) => {
      if (args[0] === 'log') historyWasRun = true;
      return GitGraphService.runGit(cwd, args, options);
    };
    const service = new GitGraphService(runner);

    await assert.rejects(
      () => service.getSnapshot(repo, { refs: ['refs/heads/missing'] }),
      (error) =>
        error instanceof GitGraphValidationError &&
        error.message === 'Unknown Git ref: refs/heads/missing',
    );
    assert.equal(historyWasRun, false);
  });

  it('round-trips Unicode and separator-like commit and ref text', async () => {
    const repo = await createRepo();
    await git(repo, ['config', 'user.name', '作者 | [分隔]']);
    const hash = await commit(repo, '主题 | %x00 <RS> 你好');
    await git(repo, ['branch', '功能-α']);

    const snapshot = await new GitGraphService().getSnapshot(repo);
    const item = snapshot.commits.find((candidate) => candidate.hash === hash);

    assert.equal(item?.subject, '主题 | %x00 <RS> 你好');
    assert.equal(item?.authorName, '作者 | [分隔]');
    assert.equal(snapshot.refs.some((ref) => ref.name === '功能-α'), true);
  });

  it('runs history from captured immutable IDs when a ref moves mid-request', async () => {
    const repo = await createRepo();
    const capturedHash = await commit(repo, 'captured');
    let movedHash: string | null = null;
    const runner: GitCommandRunner = async (cwd, args, options) => {
      const result = await GitGraphService.runGit(cwd, args, options);
      if (args[0] === 'for-each-ref' && movedHash === null) {
        movedHash = await commit(repo, 'moved later');
      }
      return result;
    };

    const snapshot = await new GitGraphService(runner).getSnapshot(repo);

    assert.equal(snapshot.capability.headHash, capturedHash);
    assert.equal(snapshot.refs.find((ref) => ref.fullName === 'refs/heads/main')?.hash, capturedHash);
    assert.equal(snapshot.commits[0]?.hash, capturedHash);
    assert.equal(snapshot.commits.some((item) => item.hash === movedHash), false);
  });
});
