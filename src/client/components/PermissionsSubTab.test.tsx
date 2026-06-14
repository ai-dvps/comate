import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { PermissionsSubTab } from './PermissionsSubTab';
import {
  ALLOW_ALL_PRESET,
  SAFE_PRESET,
  type ToolPermissionPolicy,
} from '../types/wecom-permissions';
import i18n from '../i18n';

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('PermissionsSubTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('renders all six categories', () => {
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={SAFE_PRESET} onUpdate={onUpdate} />);

    expect(screen.getByText('File Read')).toBeInTheDocument();
    expect(screen.getByText('File Write')).toBeInTheDocument();
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('Sub-agents')).toBeInTheDocument();
    expect(screen.getByText('Reply')).toBeInTheDocument();
  });

  it('renders posture selector with three options', () => {
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={SAFE_PRESET} onUpdate={onUpdate} />);

    expect(screen.getByRole('button', { name: /Allow all/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Safe$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Custom/i })).toBeInTheDocument();
  });

  it('clicking "Allow all" preset rewrites categoryDefaults to all allow and sets posture', () => {
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={SAFE_PRESET} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: /Allow all/i }));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const arg = onUpdate.mock.calls[0][0] as ToolPermissionPolicy;
    expect(arg.posture).toBe('allow-all');
    expect(arg.categoryDefaults.fileRead).toBe('allow');
    expect(arg.categoryDefaults.fileWrite).toBe('allow');
    expect(arg.categoryDefaults.shell).toBe('allow');
    expect(arg.categoryDefaults.network).toBe('allow');
    expect(arg.categoryDefaults.subagents).toBe('allow');
    expect(arg.categoryDefaults.reply).toBe('allow');
  });

  it('clicking "Safe" preset applies the safe defaults from R3 table', () => {
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={ALLOW_ALL_PRESET} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: /^Safe$/i }));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const arg = onUpdate.mock.calls[0][0] as ToolPermissionPolicy;
    expect(arg.posture).toBe('safe');
    expect(arg.categoryDefaults.fileRead).toBe('allow');
    expect(arg.categoryDefaults.fileWrite).toBe('deny');
    expect(arg.categoryDefaults.shell).toBe('deny');
    expect(arg.categoryDefaults.network).toBe('deny');
    expect(arg.categoryDefaults.subagents).toBe('deny');
    expect(arg.categoryDefaults.reply).toBe('allow');
  });

  it('manual category toggle flips posture to custom (R2 state-transition rule)', () => {
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={SAFE_PRESET} onUpdate={onUpdate} />);

    // Toggle File Write from deny to allow — should flip posture to custom
    const fileWriteCard = screen.getByText('File Write').closest('div.border')!;
    const allowButton = fileWriteCard.querySelector('button')!;
    fireEvent.click(allowButton);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const arg = onUpdate.mock.calls[0][0] as ToolPermissionPolicy;
    expect(arg.posture).toBe('custom');
    expect(arg.categoryDefaults.fileWrite).toBe('allow');
    // Other categories retain safe-preset values
    expect(arg.categoryDefaults.fileRead).toBe('allow');
    expect(arg.categoryDefaults.shell).toBe('deny');
  });

  it('expanding a category shows the tool list with override controls', () => {
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={SAFE_PRESET} onUpdate={onUpdate} />);

    // Shell category only contains Bash — expand it
    const shellCard = screen.getByText('Shell').closest('div.border')!;
    const expandButton = shellCard.querySelector('button[aria-label="expand"]')!;
    fireEvent.click(expandButton);

    // The Bash tool should now be visible with its code label
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('clicking "Always allow" override on a denied-category tool emits an allow override', () => {
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={SAFE_PRESET} onUpdate={onUpdate} />);

    // Expand Shell (only contains Bash)
    const shellCard = screen.getByText('Shell').closest('div.border')!;
    fireEvent.click(shellCard.querySelector('button[aria-label="expand"]')!);

    // Click "Always allow" on the Bash row
    const bashRow = screen.getByText('Bash').closest('div.flex')!;
    const allowButtons = bashRow.querySelectorAll('button');
    // Order: inherit, alwaysAllow, alwaysDeny
    const alwaysAllowBtn = allowButtons[1];
    fireEvent.click(alwaysAllowBtn);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const arg = onUpdate.mock.calls[0][0] as ToolPermissionPolicy;
    expect(arg.posture).toBe('custom');
    expect(arg.overrides?.Bash).toBe('allow');
    // Category default unchanged
    expect(arg.categoryDefaults.shell).toBe('deny');
  });

  it('clicking "Inherit" removes an existing override', () => {
    const policyWithOverride: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
      overrides: { Bash: 'allow' },
    };
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={policyWithOverride} onUpdate={onUpdate} />);

    const shellCard = screen.getByText('Shell').closest('div.border')!;
    fireEvent.click(shellCard.querySelector('button[aria-label="expand"]')!);

    const bashRow = screen.getByText('Bash').closest('div.flex')!;
    const inheritBtn = bashRow.querySelectorAll('button')[0];
    fireEvent.click(inheritBtn);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const arg = onUpdate.mock.calls[0][0] as ToolPermissionPolicy;
    expect(arg.overrides).toBeUndefined();
  });

  it('undefined policy is treated as allow-all for display', () => {
    const onUpdate = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={undefined} onUpdate={onUpdate} />);

    // No assertion failure means the component rendered without crashing
    // with undefined policy (which the grandfathered-default case uses).
    expect(screen.getByText('File Read')).toBeInTheDocument();
  });

  it('renders the policy-freeze hint below the posture selector', () => {
    renderWithI18n(<PermissionsSubTab policy={SAFE_PRESET} onUpdate={vi.fn()} />);

    expect(screen.getByText(/Changes apply to the next bot session/)).toBeInTheDocument();
  });

  it('F4 flow: select preset → toggle one override → policy persists with both (integration)', () => {
    // Step 1: select Safe preset on an allow-all policy
    const onUpdate1 = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={ALLOW_ALL_PRESET} onUpdate={onUpdate1} />);
    fireEvent.click(screen.getByRole('button', { name: /^Safe$/i }));
    const afterPreset = onUpdate1.mock.calls[0][0] as ToolPermissionPolicy;
    expect(afterPreset.posture).toBe('safe');
    expect(afterPreset.categoryDefaults.shell).toBe('deny');

    // Step 2: clean up and re-render with the new policy, then apply an override
    cleanup();
    const onUpdate2 = vi.fn();
    renderWithI18n(<PermissionsSubTab policy={afterPreset} onUpdate={onUpdate2} />);

    const shellCard = screen.getByText('Shell').closest('div.border')!;
    fireEvent.click(shellCard.querySelector('button[aria-label="expand"]')!);
    const bashRow = screen.getByText('Bash').closest('div.flex')!;
    fireEvent.click(bashRow.querySelectorAll('button')[1]); // Always allow

    const final = onUpdate2.mock.calls[0][0] as ToolPermissionPolicy;
    expect(final.posture).toBe('custom');
    expect(final.categoryDefaults.shell).toBe('deny'); // safe default preserved
    expect(final.overrides?.Bash).toBe('allow'); // override applied
  });
});
