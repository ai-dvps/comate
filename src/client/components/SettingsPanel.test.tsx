import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { FeishuBotSection } from './SettingsPanel';
import i18n from '../i18n';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

async function renderWithAct(ui: React.ReactElement) {
  const result = renderWithI18n(ui);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

const mockFetch = vi.fn();

const DEFAULT_STATE = {
  name: 'Test Workspace',
  description: '',
  folderPath: '/tmp/test',
  skills: [],
  mcpServers: [],
  hooks: [],
  wecomBotId: '',
  wecomBotSecret: '',
  wecomBotEnabled: false,
  wecomBotName: '',
  wecomCorpId: '',
  wecomCorpSecret: '',
  wecomFilePromptTemplate: '',
  wecomToolPermissions: undefined,
  wecomBotIsolation: {
    adminUserIds: [],
    defaultAllowedSkills: [],
    adminAllowedSkills: [],
    bashWhitelist: [],
  },
  promptHistoryRetentionDays: '30',
  feishuAppId: '',
  feishuAppSecret: '',
  feishuEncryptKey: '',
  feishuVerificationToken: '',
  feishuBotEnabled: true,
  feishuBotName: '',
  feishuAdminUserIds: [],
};

describe('FeishuBotSection', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ users: [] }),
    });
    cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the users tab button alongside the connection tab', async () => {
    await renderWithAct(
      <FeishuBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    expect(screen.getByRole('button', { name: /Connection/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Users/i })).toBeInTheDocument();
  });

  it('renders a bot name input and calls onUpdate when changed', async () => {
    const onUpdate = vi.fn();
    await renderWithAct(
      <FeishuBotSection
        state={{ ...DEFAULT_STATE, feishuBotName: 'Acme Bot' }}
        onUpdate={onUpdate}
        workspaceId="ws-1"
      />,
    );

    const input = screen.getByPlaceholderText(/My Bot/i) as HTMLInputElement;
    expect(input.value).toBe('Acme Bot');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'New Bot' } });
    });

    expect(onUpdate).toHaveBeenCalledWith({ feishuBotName: 'New Bot' });
  });

  it('shows loading state then resolved users when switching to the users tab', async () => {
    let resolveJson: (value: { users: unknown[] }) => void = () => undefined;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        new Promise((resolve) => {
          resolveJson = resolve;
        }),
    });

    await renderWithAct(
      <FeishuBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
    });

    expect(screen.getByText(/Loading Feishu users/i)).toBeInTheDocument();

    await act(async () => {
      resolveJson({
        users: [
          {
            openId: 'ou-alice',
            userId: 'alice-uid',
            name: 'Alice',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            namePending: false,
          },
        ],
      });
      await Promise.resolve();
    });

    expect(screen.queryByText(/Loading Feishu users/i)).not.toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('ou-alice')).toBeInTheDocument();
    expect(screen.queryByText(/Pending resolution/i)).not.toBeInTheDocument();
  });

  it('shows open_id and a pending badge when the user has no cached name', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        users: [
          {
            openId: 'ou-bob',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            namePending: true,
          },
        ],
      }),
    });

    await renderWithAct(
      <FeishuBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
    });

    expect(screen.getAllByText('ou-bob').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Pending resolution/i)).toBeInTheDocument();
  });

  it('shows the empty state when no users exist', async () => {
    await renderWithAct(
      <FeishuBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
    });

    expect(screen.getByText(/No Feishu users have messaged/i)).toBeInTheDocument();
  });

  it('shows an error message and a retry button when the fetch fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    });

    await renderWithAct(
      <FeishuBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
    });

    expect(screen.getByText(/Failed to load Feishu users/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('resets to the connection tab when the workspace changes', async () => {
    const { rerender } = await renderWithAct(
      <FeishuBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
    });
    expect(screen.getByText(/No Feishu users have messaged/i)).toBeInTheDocument();

    await act(async () => {
      rerender(
        <I18nextProvider i18n={i18n}>
          <FeishuBotSection
            state={DEFAULT_STATE}
            onUpdate={vi.fn()}
            workspaceId="ws-2"
          />
        </I18nextProvider>,
      );
      await Promise.resolve();
    });

    expect(screen.queryByText(/No Feishu users have messaged/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connection/i })).toHaveClass('border-accent');
  });

  it('polls the users endpoint every 10 seconds while the users tab is open', async () => {
    await renderWithAct(
      <FeishuBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
    });

    // One initial fetch for status, then one for users.
    const userFetches = mockFetch.mock.calls.filter((call) =>
      String(call[0]).includes('/feishu/users'),
    );
    expect(userFetches.length).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });

    const laterUserFetches = mockFetch.mock.calls.filter((call) =>
      String(call[0]).includes('/feishu/users'),
    );
    expect(laterUserFetches.length).toBe(2);
  });
});
