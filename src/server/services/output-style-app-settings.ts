import { getAppSetting, setAppSetting } from '../storage/app-settings-store.js';

const OUTPUT_STYLE_KEY = 'outputStyle';

export function isValidOutputStyle(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 64;
}

/** App-global Claude Code output style. Null delegates to the CLI default. */
export async function getOutputStyle(): Promise<string | null> {
  const value = await getAppSetting<unknown>(OUTPUT_STYLE_KEY);
  return isValidOutputStyle(value) ? value : null;
}

export async function setOutputStyle(value: string | null): Promise<void> {
  await setAppSetting(OUTPUT_STYLE_KEY, value ?? undefined);
}
