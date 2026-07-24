import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  onAction,
} from '@tauri-apps/plugin-notification';
import type { SchedulerRunEventPayload } from '@/lib/scheduled-task-events';

let permissionState: 'unknown' | 'granted' | 'denied' = 'unknown';

/**
 * Desktop notification bridge (R15): the client receives scheduler run events
 * over the WebSocket relay and turns them into Tauri desktop notifications.
 * When the OS permission is missing we request it once; when the user denies,
 * runs degrade silently to the in-app badge (macOS grant rate is not
 * guaranteed — degraded path is first-class).
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionState === 'granted') return true;
  if (permissionState === 'denied') return false;
  try {
    if (await isPermissionGranted()) {
      permissionState = 'granted';
      return true;
    }
    const result = await requestPermission();
    permissionState = result === 'granted' ? 'granted' : 'denied';
    return result === 'granted';
  } catch {
    // Not running inside Tauri (e.g. plain browser dev server) — degrade to in-app only.
    permissionState = 'denied';
    return false;
  }
}

let clickListenerReady = false;
let latestJump: { workspaceId: string; sessionId: string } | null = null;

/**
 * Register the notification-click handler once. The jump callback (KTD-4) is
 * supplied by the app shell so this module stays navigation-agnostic. When
 * several notifications arrive before a click, the latest run wins — noted
 * v1 simplification.
 */
export function initNotificationClickHandler(
  onJumpToSession: (workspaceId: string, sessionId: string) => void,
): void {
  if (clickListenerReady) return;
  clickListenerReady = true;
  void onAction(() => {
    if (latestJump) {
      onJumpToSession(latestJump.workspaceId, latestJump.sessionId);
      latestJump = null;
    }
  }).catch(() => {
    // Non-Tauri environment; clicks are a no-op.
  });
}

/**
 * Send a desktop notification for a finished scheduled-task run. Clicking it
 * jumps to the run session when the run has a session id.
 */
export async function notifyRunFinished(event: SchedulerRunEventPayload): Promise<void> {
  if (event.kind !== 'run-finished') return;
  if (event.status !== 'succeeded' && event.status !== 'failed') return;
  if (!(await ensureNotificationPermission())) return;

  const body = (event.resultText ?? event.reason ?? '').trim();
  sendNotification({
    title: `定时任务${event.status === 'succeeded' ? '执行成功' : '执行失败'}：${event.taskName}`,
    body: body ? (body.length > 120 ? `${body.slice(0, 120)}…` : body) : undefined,
  });

  if (event.sessionId) {
    latestJump = { workspaceId: event.workspaceId, sessionId: event.sessionId };
  }
}
