import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { WeComBotSection } from './SettingsPanel';
import i18n from '../i18n';
import type { WeComProactiveMessage } from '../../server/models/wecom-proactive-message.js';

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

const mockQueueStore = {
  entriesByWorkspace: {} as Record<string, WeComProactiveMessage[]>,
  isLoading: {} as Record<string, boolean>,
  error: {} as Record<string, string | null>,
  statusFilter: null as string | null,
  fetchEntries: vi.fn(),
  retryEntry: vi.fn(),
  deleteEntry: vi.fn(),
  setStatusFilter: vi.fn(),
};

vi.mock('../stores/wecom-queue-store', () => ({
  useWeComQueueStore: (selector: (state: typeof mockQueueStore) => unknown) => selector(mockQueueStore),
}));

const DEFAULT_STATE = {
  name: 'Test Workspace',
  description: '',
  folderPath: '/tmp/test',
  skills: [],
  mcpServers: [],
  hooks: [],
  wecomBotId: '',
  wecomBotSecret: '',
  wecomBotEnabled: true,
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
  feishuBotEnabled: false,
  feishuBotName: '',
  feishuAdminUserIds: [],
};

describe('WeComBotSection', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockQueueStore.entriesByWorkspace = {};
    mockQueueStore.isLoading = {};
    mockQueueStore.error = {};
    mockQueueStore.statusFilter = null;
    mockQueueStore.fetchEntries.mockReset();
    mockQueueStore.retryEntry.mockReset();
    mockQueueStore.deleteEntry.mockReset();
    mockQueueStore.setStatusFilter.mockReset();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    cleanup();
  });

  it('renders the Queue sub-tab label alongside other WeCom tabs', async () => {
    await renderWithAct(
      <WeComBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Connection/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Users/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Prompts/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Permissions/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Queue/i })).toBeInTheDocument();
  });

  it('renders queue entries when the Queue sub-tab is clicked', async () => {
    mockQueueStore.entriesByWorkspace['ws-1'] = [
      {
        id: 'entry-1',
        workspaceId: 'ws-1',
        senderSessionId: 'session-abc',
        recipientEncryptedUserId: 'enc-1',
        recipientPlaintextUserId: 'Alice',
        messageContent: 'Hello from the queue',
        status: 'pending',
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as WeComProactiveMessage,
    ];

    await renderWithAct(
      <WeComBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Queue/i }));
      await Promise.resolve();
    });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Hello from the queue')).toBeInTheDocument();
  });

  it('unmounts queue entries when switching to another sub-tab', async () => {
    mockQueueStore.entriesByWorkspace['ws-1'] = [
      {
        id: 'entry-1',
        workspaceId: 'ws-1',
        senderSessionId: 'session-abc',
        recipientEncryptedUserId: 'enc-1',
        recipientPlaintextUserId: 'Alice',
        messageContent: 'Hello from the queue',
        status: 'pending',
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as WeComProactiveMessage,
    ];

    await renderWithAct(
      <WeComBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Queue/i }));
      await Promise.resolve();
    });
    expect(screen.getByText('Alice')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Connection/i }));
      await Promise.resolve();
    });
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('shows the disabled banner when the bot is disabled and Queue is open', async () => {
    await renderWithAct(
      <WeComBotSection
        state={{ ...DEFAULT_STATE, wecomBotEnabled: false }}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Queue/i }));
      await Promise.resolve();
    });

    expect(screen.getByText(/WeCom Bot is disabled/i)).toBeInTheDocument();
    expect(screen.getByText(/historical proactive messages/i)).toBeInTheDocument();
  });

  it('shows encrypted IDs and action buttons in the users tab', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        users: [
          {
            encryptedUserId: 'enc-1',
            plaintextUserId: 'Alice',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          },
        ],
      }),
    });

    await renderWithAct(
      <WeComBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
      await Promise.resolve();
    });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/enc-1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resolve pending now/i })).toBeInTheDocument();
  });

  it('reloads the user list when the reload button is clicked', async () => {
    await renderWithAct(
      <WeComBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
      await Promise.resolve();
    });

    const initialUserFetches = mockFetch.mock.calls.filter((call) =>
      String(call[0]).includes('/wecom/users'),
    ).length;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Reload/i }));
      await Promise.resolve();
    });

    const laterUserFetches = mockFetch.mock.calls.filter((call) =>
      String(call[0]).includes('/wecom/users'),
    ).length;
    expect(laterUserFetches).toBeGreaterThan(initialUserFetches);
  });

  it('saves a manual plaintext ID when inline editing', async () => {
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/plaintext')) {
        return {
          ok: true,
          json: async () => ({ encryptedUserId: 'enc-1', plaintextUserId: 'U123' }),
        } as Response;
      }
      if (url.includes('/wecom/users')) {
        return {
          ok: true,
          json: async () => ({
            users: [
              {
                encryptedUserId: 'enc-1',
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    await renderWithAct(
      <WeComBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add plaintext ID/i }));
      await Promise.resolve();
    });

    const input = screen.getByPlaceholderText(/Enterprise userId/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'U123' } });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      await Promise.resolve();
    });

    const plaintextCalls = mockFetch.mock.calls.filter((call) =>
      String(call[0]).includes('/plaintext'),
    );
    expect(plaintextCalls.length).toBe(1);
    expect((plaintextCalls[0][1] as RequestInit)?.method).toBe('POST');
    expect(screen.getByText('U123')).toBeInTheDocument();
  });

  it('shows a duplicate error when the manual plaintext ID is already used', async () => {
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/plaintext')) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'Duplicate' }),
        } as Response;
      }
      if (url.includes('/wecom/users')) {
        return {
          ok: true,
          json: async () => ({
            users: [
              {
                encryptedUserId: 'enc-1',
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    await renderWithAct(
      <WeComBotSection
        state={DEFAULT_STATE}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add plaintext ID/i }));
      await Promise.resolve();
    });

    const input = screen.getByPlaceholderText(/Enterprise userId/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'U123' } });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      await Promise.resolve();
    });

    expect(screen.getByText(/already used by another user/i)).toBeInTheDocument();
  });

  it('triggers an immediate batch resolve and shows the result', async () => {
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/wecom/resolve-pending')) {
        return {
          ok: true,
          json: async () => ({ resolved: 2, failed: 1 }),
        } as Response;
      }
      return { ok: true, json: async () => ({ users: [] }) } as Response;
    });

    await renderWithAct(
      <WeComBotSection
        state={{ ...DEFAULT_STATE, wecomCorpId: 'CORP', wecomCorpSecret: 'SECRET' }}
        onUpdate={vi.fn()}
        workspaceId="ws-1"
        onSave={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Users/i }));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resolve pending now/i }));
      await Promise.resolve();
    });

    const resolveCalls = mockFetch.mock.calls.filter((call) =>
      String(call[0]).includes('/wecom/resolve-pending'),
    );
    expect(resolveCalls.length).toBe(1);
    expect(resolveCalls[0][1]).toMatchObject({ method: 'POST' });
    expect(screen.getByText(/Resolved 2 user\(s\), 1 failed\./i)).toBeInTheDocument();
  });
});
