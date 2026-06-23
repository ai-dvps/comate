import { invoke } from '@tauri-apps/api/core';

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as TauriWindow).__TAURI_INTERNALS__;
}

async function resolveApiBaseWithRetry(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const port = await invoke<number>('get_api_port');
      return `http://localhost:${port}`;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return '';
}

let apiBasePromise: Promise<string> | null = null;

function getApiBase(): Promise<string> {
  if (!apiBasePromise) {
    apiBasePromise = resolveApiBaseWithRetry();
  }
  return apiBasePromise;
}

export function initTauriApi(): void {
  if (!isTauri()) return;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api')) {
      const base = await getApiBase();
      if (base) {
        input = `${base}${input}`;
      }
    }
    return originalFetch(input, init);
  };
}
