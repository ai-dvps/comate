import { useCallback, useEffect, useRef, useState } from 'react';

export interface SandboxProbeState {
  ok: boolean;
  platform: string;
  failures: string[];
  checkedAt: number;
  durationMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Polls /api/health/sandbox (U3, KTD-24) and exposes the host's sandbox probe
 * state for the degraded-posture banner. The banner is persistent: it renders
 * while the probe fails and can only clear when a probe passes — there is no
 * manual dismissal. `recheck` forces a fresh probe server-side (`?refresh=1`).
 */
export function useSandboxHealth(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): {
  degraded: boolean;
  checking: boolean;
  probe: SandboxProbeState | null;
  recheck: () => Promise<void>;
} {
  const [probe, setProbe] = useState<SandboxProbeState | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [checking, setChecking] = useState(true);
  const mountedRef = useRef(true);

  const fetchState = useCallback(async (refresh: boolean) => {
    try {
      const res = await fetch(refresh ? '/api/health/sandbox?refresh=1' : '/api/health/sandbox');
      const data = (await res.json()) as { probe?: SandboxProbeState };
      if (!mountedRef.current) return;
      setProbe(data.probe ?? null);
      setDegraded(!res.ok);
    } catch {
      // Network/JSON failure: keep the previous state — never flap the banner
      // into the degraded posture on a transient client-side error.
      if (!mountedRef.current) return;
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchState(false);
    const timer = setInterval(() => fetchState(false), pollIntervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [fetchState, pollIntervalMs]);

  const recheck = useCallback(async () => {
    setChecking(true);
    await fetchState(true);
  }, [fetchState]);

  return { degraded, checking, probe, recheck };
}
