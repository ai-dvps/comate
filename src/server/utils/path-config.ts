import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getStorageDir } from '../storage/data-dir.js';

const CONFIG_FILE = join(getStorageDir(), 'path-config.json');

interface PathConfig {
  customPaths: string[];
  shellInitCommand?: string;
}

function loadConfig(): PathConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as PathConfig;
  } catch {
    return { customPaths: [] };
  }
}

function saveConfig(config: PathConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function loadCustomPaths(): string[] {
  const config = loadConfig();
  if (Array.isArray(config.customPaths)) {
    return config.customPaths;
  }
  return [];
}

export function saveCustomPaths(paths: string[]): void {
  const config = loadConfig();
  config.customPaths = paths;
  saveConfig(config);
}

export function loadShellInitCommand(): string | undefined {
  const config = loadConfig();
  const cmd = config.shellInitCommand;
  if (typeof cmd === 'string' && cmd.trim().length > 0) {
    return cmd.trim();
  }
  return undefined;
}

export function saveShellInitCommand(command: string | undefined): void {
  const config = loadConfig();
  if (command === undefined) {
    delete config.shellInitCommand;
  } else {
    config.shellInitCommand = command;
  }
  saveConfig(config);
}

/** Override shell init command for testing. Exposed only for tests. */
let _testingShellInitCommand: string | undefined | null = null;

export function __setShellInitCommandForTesting(command: string | undefined): void {
  _testingShellInitCommand = command;
}

export function __restoreShellInitCommand(): void {
  _testingShellInitCommand = null;
}

export function __getShellInitCommandForTesting(): string | undefined {
  if (_testingShellInitCommand !== null) {
    return _testingShellInitCommand;
  }
  return loadShellInitCommand();
}
