/**
 * Domain model for a single `git status --porcelain` entry.
 *
 * Owned in the models layer (not in the HTTP route module) so that the route
 * and the watcher service share one canonical type definition.
 */
export interface GitStatusItem {
  path: string;
  indexStatus: string;
  workingTreeStatus: string;
  /** Source path for renames/copies (`old.txt` for `old.txt -> new.txt`). */
  originalPath?: string;
}
