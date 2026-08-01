import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { store } from '../storage/sqlite-store.js';
import { todoExecutionService } from './todo-execution-service.js';
import { todoSchedulerService } from './todo-scheduler-service.js';
import { createStatelessMcpHttpRouter } from './mcp-http-router.js';

export const SCHEDULED_TASKS_MCP_KEY = 'comate-scheduled-tasks';

const token = randomBytes(24).toString('hex');

export function getScheduledTasksMcpToken(): string {
  return token;
}

export interface ScheduledTasksMcpDeps {
  workspaceId: string;
  /** Session source from the sessions table; 'scheduled' runs get no tools. */
  source: string | undefined;
}

/**
 * Resolve the MCP surface for a session from its row: local GUI sessions get
 * the full tool set, bot sessions (wecom/feishu) get create + list only,
 * scheduled-run sessions get nothing.
 */
export async function resolveScheduledTasksMcpDeps(sessionId: string): Promise<ScheduledTasksMcpDeps | null> {
  const session = store.getLocalSession(sessionId);
  if (!session) return null;
  if (session.source === 'scheduled') return null;
  return { workspaceId: session.workspaceId, source: session.source };
}

const scheduleInput = {
  scheduleType: z.enum(['once', 'recurring']).describe('once = 一次性延迟；recurring = 周期'),
  scheduleTime: z
    .string()
    .optional()
    .describe('once 必填：ISO 时间（本地时区），必须是将来的时间'),
  cronExpr: z
    .string()
    .optional()
    .describe('recurring 必填：标准 5 字段 cron（本地时区），不支持 L/W/? 与别名'),
};

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function describeSchedule(task: { executionType: string; scheduleTime: string | null; cronExpr: string | null }): string {
  return task.executionType === 'once' ? `一次性 ${task.scheduleTime}` : `周期 ${task.cronExpr}`;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  /**
   * U9 (KTD-20): MCP-spec annotations advertised on tools/list. The bot
   * permission gate classifies first-party tools by these hints
   * (readOnlyHint → read-class, otherwise write-class) instead of the
   * fail-closed unknown class.
   */
  annotations: { readOnlyHint: boolean };
  handler: (args: never) => Promise<CallToolResult>;
}

/**
 * The tool set for a session (per-source 分级):
 * - local GUI sessions: create / list / pause / resume / run-now
 * - bot sessions (wecom/feishu): create + list only
 * - human-only by design (never exposed): edit, delete
 * Tasks are active at creation — every surface uses the same unified path.
 */
export function buildScheduledTaskToolDefinitions(deps: ScheduledTasksMcpDeps): ToolDef[] {
  // Write-class (U9): creates a persistent scheduled task — the bot gate
  // routes it through approval for regular members.
  const createTool: ToolDef = {
    name: 'create_scheduled_task',
    annotations: { readOnlyHint: false },
    description:
      '创建一个定时任务（创建后立即生效并进入调度）。' +
      'instruction 必须是自包含提示词：不要写"这个/如上/刚才"等依赖当前聊天上下文的指代，写清工作区相对路径与完成标准——执行时是一个全新会话，看不到本次对话。',
    inputSchema: {
      name: z.string().min(1).describe('任务名称'),
      instruction: z.string().min(1).describe('自包含执行指令'),
      ...scheduleInput,
    },
    handler: (async (args: {
      name: string;
      instruction: string;
      scheduleType: 'once' | 'recurring';
      scheduleTime?: string;
      cronExpr?: string;
    }) => {
      try {
        const task = store.createTodo(deps.workspaceId, {
          text: args.name, instruction: args.instruction, executionType: args.scheduleType,
          scheduleTime: args.scheduleTime ?? null, cronExpr: args.cronExpr ?? null,
        });
        const configured = store.updateTodo(task.id, { nextFireAt: todoSchedulerService.recomputeNextFire(task) })!;
        return textResult(`Todo 已创建并生效（id: ${configured.id}），将按调度执行。可在 Comate 的 Todo 面板中查看和管理。`);
      } catch (err) {
        return textResult(`创建任务失败：${err instanceof Error ? err.message : String(err)}`, true);
      }
    }),
  };

  const listTool: ToolDef = {
    name: 'list_scheduled_tasks',
    annotations: { readOnlyHint: true },
    description: '列出当前工作区的定时任务（含状态、下次触发时间、最近一次执行状态）。',
    inputSchema: {},
    handler: (async () => {
      const tasks = store.getAllTodos({ workspaceId: deps.workspaceId })
        .filter((todo) => todo.executionType === 'once' || todo.executionType === 'recurring')
        .map(
          (t) =>
            `- [${t.executionStatus}] ${t.text}（${describeSchedule(t)}）下次触发: ${t.nextFireAt ?? '—'}；最近执行: ${store.getLatestTodoRun(t.id)?.status ?? '无'}（id: ${t.id}）`,
        );
      return textResult(tasks.length > 0 ? tasks.join('\n') : '当前工作区没有定时任务。');
    }),
  };

  if (deps.source === 'wecom' || deps.source === 'feishu') {
    return [createTool, listTool];
  }

  const pauseTool: ToolDef = {
    name: 'pause_scheduled_task',
    annotations: { readOnlyHint: false },
    description: '暂停一个定时任务（不再按调度触发，可随时恢复）。',
    inputSchema: { taskId: z.string().min(1) },
    handler: (async (args: { taskId: string }) => {
      try {
        // Scope to the session's workspace: an agent must not mutate tasks
        // belonging to another workspace by guessing their ids.
        const task = store.getTodoById(args.taskId);
        if (!task || task.workspaceId !== deps.workspaceId) throw new Error('Todo 不存在');
        store.updateTodo(task.id, { executionStatus: 'paused', nextFireAt: null });
        return textResult('任务已暂停。');
      } catch (err) {
        return textResult(`暂停失败：${err instanceof Error ? err.message : String(err)}`, true);
      }
    }),
  };

  const resumeTool: ToolDef = {
    name: 'resume_scheduled_task',
    annotations: { readOnlyHint: false },
    description: '恢复一个已暂停的定时任务。',
    inputSchema: { taskId: z.string().min(1) },
    handler: (async (args: { taskId: string }) => {
      try {
        const task = store.getTodoById(args.taskId);
        if (!task || task.workspaceId !== deps.workspaceId) throw new Error('Todo 不存在');
        store.updateTodo(task.id, { executionStatus: 'active', nextFireAt: todoSchedulerService.recomputeNextFire(task) });
        return textResult('任务已恢复，将按调度继续触发。');
      } catch (err) {
        return textResult(`恢复失败：${err instanceof Error ? err.message : String(err)}`, true);
      }
    }),
  };

  const runNowTool: ToolDef = {
    name: 'run_scheduled_task_now',
    annotations: { readOnlyHint: false },
    description: '立即执行一个定时任务。',
    inputSchema: { taskId: z.string().min(1) },
    handler: (async (args: { taskId: string }) => {
      try {
        const task = store.getTodoById(args.taskId);
        if (!task || task.workspaceId !== deps.workspaceId) throw new Error('Todo 不存在');
        const run = await todoExecutionService.runNow(args.taskId);
        return textResult(`已触发执行（run id: ${run.id}），执行过程可在任务执行历史或对应会话中查看。`);
      } catch (err) {
        return textResult(`无法执行：${err instanceof Error ? err.message : String(err)}`, true);
      }
    }),
  };

  return [createTool, listTool, pauseTool, resumeTool, runNowTool];
}

/**
 * Stateless HTTP MCP endpoint, mounted before the global guards like the
 * browser MCP (its requests carry a bearer token, not browser origins).
 * Transport plumbing is shared in mcp-http-router.ts.
 */
export function createScheduledTasksMcpHttpRouter(
  depsFor: (sessionId: string) => Promise<ScheduledTasksMcpDeps | null>,
): Router {
  return createStatelessMcpHttpRouter<ScheduledTasksMcpDeps>({
    name: SCHEDULED_TASKS_MCP_KEY,
    version: '0.1.0',
    token,
    logTag: 'scheduled-tasks-mcp',
    depsFor,
    registerTools: (server, _sessionId, deps) => {
      for (const def of buildScheduledTaskToolDefinitions(deps)) {
        server.registerTool(
          def.name,
          { description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
          def.handler as never,
        );
      }
    },
  });
}
