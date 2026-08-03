import { useState, useCallback, useEffect } from 'react';

/**
 * Tracks whether the legacy-whitelist upgrade banner should show for a bot,
 * and remembers dismissal in localStorage keyed by bot ID.
 *
 * Follows the useWecomPermissionsPrompt pattern (R14/KTD-27): when a bot
 * still carries data in the deprecated `skillAllowlist`/`bashWhitelist`
 * fields, the sandbox permission model ignores that data — the banner tells
 * the desktop admin the old whitelist is disabled, that the passlist defaults
 * to empty, and to re-add rules as needed. Once the admin saves the role
 * policy, the legacy fields are cleared and `hasLegacyData` goes false, so
 * the banner never reappears (dismissal is only a cosmetic shortcut).
 *
 * Multi-device note: localStorage is per-browser, so the banner can reappear
 * on another device until the legacy data is actually cleared by a save.
 */
export function useBotPasslistUpgradeBanner({
  botId,
  hasLegacyData,
}: {
  botId: string;
  hasLegacyData: boolean;
}): {
  shouldShow: boolean;
  dismiss: () => void;
} {
  const storageKey = `bot-passlist-upgrade-banner-dismissed:${botId}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  });

  // Reset dismissed-state when the bot changes
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(storageKey) === 'true');
    } catch {
      setDismissed(false);
    }
  }, [storageKey]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(storageKey, 'true');
    } catch {
      // localStorage not available; in-memory state still updates
    }
    setDismissed(true);
  }, [storageKey]);

  return {
    shouldShow: hasLegacyData && !dismissed,
    dismiss,
  };
}
