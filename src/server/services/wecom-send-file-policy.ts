import path from 'node:path';
import fs from 'node:fs';

export type SendFileDenialReason =
  | 'outside-workspace'
  | 'other-user-dir'
  | 'not-a-file'
  | 'invalid-path';

export interface SendFileValidationResult {
  allowed: boolean;
  reason?: SendFileDenialReason;
  absolutePath: string;
  relativePath: string;
}

function startsWithDir(resolved: string, dir: string): boolean {
  const d = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return resolved === dir || resolved.startsWith(d);
}

/**
 * Resolve a path, following symlinks where possible. For paths whose target does
 * not exist, resolve the parent directory's realpath and append the basename so
 * that symlink-based escapes are still caught.
 */
function resolveRealPath(resolved: string): string {
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    const base = path.basename(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      return path.join(realParent, base);
    } catch {
      return resolved;
    }
  }
}

/**
 * Validate a workspace-relative file path for proactive WeCom file sends.
 *
 * - The resolved path must stay inside the workspace.
 * - The path must point to a regular file, not a directory.
 * - If the path is inside `data/<folder>/`, `<folder>` must match
 *   `targetUserFolderName` (case-insensitive).
 */
export function validateSendFilePath(
  workspaceFolderPath: string,
  targetUserFolderName: string,
  rawFilePath: string,
): SendFileValidationResult {
  if (typeof rawFilePath !== 'string' || rawFilePath === '') {
    return {
      allowed: false,
      reason: 'invalid-path',
      absolutePath: '',
      relativePath: '',
    };
  }

  const resolvedWorkspacePath = path.resolve(workspaceFolderPath);
  const resolved = path.resolve(resolvedWorkspacePath, rawFilePath);
  const realResolved = resolveRealPath(resolved);

  if (!startsWithDir(realResolved, resolvedWorkspacePath)) {
    return {
      allowed: false,
      reason: 'outside-workspace',
      absolutePath: realResolved,
      relativePath: path.relative(resolvedWorkspacePath, realResolved),
    };
  }

  const relativePath = path.relative(resolvedWorkspacePath, realResolved);

  // Enforce data/<user-folder> isolation.
  const segments = relativePath.split(path.sep).filter(Boolean);
  if (segments[0]?.toLowerCase() === 'data') {
    const folderName = segments[1];
    if (
      folderName === undefined ||
      folderName.toLowerCase() !== targetUserFolderName.toLowerCase()
    ) {
      return {
        allowed: false,
        reason: 'other-user-dir',
        absolutePath: realResolved,
        relativePath,
      };
    }
  }

  // Verify the target is a file.
  let isFile = false;
  try {
    const stat = fs.statSync(realResolved);
    isFile = stat.isFile();
  } catch {
    isFile = false;
  }

  if (!isFile) {
    return {
      allowed: false,
      reason: 'not-a-file',
      absolutePath: realResolved,
      relativePath,
    };
  }

  return {
    allowed: true,
    absolutePath: realResolved,
    relativePath,
  };
}
