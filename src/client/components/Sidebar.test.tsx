import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import Sidebar from './Sidebar';
import i18n from '../i18n';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const mockStore = {
  activeWorkspaceId: 'ws-1',
};

vi.mock('../stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders exactly three tabs: Sessions, Todos, and Files', () => {
    renderWithI18n(
      <Sidebar
        width={240}
        onWidthChange={vi.fn()}
        onFileClick={vi.fn()}
        onFileDoubleClick={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Todos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Queue' })).not.toBeInTheDocument();
  });
});
