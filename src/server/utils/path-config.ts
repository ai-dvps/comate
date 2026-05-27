import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getStorageDir } from '../storage/data-dir.js';

const CONFIG_FILE = join(getStorageDir(), 'path-config.json');

interface PathConfig {
  customPaths: string[];
}

export function loadCustomPaths(): string[] {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PathConfig;
    if (Array.isArray(parsed.customPaths)) {
      return parsed.customPaths;
    }
  } catch {
    // Missing or corrupt file — return empty array
  }
  return [];
}

export function saveCustomPaths(paths: string[]): void {
  const config: PathConfig = { customPaths: paths };
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
