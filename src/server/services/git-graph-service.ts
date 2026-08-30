import { execFile } from 'child_process';
import type {
  GitCapability,
  GitGraphCommit,
  GitGraphRef,
  GitGraphRefType,
  GitGraphSnapshot,
  GitGraphSnapshotOptions,
} from '../models/git-graph.js';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
export const DEFAULT_GIT_GRAPH_LIMIT = 100;
export const MAX_GIT_GRAPH_LIMIT = 500;

interface GitRunOptions {
  allowedExitCodes?: number[];
  timeout?: number;
  maxBuffer?: number;
}

export type GitCommandRunner = (
  cwd: string,
  args: string[],
  options?: GitRunOptions,
) => Promise<string>;

export class GitGraphUnavailableError extends Error {
  constructor() {
    super('Workspace is not a Git worktree');
    this.name = 'GitGraphUnavailableError';
  }
}

export class GitGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitGraphValidationError';
  }
}

function refType(fullName: string): GitGraphRefType | null {
  if (fullName.startsWith('refs/heads/')) return 'local';
  if (fullName.startsWith('refs/remotes/')) return 'remote';
  if (fullName.startsWith('refs/tags/')) return 'tag';
  return null;
}

function shortRefName(fullName: string, type: GitGraphRefType): string {
  if (type === 'local') return fullName.slice('refs/heads/'.length);
  if (type === 'remote') return fullName.slice('refs/remotes/'.length);
  return fullName.slice('refs/tags/'.length);
}

function parseRefs(output: string): GitGraphRef[] {
  const refs: GitGraphRef[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [objectHash, objectType, peeledHash, peeledType, fullName] = line.split('\t');
    if (!objectHash || !objectType || !fullName) continue;
    const type = refType(fullName);
    if (!type) continue;
    const hash = objectType === 'tag' && peeledType === 'commit' ? peeledHash : objectHash;
    // The graph only contains commits. A tag pointing to a tree or blob is a
    // valid Git ref, but cannot truthfully be attached to a commit row.
    if (!hash || (objectType !== 'commit' && peeledType !== 'commit')) continue;
    refs.push({ fullName, name: shortRefName(fullName, type), type, hash });
  }
  return refs;
}

function parseCommits(
  output: string,
  headHash: string | null,
  refsByHash: Map<string, GitGraphRef[]>,
): GitGraphCommit[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 6 !== 0) {
    throw new Error('Git returned a malformed history record');
  }

  const commits: GitGraphCommit[] = [];
  for (let index = 0; index < fields.length; index += 6) {
    const hash = fields[index];
    const parents = fields[index + 1];
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents: parents ? parents.split(' ') : [],
      authorName: fields[index + 2],
      authorEmail: fields[index + 3],
      authoredAt: fields[index + 4],
      subject: fields[index + 5],
      refs: refsByHash.get(hash) ?? [],
      isHead: hash === headHash,
    });
  }
  return commits;
}

export class GitGraphService {
  constructor(private readonly run: GitCommandRunner = GitGraphService.runGit) {}

  static runGit: GitCommandRunner = (cwd, args, options = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd,
          encoding: 'utf8',
          timeout: options.timeout ?? GIT_TIMEOUT_MS,
          maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
        },
        (error, stdout) => {
          if (error) {
            const exitCode = typeof error.code === 'number' ? error.code : null;
            if (exitCode !== null && options.allowedExitCodes?.includes(exitCode)) {
              resolve(stdout);
              return;
            }
            reject(error);
            return;
          }
          resolve(stdout);
        },
      );
    });

  async getCapability(folderPath: string): Promise<GitCapability> {
    const output = await this.run(folderPath, ['rev-parse', '--is-inside-work-tree'], {
      allowedExitCodes: [128],
      timeout: 5_000,
    });
    const isGitWorktree = output.trim() === 'true';

    if (!isGitWorktree) {
      return {
        isGitWorktree: false,
        state: 'non-git',
        branch: null,
        ref: null,
        headHash: null,
      };
    }

    const [branch, headHash] = await Promise.all([
      this.run(folderPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        allowedExitCodes: [1],
        timeout: 5_000,
      }).then((value) => value.trim() || null),
      this.run(folderPath, ['rev-parse', '--verify', 'HEAD^{commit}'], {
        allowedExitCodes: [128],
        timeout: 5_000,
      }).then((value) => value.trim() || null),
    ]);

    if (!headHash) {
      return { isGitWorktree: true, state: 'unborn', branch, ref: branch, headHash: null };
    }
    if (branch) {
      return { isGitWorktree: true, state: 'attached', branch, ref: branch, headHash };
    }
    const exactTag = await this.run(folderPath, ['describe', '--tags', '--exact-match', headHash], {
      allowedExitCodes: [128],
      timeout: 5_000,
    }).then((value) => value.trim() || null);
    return {
      isGitWorktree: true,
      state: 'detached',
      branch: null,
      ref: exactTag ?? headHash.slice(0, 7),
      headHash,
    };
  }

  async getSnapshot(
    folderPath: string,
    options: GitGraphSnapshotOptions = {},
  ): Promise<GitGraphSnapshot> {
    const limit = options.limit ?? DEFAULT_GIT_GRAPH_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GIT_GRAPH_LIMIT) {
      throw new GitGraphValidationError(
        `limit must be an integer between 1 and ${MAX_GIT_GRAPH_LIMIT}`,
      );
    }

    // Capture HEAD and refs before history. Every later Git invocation uses
    // only these immutable object IDs, so a concurrent ref move cannot mix a
    // new branch tip into an otherwise old response.
    const capability = await this.getCapability(folderPath);
    if (!capability.isGitWorktree) throw new GitGraphUnavailableError();

    const refOutput = await this.run(folderPath, [
      'for-each-ref',
      '--sort=refname',
      '--format=%(objectname)%09%(objecttype)%09%(*objectname)%09%(*objecttype)%09%(refname)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]);
    const refs = parseRefs(refOutput);
    const refsByName = new Map(refs.map((ref) => [ref.fullName, ref]));
    const requestedRefs = options.refs ?? [];
    for (const selectedRef of requestedRefs) {
      if (!refsByName.has(selectedRef)) {
        throw new GitGraphValidationError(`Unknown Git ref: ${selectedRef}`);
      }
    }

    const tipHashes = new Set<string>();
    if (requestedRefs.length > 0) {
      for (const selectedRef of requestedRefs) tipHashes.add(refsByName.get(selectedRef)!.hash);
    } else {
      for (const ref of refs) tipHashes.add(ref.hash);
      if (capability.headHash) tipHashes.add(capability.headHash);
    }

    const refsByHash = new Map<string, GitGraphRef[]>();
    for (const ref of refs) {
      const attached = refsByHash.get(ref.hash) ?? [];
      attached.push(ref);
      refsByHash.set(ref.hash, attached);
    }

    if (tipHashes.size === 0) {
      return { capability, refs, commits: [], limit, hasMore: false };
    }

    const history = await this.run(folderPath, [
      'log',
      '-z',
      '--topo-order',
      '--date-order',
      `--max-count=${limit + 1}`,
      '--no-decorate',
      '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s',
      ...tipHashes,
    ]);
    const parsed = parseCommits(history, capability.headHash, refsByHash);
    const hasMore = parsed.length > limit;
    return { capability, refs, commits: parsed.slice(0, limit), limit, hasMore };
  }
}

export const gitGraphService = new GitGraphService();
