import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import SandboxDegradedBanner from './SandboxDegradedBanner';
import i18n from '../i18n';

function renderBanner() {
  return render(
    <I18nextProvider i18n={i18n}>
      <SandboxDegradedBanner />
    </I18nextProvider>,
  );
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

function probeOk() {
  return { ok: true, platform: 'darwin', failures: [], checkedAt: Date.now(), durationMs: 3 };
}

function mockFetchWith(entry: { ok: boolean; probe: unknown }) {
  const calls: string[] = [];
  global.fetch = vi.fn((url: unknown) => {
    calls.push(String(url));
    return Promise.resolve({
      ok: entry.ok,
      status: entry.ok ? 200 : 503,
      json: () => Promise.resolve({ ok: entry.ok, probe: entry.probe }),
    });
  }) as unknown as typeof global.fetch;
  return calls;
}

describe('SandboxDegradedBanner', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it('renders nothing while the probe passes', async () => {
    mockFetchWith({ ok: true, probe: probeOk() });
    renderBanner();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('sandbox-degraded-banner')).toBeNull();
  });

  it('dismisses the degraded banner without changing the probe state', async () => {
    const calls = mockFetchWith({ ok: false, probe: probeDegraded() });
    renderBanner();
    const banner = await screen.findByTestId('sandbox-degraded-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('filesystem-deny-not-enforced');

    fireEvent.click(screen.getByRole('button', { name: /dismiss sandbox warning/i }));

    expect(screen.queryByTestId('sandbox-degraded-banner')).toBeNull();
    expect(calls).toEqual(['/api/health/sandbox']);
  });

  it('re-check button forces a re-probe and the banner clears when it passes', async () => {
    const calls: string[] = [];
    let degraded = true;
    global.fetch = vi.fn((url: unknown) => {
      calls.push(String(url));
      const entry = degraded ? { ok: false, probe: probeDegraded() } : { ok: true, probe: probeOk() };
      return Promise.resolve({
        ok: entry.ok,
        status: entry.ok ? 200 : 503,
        json: () => Promise.resolve(entry),
      });
    }) as unknown as typeof global.fetch;

    renderBanner();
    await screen.findByTestId('sandbox-degraded-banner');

    degraded = false;
    const button = screen.getByRole('button', { name: /re-check/i });
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByTestId('sandbox-degraded-banner')).toBeNull());
    expect(calls).toContain('/api/health/sandbox?refresh=1');
  });
});
