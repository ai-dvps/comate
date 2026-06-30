import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import BotGeneralSection from './BotGeneralSection';
import { emptyForm } from './bot-form-utils';
import type { Workspace } from '../stores/workspace-store';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const workspaces: Workspace[] = [
  { id: 'ws-1', name: 'Workspace One', description: '', folderPath: '/tmp/ws1', skills: [], mcpServers: [], hooks: [], createdAt: '', updatedAt: '', settings: {} },
  { id: 'ws-2', name: 'Workspace Two', description: '', folderPath: '/tmp/ws2', skills: [], mcpServers: [], hooks: [], createdAt: '', updatedAt: '', settings: {} },
];

describe('BotGeneralSection', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders name and active workspace fields', () => {
    renderWithI18n(
      <BotGeneralSection form={emptyForm()} onUpdate={vi.fn()} workspaces={workspaces} />,
    );

    expect(screen.getByPlaceholderText('My Bot')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('calls onUpdate when name changes', () => {
    const onUpdate = vi.fn();
    renderWithI18n(
      <BotGeneralSection form={emptyForm()} onUpdate={onUpdate} workspaces={workspaces} />,
    );

    const input = screen.getByPlaceholderText('My Bot');
    fireEvent.change(input, { target: { value: 'TeamBot' } });
    expect(onUpdate).toHaveBeenCalledWith({ name: 'TeamBot' });
  });

  it('calls onUpdate when workspace changes', () => {
    const onUpdate = vi.fn();
    renderWithI18n(
      <BotGeneralSection form={emptyForm()} onUpdate={onUpdate} workspaces={workspaces} />,
    );

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Workspace Two'));
    expect(onUpdate).toHaveBeenCalledWith({ activeWorkspaceId: 'ws-2' });
  });
});
