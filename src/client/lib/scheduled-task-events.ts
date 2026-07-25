/**
 * Payload of the `scheduled_task_event` WebSocket event relayed from the
 * server (see src/server/websocket/server.ts relaySchedulerEvents).
 */
export interface SchedulerRunEventPayload {
  kind: 'run-started' | 'run-finished' | 'task-created';
  taskId: string;
  taskName: string;
  workspaceId: string;
  runId?: string;
  sessionId?: string | null;
  status?: 'running' | 'succeeded' | 'failed' | 'missed' | 'skipped';
  resultText?: string | null;
  reason?: string | null;
}
