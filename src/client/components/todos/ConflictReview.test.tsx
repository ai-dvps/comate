import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import ConflictReview from './ConflictReview';
import i18n from '../../i18n';

// MarkdownPreview is stubbed so body conflicts deterministically surface their
// raw value (jsdom-friendly) and so tests can assert it was used for body and
// NOT for title.
vi.mock('../MarkdownPreview', () => ({
  default: ({ content, className }: { content: string; className?: string }) => (
    <div data-testid="markdown-preview" className={className}>
      {content}
    </div>
  ),
}));

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

  // R2: a body value renders through the markdown previewer (formatted), not as
  // raw mono text like a title.
  it('renders a body conflict via the markdown previewer (R2)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/conflicts')) {
        return jsonOk({
          conflicts: [
            { field: 'body', localValue: '# Local body', remoteValue: '# Remote body', baselineValue: '' },
          ],
        });
      }
      return jsonOk({ todo: { id: 't1' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithI18n(<ConflictReview todoId="t1" onResolved={vi.fn()} />);

    // Both sides render through MarkdownPreview (two stubbed previews).
    await waitFor(() => expect(screen.getAllByTestId('markdown-preview')).toHaveLength(2));
    const localEl = screen.getByText('# Local body');
    const remoteEl = screen.getByText('# Remote body');
    // The value lives in the markdown preview, not the title's mono span.
    expect(localEl).toHaveAttribute('data-testid', 'markdown-preview');
    expect(remoteEl).toHaveAttribute('data-testid', 'markdown-preview');
  });

  // R7: choosing local on a body conflict calls the resolve action with the
  // body field and the chosen side.
  it('accept-local on a body conflict resolves with field:body, choice:local (R7)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/conflicts') && init?.method !== 'POST') {
        return jsonOk({
          conflicts: [{ field: 'body', localValue: 'Local body', remoteValue: 'Remote body', baselineValue: '' }],
        });
      }
      return jsonOk({ todo: { id: 't1' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithI18n(<ConflictReview todoId="t1" onResolved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Local body')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Local body').closest('button')!);

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/conflicts/resolve'))).toBe(true));
    const resolveCall = calls.find((c) => c.url.endsWith('/conflicts/resolve'))!;
    expect(JSON.parse(String(resolveCall.init!.body))).toEqual({ field: 'body', choice: 'local' });
  });

  // R7: choosing remote on a body conflict mirrors the local path.
  it('accept-remote on a body conflict resolves with field:body, choice:remote (R7)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/conflicts') && init?.method !== 'POST') {
        return jsonOk({
          conflicts: [{ field: 'body', localValue: 'Local body', remoteValue: 'Remote body', baselineValue: '' }],
        });
      }
      return jsonOk({ todo: { id: 't1' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithI18n(<ConflictReview todoId="t1" onResolved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Remote body')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Remote body').closest('button')!);

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/conflicts/resolve'))).toBe(true));
    const resolveCall = calls.find((c) => c.url.endsWith('/conflicts/resolve'))!;
    expect(JSON.parse(String(resolveCall.init!.body))).toEqual({ field: 'body', choice: 'remote' });
  });

  // A very long body must not grow unbounded: the rendered body sits inside a
  // capped, scrollable container so the narrow panel layout is preserved.
  it('caps a long body value in a scrollable container', async () => {
    const longBody = 'x'.repeat(5000);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/conflicts')) {
        return jsonOk({
          conflicts: [{ field: 'body', localValue: longBody, remoteValue: 'remote', baselineValue: '' }],
        });
      }
      return jsonOk({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithI18n(<ConflictReview todoId="t1" onResolved={vi.fn()} />);
    const previews = await screen.findAllByTestId('markdown-preview');

    // Each rendered body sits inside a capped, scrollable container.
    expect(previews.length).toBeGreaterThan(0);
    for (const preview of previews) {
      const container = preview.parentElement;
      expect(container?.className).toMatch(/max-h-64/);
      expect(container?.className).toMatch(/overflow-auto/);
    }
  });

  // No regression: a title conflict still renders as plain mono text, not via
  // the markdown previewer.
  it('still renders a title conflict as plain mono text (no regression)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/conflicts')) {
        return jsonOk({
          conflicts: [{ field: 'title', localValue: 'Local title', remoteValue: 'Remote title', baselineValue: '' }],
        });
      }
      return jsonOk({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithI18n(<ConflictReview todoId="t1" onResolved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Local title')).toBeInTheDocument());

    // Title uses the mono span, never the markdown previewer.
    expect(screen.queryAllByTestId('markdown-preview')).toHaveLength(0);
    expect(screen.getByText('Local title').className).toMatch(/font-mono/);
  });
});
