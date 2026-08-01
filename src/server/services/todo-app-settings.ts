import { getAppSetting, setAppSetting } from '../storage/app-settings-store.js';

const NIGHT_WINDOW_KEY = 'todoNightWindow';
export interface NightWindow { enabled: boolean; start: string; end: string; }
const DEFAULT_WINDOW: NightWindow = { enabled: true, start: '00:00', end: '08:00' };

export async function getNightWindow(): Promise<NightWindow> {
  const value = await getAppSetting<Partial<NightWindow>>(NIGHT_WINDOW_KEY);
  if (!value || typeof value.start !== 'string' || typeof value.end !== 'string') return DEFAULT_WINDOW;
  return { enabled: value.enabled !== false, start: value.start, end: value.end };
}

export async function setNightWindow(value: NightWindow): Promise<void> {
  await setAppSetting(NIGHT_WINDOW_KEY, value);
}
