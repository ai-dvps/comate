import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWecomPermissionsPrompt } from './use-wecom-permissions-prompt';

describe('useWecomPermissionsPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns shouldShow=true when needsUpgradePrompt is true and not yet shown', () => {
    const { result } = renderHook(() =>
      useWecomPermissionsPrompt({ workspaceId: 'ws-1', needsUpgradePrompt: true }),
    );
    expect(result.current.shouldShow).toBe(true);
  });

  it('returns shouldShow=false when needsUpgradePrompt is false', () => {
    const { result } = renderHook(() =>
      useWecomPermissionsPrompt({ workspaceId: 'ws-1', needsUpgradePrompt: false }),
    );
    expect(result.current.shouldShow).toBe(false);
  });

  it('returns shouldShow=false after markShown is called', () => {
    const { result } = renderHook(() =>
      useWecomPermissionsPrompt({ workspaceId: 'ws-1', needsUpgradePrompt: true }),
    );
    expect(result.current.shouldShow).toBe(true);
    act(() => result.current.markShown());
    expect(result.current.shouldShow).toBe(false);
  });

  it('persists shown state in localStorage keyed by workspace ID', () => {
    const { result } = renderHook(() =>
      useWecomPermissionsPrompt({ workspaceId: 'ws-1', needsUpgradePrompt: true }),
    );
    act(() => result.current.markShown());
    expect(localStorage.getItem('wecom-permissions-prompt-shown:ws-1')).toBe('true');
  });

  it('different workspace IDs have independent shown-state', () => {
    const { result: r1 } = renderHook(() =>
      useWecomPermissionsPrompt({ workspaceId: 'ws-1', needsUpgradePrompt: true }),
    );
    act(() => r1.current.markShown());
    expect(r1.current.shouldShow).toBe(false);

    const { result: r2 } = renderHook(() =>
      useWecomPermissionsPrompt({ workspaceId: 'ws-2', needsUpgradePrompt: true }),
    );
    expect(r2.current.shouldShow).toBe(true);
  });

  it('reads shown state from localStorage on initial render', () => {
    localStorage.setItem('wecom-permissions-prompt-shown:ws-1', 'true');
    const { result } = renderHook(() =>
      useWecomPermissionsPrompt({ workspaceId: 'ws-1', needsUpgradePrompt: true }),
    );
    expect(result.current.shouldShow).toBe(false);
  });
});
