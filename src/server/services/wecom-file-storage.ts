import fsPromises from 'node:fs/promises';
import path from 'node:path';

function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}-${h}-${min}-${s}`;
}

export async function saveMediaFile(
  workspaceFolderPath: string,
  userFolderName: string,
  fileBuffer: Buffer,
  filename: string,
): Promise<string> {
  const targetDir = path.join(workspaceFolderPath, userFolderName);
  const resolvedWorkspacePath = path.resolve(workspaceFolderPath);

  // Validate target directory is within workspace
  const resolvedDir = path.resolve(targetDir);
  if (!resolvedDir.startsWith(resolvedWorkspacePath)) {
    throw new Error(`Target directory "${targetDir}" is outside the workspace`);
  }

  // Resolve and validate the target file path
  const targetFilePath = path.join(targetDir, filename);
  const resolvedFilePath = path.resolve(targetFilePath);
  if (!resolvedFilePath.startsWith(resolvedWorkspacePath)) {
    throw new Error(`Target file path "${targetFilePath}" is outside the workspace`);
  }

  // Ensure the target directory exists
  await fsPromises.mkdir(resolvedDir, { recursive: true });

  // Check for name collision
  let finalFilePath = resolvedFilePath;
  try {
    await fsPromises.access(resolvedFilePath);
    // File exists — add timestamp suffix before the last extension
    const timestamp = formatTimestamp(new Date());
    const lastDotIndex = filename.lastIndexOf('.');
    let newFilename: string;
    if (lastDotIndex > 0) {
      const base = filename.substring(0, lastDotIndex);
      const ext = filename.substring(lastDotIndex);
      newFilename = `${base}-${timestamp}${ext}`;
    } else {
      newFilename = `${filename}-${timestamp}`;
    }
    finalFilePath = path.resolve(path.join(resolvedDir, newFilename));
  } catch {
    // File does not exist — use the original path
  }

  await fsPromises.writeFile(finalFilePath, fileBuffer);

  return path.relative(resolvedWorkspacePath, finalFilePath);
}
