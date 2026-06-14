import { useState, useCallback, useEffect } from 'react';

/**
 * Tracks whether the WeCom permissions grandfathering banner should show for a
 * workspace, and remembers dismissal in localStorage keyed by workspace ID.
 *
 * Server-side `resolveEffectivePolicy` returns `needsUpgradePrompt: true` when
 * the workspace is bot-enabled and has no `wecomToolPermissions` policy set
 * (the pre-feature grandfathering case). The client uses this hook to avoid
 * re-showing the banner on every WeCom settings open after the admin has
 * dismissed it once.
 *
 * Multi-device note: localStorage is per-browser, so the banner reappears if
 * the admin opens the workspace from a different browser/device. This is
 * acceptable for a UX nicety — the underlying grandfathering state is still
 * server-derived and consistent.
 *
 * Test for this hook lives in U4 once Vitest scaffolding is in place.
 */
export function useWecomPermissionsPrompt({
  workspaceId,
  needsUpgradePrompt,
}: {
  workspaceId: string;
  needsUpgradePrompt: boolean;
}): {
  shouldShow: boolean;
  markShown: () => void;
} {
  const storageKey = `wecom-permissions-prompt-shown:${workspaceId}`;
  const [shown, setShown] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  });

  // Reset shown-state if the workspace changes
  useEffect(() => {
    try {
      setShown(localStorage.getItem(storageKey) === 'true');
    } catch {
      setShown(false);
    }
  }, [storageKey]);

  const markShown = useCallback(() => {
    try {
      localStorage.setItem(storageKey, 'true');
    } catch {
      // localStorage not available; in-memory state still updates
    }
    setShown(true);
  }, [storageKey]);

  return {
    shouldShow: needsUpgradePrompt && !shown,
    markShown,
  };
}
