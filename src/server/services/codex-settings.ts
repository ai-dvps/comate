import { getAppSetting, setAppSettings } from '../storage/app-settings-store.js';

const CODEX_DEFAULT_MODEL_KEY = 'codex.defaultModel';
const CODEX_DEFAULT_EFFORT_KEY = 'codex.defaultEffort';
const CODEX_DEFAULT_SPEED_KEY = 'codex.defaultSpeed';

export interface CodexDefaults {
  model?: string;
  effort?: string;
  speed?: string;
}

export async function getCodexDefaults(): Promise<CodexDefaults> {
  const [model, effort, speed] = await Promise.all([
    getAppSetting<unknown>(CODEX_DEFAULT_MODEL_KEY),
    getAppSetting<unknown>(CODEX_DEFAULT_EFFORT_KEY),
    getAppSetting<unknown>(CODEX_DEFAULT_SPEED_KEY),
  ]);
  return {
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
    ...(typeof effort === 'string' && effort.length > 0 ? { effort } : {}),
    ...(typeof speed === 'string' && speed.length > 0 ? { speed } : {}),
  };
}

export async function setCodexDefaults(defaults: CodexDefaults): Promise<void> {
  await setAppSettings({
    [CODEX_DEFAULT_MODEL_KEY]: defaults.model ?? null,
    [CODEX_DEFAULT_EFFORT_KEY]: defaults.effort ?? null,
    [CODEX_DEFAULT_SPEED_KEY]: defaults.speed ?? null,
  });
}
