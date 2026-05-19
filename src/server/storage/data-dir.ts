import { join } from 'path';
import { homedir } from 'os';

export function getStorageDir(): string {
  if (process.env.CLAUDE_CODE_GUI_DATA_DIR) {
    return process.env.CLAUDE_CODE_GUI_DATA_DIR;
  }
  return join(homedir(), '.claude-code-gui');
}
