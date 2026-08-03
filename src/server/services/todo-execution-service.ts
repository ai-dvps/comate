import { EventEmitter } from 'node:events';
import { store as defaultStore, type SqliteStore } from '../storage/sqlite-store.js';
import { chatService } from './chat-service.js';
import { buildGoalPrompt } from './goal-wrapper.js';
import type { Todo } from '../models/todo.js';
import type { TodoRun } from '../models/todo-run.js';
import type { ChatSession } from '../models/session.js';
import type { SseEvent } from '../types/message.js';

export type TodoExecutionErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID';

export class TodoExecutionError extends Error {
  constructor(public code: TodoExecutionErrorCode, message: string) {
    super(message);
  }
}

interface ChatLike {
  createSession(input: { workspaceId: string; name: string; source?: string; approvalMode?: string }): Promise<ChatSession>;
  pushMessage(sessionId: string, workspaceId: string, message: string, isBotSession?: boolean,
    handler?: (id: number, event: SseEvent) => void): Promise<void>;
}

export interface TodoRunEvent {
  todoId: string;
  todoText: string;
  workspaceId: string;
  run: TodoRun;
}

/** Single owner for manual and automatic execution. A Todo's status is never
 * settled here: a Run outcome is operational history, not human completion. */
export class TodoExecutionService {
  private readonly inFlight = new Set<string>();
  private chatOverride?: ChatLike;

  constructor(private readonly store: SqliteStore = defaultStore, chat?: ChatLike) {
    this.chatOverride = chat;
  }

  private chat(): ChatLike {
    if (!this.chatOverride) this.chatOverride = chatService as unknown as ChatLike;
    return this.chatOverride;
  }

  async runNow(todoId: string, fireAt = new Date().toISOString()): Promise<TodoRun> {
    const todo = this.store.getTodoById(todoId);
    if (!todo || todo.deletedAt) throw new TodoExecutionError('NOT_FOUND', 'Todo not found');
    if (todo.status !== 'pending') throw new TodoExecutionError('CONFLICT', 'Todo must be pending to run');
    if (!todo.workspaceId) throw new TodoExecutionError('INVALID', 'workspaceId is required before this Todo can run');
    if (this.inFlight.has(todo.id) || this.store.getLatestTodoRun(todo.id)?.status === 'running') {
      throw new TodoExecutionError('CONFLICT', '该 Todo 已有执行中的 Run');
    }
    this.inFlight.add(todo.id);
    try {
      return await this.start(todo, fireAt);
    } finally {
      this.inFlight.delete(todo.id);
    }
  }

  private async start(todo: Todo, fireAt: string): Promise<TodoRun> {
    const instruction = todo.instruction?.trim() || todo.content?.trim() || todo.text;
    const snapshot = buildGoalPrompt(instruction);
    const now = new Date().toISOString();
    try {
      const session = await this.chat().createSession({
        workspaceId: todo.workspaceId!,
        name: `${todo.text} · ${fireAt.slice(0, 16).replace('T', ' ')}`,
        source: todo.executionType === 'manual' ? 'todo' : 'scheduled',
        approvalMode: 'auto',
      });
      const run = this.store.createTodoRun({
        todoId: todo.id, sessionId: session.id, status: 'running', fireAt, startedAt: now, instructionSnapshot: snapshot,
      });
      // Keep the old pointer as a backwards-compatible latest session link;
      // history is owned exclusively by todo_runs.
      this.store.linkTodoToSession(todo.id, session.id);
      todoRunEvents.emit('run-started', { todoId: todo.id, todoText: todo.text, workspaceId: todo.workspaceId!, run } satisfies TodoRunEvent);
      let settled = false;
      const settle = (event: Extract<SseEvent, { type: 'result' }> | null, error?: unknown): void => {
        if (settled) return;
        settled = true;
        const result = event?.result ?? null;
        const failed = error !== undefined || event?.isError === true;
        const updated = this.store.updateTodoRun(run.id, {
          status: failed ? 'failed' : 'succeeded', endedAt: new Date().toISOString(),
          reason: error ? (error instanceof Error ? error.message : String(error)) : (failed ? (result ?? '执行失败') : null),
        })!;
        todoRunEvents.emit('run-finished', { todoId: todo.id, todoText: todo.text, workspaceId: todo.workspaceId!, run: updated } satisfies TodoRunEvent);
      };
      this.chat().pushMessage(session.id, todo.workspaceId!, snapshot, false, (_id, event) => {
        if (event.type === 'result') settle(event);
      }).catch((error) => settle(null, error));
      return run;
    } catch (error) {
      const run = this.store.createTodoRun({
        todoId: todo.id, status: 'failed', fireAt, endedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error), instructionSnapshot: snapshot,
      });
      todoRunEvents.emit('run-finished', { todoId: todo.id, todoText: todo.text, workspaceId: todo.workspaceId!, run } satisfies TodoRunEvent);
      return run;
    }
  }
}

export const todoRunEvents = new EventEmitter();
todoRunEvents.setMaxListeners(50);
export const todoExecutionService = new TodoExecutionService();
