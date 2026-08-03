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

async function resolveApiTokenWithRetry(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const token = await invoke<string>('get_api_token');
      if (token) return token;
    } catch {
      // sidecar not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return '';
}

let apiBasePromise: Promise<string> | null = null;
let apiTokenPromise: Promise<string> | null = null;

export function getApiBase(): Promise<string> {
  if (!apiBasePromise) {
    apiBasePromise = resolveApiBaseWithRetry();
  }
  return apiBasePromise;
}

/**
 * U12 (KTD-28): the desktop GUI credential. Minted per sidecar boot, handed
 * to the Tauri shell via the sidecar ready message, and injected here into
 * every /api request. It is never exposed to sandboxed sessions — bot
 * sessions authenticate with their own per-session capability tokens.
 */
export function getApiToken(): Promise<string> {
  if (!apiTokenPromise) {
    apiTokenPromise = resolveApiTokenWithRetry();
  }
  return apiTokenPromise;
}

export async function getWebSocketUrl(): Promise<string> {
  const base = await getApiBase();
  if (!base) return '';
  return base.replace(/^http/, 'ws') + '/ws';
}

export function initTauriApi(): void {
  if (!isTauri()) return;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api')) {
      const base = await getApiBase();
      if (base) {
        input = `${base}${input}`;
        const token = await getApiToken();
        if (token) {
          const headers = new Headers(init?.headers);
          if (!headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${token}`);
          }
          init = { ...init, headers };
        }
      }
    }
    return originalFetch(input, init);
  };
}
