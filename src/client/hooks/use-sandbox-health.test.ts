import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSandboxHealth } from './use-sandbox-health';

function probeOk() {
  return { ok: true, platform: 'darwin', failures: [], checkedAt: Date.now(), durationMs: 3 };
}

function probeDegraded() {
  return {
    ok: false,
    platform: 'darwin',
    failures: ['filesystem-deny-not-enforced'],
    checkedAt: Date.now(),
    durationMs: 3,
  };
}

function mockFetchSequence(sequence: Array<{ ok: boolean; probe: unknown }>) {
  let index = 0;
  const calls: string[] = [];
  const impl = vi.fn((url: unknown) => {
    calls.push(String(url));
    const entry = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return Promise.resolve({
      ok: entry.ok,
      status: entry.ok ? 200 : 503,
      json: () => Promise.resolve({ ok: entry.ok, probe: entry.probe }),
    });
  });
  global.fetch = impl as unknown as typeof global.fetch;
  return calls;
}

describe('useSandboxHealth', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('reports degraded=false when the probe passes', async () => {
    mockFetchSequence([{ ok: true, probe: probeOk() }]);
    const { result } = renderHook(() => useSandboxHealth(60_000));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.degraded).toBe(false);
    expect(result.current.probe?.ok).toBe(true);
  });

  it('reports degraded=true with failures when the probe fails (503)', async () => {
    mockFetchSequence([{ ok: false, probe: probeDegraded() }]);
    const { result } = renderHook(() => useSandboxHealth(60_000));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.degraded).toBe(true);
    expect(result.current.probe?.failures).toEqual(['filesystem-deny-not-enforced']);
  });

  it('recheck forces a server-side re-probe via ?refresh=1 and clears when it passes', async () => {
    const calls = mockFetchSequence([
      { ok: false, probe: probeDegraded() },
      { ok: true, probe: probeOk() },
    ]);
    const { result } = renderHook(() => useSandboxHealth(60_000));
    await waitFor(() => expect(result.current.degraded).toBe(true));

    await act(async () => {
      await result.current.recheck();
    });

    expect(calls).toEqual(['/api/health/sandbox', '/api/health/sandbox?refresh=1']);
    expect(result.current.degraded).toBe(false);
  });

  it('keeps the previous state when fetch fails transiently', async () => {
    mockFetchSequence([{ ok: false, probe: probeDegraded() }]);
    const { result } = renderHook(() => useSandboxHealth(60_000));
    await waitFor(() => expect(result.current.degraded).toBe(true));

    global.fetch = vi.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof global.fetch;
    await act(async () => {
      await result.current.recheck();
    });
    expect(result.current.degraded).toBe(true);
  });
});
