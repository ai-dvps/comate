import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import ConflictReview from './ConflictReview';
import i18n from '../../i18n';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function jsonOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('ConflictReview (R11)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when there are no conflicts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ conflicts: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderWithI18n(<ConflictReview todoId="t1" onResolved={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows both sides and resolving fires the resolve call + onResolved', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/conflicts') && init?.method !== 'POST') {
        return jsonOk({
          conflicts: [{ field: 'title', localValue: 'Local title', remoteValue: 'Remote title', baselineValue: 'Baseline' }],
        });
      }
      // resolve POST
      return jsonOk({ todo: { id: 't1' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onResolved = vi.fn();

    renderWithI18n(<ConflictReview todoId="t1" onResolved={onResolved} />);

    // Both sides are surfaced (neither edit is silently lost).
    await waitFor(() => expect(screen.getByText('Local title')).toBeInTheDocument());
    expect(screen.getByText('Remote title')).toBeInTheDocument();

    // Accept remote: the button containing the remote value.
    const remoteBtn = screen.getByText('Remote title').closest('button')!;
    await userEvent.click(remoteBtn);

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/conflicts/resolve') && c.init?.method === 'POST')).toBe(true);
    });
    const resolveCall = calls.find((c) => c.url.endsWith('/conflicts/resolve'))!;
    expect(JSON.parse(String(resolveCall.init!.body))).toEqual({ field: 'title', choice: 'remote' });
    expect(onResolved).toHaveBeenCalled();
  });

  it('accept-local fires the resolve call with choice:local', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/conflicts') && init?.method !== 'POST') {
        return jsonOk({
          conflicts: [{ field: 'title', localValue: 'Local title', remoteValue: 'Remote title', baselineValue: 'Baseline' }],
        });
      }
      return jsonOk({ todo: { id: 't1' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithI18n(<ConflictReview todoId="t1" onResolved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Local title')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Local title').closest('button')!);

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/conflicts/resolve'))).toBe(true));
    const resolveCall = calls.find((c) => c.url.endsWith('/conflicts/resolve'))!;
    expect(JSON.parse(String(resolveCall.init!.body))).toEqual({ field: 'title', choice: 'local' });
  });
});
