import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import TodosPanel from './TodosPanel';
import { useTodoStore } from '../stores/todo-store';
import { useGithubStore } from '../stores/github-store';
import i18n from '../i18n';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('TodosPanel — AE5 panel-open sync', () => {
  const calls: string[] = [];

  function stubFetch(connected: boolean) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === '/api/todos' && init?.method !== 'POST') return { ok: true, json: async () => ({ todos: [] }) } as unknown as Response;
        if (url === '/api/github/connection') return { ok: true, json: async () => ({ connection: { connected, tokenType: connected ? 'pat' : null, expiresAt: null, login: null } }) } as unknown as Response;
        if (url === '/api/todos/sync') return { ok: true, json: async () => ({ sync: { upserted: 0, pulled: 0, conflicts: 0, deletedDetected: 0, errors: [] } }) } as unknown as Response;
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }),
    );
  }

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTodoStore.setState({ todos: [], isSyncing: false });
    useGithubStore.setState({ connection: null });
  });

  it('triggers POST /api/todos/sync on mount when connected (AE5)', async () => {
    stubFetch(true);
    renderWithI18n(<TodosPanel onClose={vi.fn()} />);
    await waitFor(() => {
      expect(calls).toContain('POST /api/todos/sync');
    });
  });

  it('does not trigger sync on mount when not connected', async () => {
    stubFetch(false);
    renderWithI18n(<TodosPanel onClose={vi.fn()} />);
    await waitFor(() => expect(calls).toContain('GET /api/todos'));
    // Settle any trailing effects.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).not.toContain('POST /api/todos/sync');
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeInTheDocument();
  });
});
