/**
 * Minimal JSON-file app settings store (key-value), following the
 * DraftSessionStore pattern in json-store.ts: storage dir from data-dir,
 * write via temp file. Holds app-level preferences such as the default
 * agent backend (U1). Forward-compatible: unknown keys are preserved.
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { getStorageDir } from './data-dir.js';

const SETTINGS_FILE = 'app-settings.json';

type AppSettingsData = Record<string, unknown>;
let mutationQueue = Promise.resolve();

const settingsPath = (): string => join(getStorageDir(), SETTINGS_FILE);

async function ensureStorageDir(): Promise<void> {
  const dir = getStorageDir();
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

async function readSettings(): Promise<AppSettingsData> {
  try {
    const data = await readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(data) as AppSettingsData;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSettings(data: AppSettingsData): Promise<void> {
  await ensureStorageDir();
  const tempFile = `${settingsPath()}.tmp`;
  await writeFile(tempFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await writeFile(settingsPath(), await readFile(tempFile, 'utf-8'), 'utf-8');
}

export async function getAppSetting<T>(key: string): Promise<T | undefined> {
  const data = await readSettings();
  return data[key] as T | undefined;
}

export async function setAppSetting(key: string, value: unknown): Promise<void> {
  await setAppSettings({ [key]: value });
}

/** Apply related preferences in one serialized read-modify-write cycle. */
export async function setAppSettings(values: Record<string, unknown>): Promise<void> {
  const mutation = mutationQueue.then(async () => {
    const data = await readSettings();
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete data[key];
      else data[key] = value;
    }
    await writeSettings(data);
  });
  mutationQueue = mutation.catch(() => undefined);
  await mutation;
}
