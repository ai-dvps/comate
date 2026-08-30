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

export type GitGraphFileStatus = 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'X';

export interface GitGraphChangedFile {
  path: string;
  oldPath?: string;
  status: GitGraphFileStatus;
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
  isGitlink: boolean;
}

export interface GitGraphCommitDetail {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  baseHash: string | null;
  files: GitGraphChangedFile[];
  filesTruncated: boolean;
  stats: {
    files: number;
    additions: number;
    deletions: number;
  };
}

export type GitGraphUncomparableReason = 'binary' | 'gitlink';

export interface GitGraphFileComparison {
  commitHash: string;
  baseHash: string | null;
  path: string;
  oldPath?: string;
  status: GitGraphFileStatus;
  original: string;
  modified: string;
  isBinary: boolean;
  isTextComparable: boolean;
  uncomparableReason?: GitGraphUncomparableReason;
  truncated: boolean;
  isDeleted: boolean;
}
