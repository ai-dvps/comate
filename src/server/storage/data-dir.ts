import { join } from 'path';
import { homedir } from 'os';

export function getStorageDir(): string {
  if (process.env.COMATE_DATA_DIR) {
    return process.env.COMATE_DATA_DIR;
  }
  return join(homedir(), '.comate');
}
