export type GitRepositoryState = 'non-git' | 'unborn' | 'attached' | 'detached';

export interface GitCapability {
  isGitWorktree: boolean;
  state: GitRepositoryState;
  branch: string | null;
  /** Backwards-compatible display ref used by the existing status bar. */
  ref: string | null;
  headHash: string | null;
}

export type GitGraphRefType = 'local' | 'remote' | 'tag';

export interface GitGraphRef {
  fullName: string;
  name: string;
  type: GitGraphRefType;
  hash: string;
}

export interface GitGraphCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  refs: GitGraphRef[];
  isHead: boolean;
}

export interface GitGraphSnapshot {
  capability: GitCapability;
  refs: GitGraphRef[];
  commits: GitGraphCommit[];
  limit: number;
  hasMore: boolean;
}

export interface GitGraphSnapshotOptions {
  limit?: number;
  refs?: string[];
}
