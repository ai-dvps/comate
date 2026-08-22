import { getAppSetting, setAppSetting } from '../storage/app-settings-store.js';

const CODEX_DEFAULT_MODEL_KEY = 'codex.defaultModel';

export async function getCodexDefaultModel(): Promise<string | undefined> {
  const value = await getAppSetting<unknown>(CODEX_DEFAULT_MODEL_KEY);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function setCodexDefaultModel(model: string | null): Promise<void> {
  await setAppSetting(CODEX_DEFAULT_MODEL_KEY, model);
}
