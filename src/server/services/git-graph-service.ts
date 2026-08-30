import { execFile, spawn } from 'child_process';
import type {
  GitCapability,
  GitGraphChangedFile,
  GitGraphCommit,
  GitGraphCommitDetail,
  GitGraphFileComparison,
  GitGraphFileStatus,
  GitGraphRef,
  GitGraphRefType,
  GitGraphSnapshot,
  GitGraphSnapshotOptions,
} from '../models/git-graph.js';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_DETAIL_FILES = 1_000;
const MAX_DIFF_SIZE = 500 * 1024;
const MAX_DIFF_LINES = 5_000;
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

interface CommitIdentity {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  baseHash: string | null;
}

interface RawChange {
  status: GitGraphFileStatus;
  path: string;
  oldPath?: string;
  oldMode: string;
  newMode: string;
}

function validateCommitHash(hash: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)) {
    throw new GitGraphValidationError('commit must be a full object hash');
  }
}

function validateRelativePath(requestedPath: string): void {
  if (
    !requestedPath ||
    requestedPath.includes('\0') ||
    requestedPath.includes('\\') ||
    requestedPath.startsWith('/') ||
    /^[A-Za-z]:/.test(requestedPath) ||
    requestedPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new GitGraphValidationError('path must be a safe Workspace-relative path');
  }
}

function parseCommitIdentity(output: string): CommitIdentity {
  const normalized = output.endsWith('\n') ? output.slice(0, -1) : output;
  const fields = normalized.split('\0');
  if (fields.length !== 7 || !fields[0]) {
    throw new Error('Git returned malformed commit metadata');
  }
  const parents = fields[1] ? fields[1].split(' ') : [];
  return {
    hash: fields[0],
    parents,
    authorName: fields[2],
    authorEmail: fields[3],
    authoredAt: fields[4],
    subject: fields[5],
    baseHash: parents[0] ?? null,
  };
}

function parseRawChanges(output: string): RawChange[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(header);
    if (!match) throw new Error('Git returned malformed raw diff data');
    const status = match[3] as GitGraphFileStatus;
    const firstPath = fields[index++];
    if (firstPath === undefined) throw new Error('Git returned a raw diff without a path');
    if (status === 'R' || status === 'C') {
      const newPath = fields[index++];
      if (newPath === undefined) throw new Error('Git returned an incomplete rename');
      changes.push({ status, oldPath: firstPath, path: newPath, oldMode: match[1], newMode: match[2] });
    } else {
      changes.push({ status, path: firstPath, oldMode: match[1], newMode: match[2] });
    }
  }
  return changes;
}

function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error('Git returned malformed numstat data');
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      index += 1; // old path for a rename/copy
      filePath = fields[index++];
      if (filePath === undefined) throw new Error('Git returned incomplete rename statistics');
    }
    stats.set(filePath, {
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
    });
  }
  return stats;
}

function capContent(buffer: Buffer): { content: string; truncated: boolean } {
  let truncated = buffer.length > MAX_DIFF_SIZE;
  const text = buffer.subarray(0, MAX_DIFF_SIZE).toString('utf8');
  const lines = text.split('\n');
  if (lines.length > MAX_DIFF_LINES) {
    truncated = true;
    return { content: lines.slice(0, MAX_DIFF_LINES).join('\n'), truncated };
  }
  return { content: text, truncated };
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

  private async resolveCommit(folderPath: string, requestedHash: string): Promise<CommitIdentity> {
    validateCommitHash(requestedHash);
    let output: string;
    try {
      output = await this.run(folderPath, [
        'show',
        '--no-patch',
        '--no-decorate',
        `--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00`,
        requestedHash,
      ]);
    } catch {
      throw new GitGraphValidationError('Unknown commit');
    }
    const identity = parseCommitIdentity(output);
    if (identity.hash.toLowerCase() !== requestedHash.toLowerCase()) {
      throw new GitGraphValidationError('Unknown commit');
    }
    return identity;
  }

  private diffArgs(identity: CommitIdentity, kind: '--raw' | '--numstat'): string[] {
    const shared = [kind, '-z', '--find-renames', '--relative'];
    return identity.baseHash
      ? ['diff', ...shared, identity.baseHash, identity.hash, '--', '.']
      : ['diff-tree', '--root', '-r', '--no-commit-id', ...shared, identity.hash, '--', '.'];
  }

  private async getChangedFiles(
    folderPath: string,
    identity: CommitIdentity,
  ): Promise<{ files: GitGraphChangedFile[]; truncated: boolean }> {
    const [rawOutput, numstatOutput] = await Promise.all([
      this.run(folderPath, this.diffArgs(identity, '--raw')),
      this.run(folderPath, this.diffArgs(identity, '--numstat')),
    ]);
    const rawChanges = parseRawChanges(rawOutput);
    const numstat = parseNumstat(numstatOutput);
    const files = rawChanges.slice(0, MAX_DETAIL_FILES).map((change): GitGraphChangedFile => {
      const counts = numstat.get(change.path) ?? { additions: 0, deletions: 0 };
      const isGitlink = change.oldMode === '160000' || change.newMode === '160000';
      return {
        path: change.path,
        ...(change.oldPath ? { oldPath: change.oldPath } : {}),
        status: change.status,
        additions: counts.additions,
        deletions: counts.deletions,
        isBinary: counts.additions === null || counts.deletions === null,
        isGitlink,
      };
    });
    return { files, truncated: rawChanges.length > MAX_DETAIL_FILES };
  }

  async getCommitDetail(folderPath: string, hash: string): Promise<GitGraphCommitDetail> {
    const identity = await this.resolveCommit(folderPath, hash);
    const { files, truncated } = await this.getChangedFiles(folderPath, identity);
    return {
      hash: identity.hash,
      shortHash: identity.hash.slice(0, 7),
      parents: identity.parents,
      authorName: identity.authorName,
      authorEmail: identity.authorEmail,
      authoredAt: identity.authoredAt,
      subject: identity.subject,
      baseHash: identity.baseHash,
      files,
      filesTruncated: truncated,
      stats: {
        files: files.length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      },
    };
  }

  private static runGitBlob(
    cwd: string,
    args: string[],
  ): Promise<{ buffer: Buffer; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let captured = 0;
      let total = 0;
      let stderr = '';
      const timeout = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (captured < MAX_DIFF_SIZE) {
          const slice = chunk.subarray(0, MAX_DIFF_SIZE - captured);
          chunks.push(slice);
          captured += slice.length;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4_096) stderr += chunk.toString('utf8', 0, 4_096 - stderr.length);
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(signal ? `Git blob read terminated by ${signal}` : stderr.trim() || `Git exited with code ${code}`));
          return;
        }
        resolve({ buffer: Buffer.concat(chunks), truncated: total > MAX_DIFF_SIZE });
      });
    });
  }

  async getFileComparison(
    folderPath: string,
    hash: string,
    requestedPath: string,
  ): Promise<GitGraphFileComparison> {
    validateRelativePath(requestedPath);
    const identity = await this.resolveCommit(folderPath, hash);
    const { files } = await this.getChangedFiles(folderPath, identity);
    const file = files.find((candidate) => candidate.path === requestedPath);
    if (!file) throw new GitGraphValidationError('Path is not changed by this commit in this Workspace');

    if (file.isGitlink) {
      return {
        commitHash: identity.hash,
        baseHash: identity.baseHash,
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        status: file.status,
        original: '',
        modified: '',
        isBinary: false,
        isTextComparable: false,
        uncomparableReason: 'gitlink',
        truncated: false,
        isDeleted: file.status === 'D',
      };
    }

    const prefix = await this.run(folderPath, ['rev-parse', '--show-prefix']).then((value) => value.trim());
    const oldRepositoryPath = `${prefix}${file.oldPath ?? file.path}`;
    const newRepositoryPath = `${prefix}${file.path}`;
    const emptyBlob = Promise.resolve({ buffer: Buffer.alloc(0), truncated: false });
    const [originalBlob, modifiedBlob] = await Promise.all([
      !identity.baseHash || file.status === 'A'
        ? emptyBlob
        : GitGraphService.runGitBlob(folderPath, ['show', `${identity.baseHash}:${oldRepositoryPath}`]),
      file.status === 'D'
        ? emptyBlob
        : GitGraphService.runGitBlob(folderPath, ['show', `${identity.hash}:${newRepositoryPath}`]),
    ]);
    const originalBuffer = originalBlob.buffer;
    const modifiedBuffer = modifiedBlob.buffer;
    const isBinary = file.isBinary || originalBuffer.includes(0) || modifiedBuffer.includes(0);
    const original = isBinary ? { content: '', truncated: false } : capContent(originalBuffer);
    const modified = isBinary ? { content: '', truncated: false } : capContent(modifiedBuffer);
    return {
      commitHash: identity.hash,
      baseHash: identity.baseHash,
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      original: original.content,
      modified: modified.content,
      isBinary,
      isTextComparable: !isBinary,
      ...(isBinary ? { uncomparableReason: 'binary' as const } : {}),
      truncated:
        originalBlob.truncated || modifiedBlob.truncated || original.truncated || modified.truncated,
      isDeleted: file.status === 'D',
    };
  }
}

export const gitGraphService = new GitGraphService();
