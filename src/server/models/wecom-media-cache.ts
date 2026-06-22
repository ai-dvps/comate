export interface WeComMediaCacheEntry {
  workspaceId: string;
  relativePath: string;
  md5: string;
  filename: string;
  mediaId: string;
  createdAt: string;
}

export interface CreateWeComMediaCacheInput {
  workspaceId: string;
  relativePath: string;
  md5: string;
  filename: string;
  mediaId: string;
  createdAt: string;
}
