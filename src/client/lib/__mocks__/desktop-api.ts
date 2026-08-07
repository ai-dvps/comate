/**
 * Manual mock for ../desktop-api — the single bridge boundary. Tests
 * `vi.mock('<path>/desktop-api')` and get this surface; default state is the
 * plain-browser degradation (isDesktop() === false, everything no-op/null).
 * Individual tests override the exported vi.fn()s as needed.
 */
import { vi } from 'vitest';

export const isDesktop = vi.fn(() => false);
export const getApiInfo = vi.fn(() => Promise.resolve(null));
export const getApiBase = vi.fn(() => Promise.resolve(''));
export const getApiToken = vi.fn(() => Promise.resolve(''));
export const getWebSocketUrl = vi.fn(() => Promise.resolve(''));
export const initDesktopApi = vi.fn();
export const showWindow = vi.fn(() => Promise.resolve());
export const startWindowDrag = vi.fn(() => Promise.resolve());
export const updateBadgeState = vi.fn(() => Promise.resolve());
export const revealInFileManager = vi.fn(() => Promise.resolve());
export const openExternal = vi.fn(() => Promise.resolve());
export const openDirectoryDialog = vi.fn((): Promise<string | null> => Promise.resolve(null));
export const isNotificationPermissionGranted = vi.fn(() => Promise.resolve(false));
export const requestNotificationPermission = vi.fn(() => Promise.resolve(false));
export const sendDesktopNotification = vi.fn();
export const onNotificationAction = vi.fn(() => Promise.resolve());
export const checkForUpdate = vi.fn(() => Promise.resolve(null));
export const prepareUpdaterRelaunch = vi.fn(() => Promise.resolve());
export const relaunchApp = vi.fn(() => Promise.resolve());
export const getAppVersion = vi.fn((): Promise<string | null> => Promise.resolve(null));
export const getDesktopBridge = vi.fn(() => null);
