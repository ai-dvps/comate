import { randomBytes } from 'node:crypto';
import { Router, json, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { store } from '../storage/sqlite-store.js';
import { scheduledTasksService } from './scheduled-tasks-service.js';
import { SchedulerError } from './scheduler-service.js';
import { diagLog } from '../utils/diag-logger.js';

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
 * Resolve the MCP surface for a session from its row (KTD-5): local GUI
 * sessions get the full tool set, bot sessions (wecom/feishu) get only the
 * draft tool, scheduled-run sessions get nothing.
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

function describeSchedule(task: { scheduleType: string; scheduleTime: string | null; cronExpr: string | null }): string {
  return task.scheduleType === 'once' ? `一次性 ${task.scheduleTime}` : `周期 ${task.cronExpr}`;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: never) => Promise<CallToolResult>;
}

/**
 * The tool set for a session (KTD-5 分级):
 * - every surface: create_scheduled_task_draft (drafts always need UI confirm)
 * - local GUI only: list / pause / resume / run-now
 * - human-only by design (never exposed): confirm, edit, delete
 */
export function buildScheduledTaskToolDefinitions(deps: ScheduledTasksMcpDeps): ToolDef[] {
  const draftTool: ToolDef = {
    name: 'create_scheduled_task_draft',
    description:
      '创建定时任务草稿（不会在聊天中直接生效；用户必须在 Comate 的任务面板"待确认"区确认后才会进入调度）。' +
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
        const draft = scheduledTasksService.createDraft(deps.workspaceId, {
          workspaceId: deps.workspaceId,
          name: args.name,
          instruction: args.instruction,
          scheduleType: args.scheduleType,
          scheduleTime: args.scheduleTime ?? null,
          cronExpr: args.cronExpr ?? null,
        });
        return textResult(
          `草稿已创建（id: ${draft.id}），等待用户在任务面板确认后生效。请告知用户去"定时任务"面板确认。`,
        );
      } catch (err) {
        return textResult(`创建草稿失败：${err instanceof Error ? err.message : String(err)}`, true);
      }
    }) as never,
  };

  if (deps.source === 'wecom' || deps.source === 'feishu') {
    return [draftTool];
  }

  const listTool: ToolDef = {
    name: 'list_scheduled_tasks',
    description: '列出当前工作区的定时任务（含状态、下次触发时间、最近一次执行状态）。',
    inputSchema: {},
    handler: (async () => {
      const tasks = scheduledTasksService
        .listTasks(deps.workspaceId)
        .map(
          (t) =>
            `- [${t.status}] ${t.name}（${describeSchedule(t)}）下次触发: ${t.nextFireAt ?? '—'}；最近执行: ${t.latestRun?.status ?? '无'}（id: ${t.id}）`,
        );
      return textResult(tasks.length > 0 ? tasks.join('\n') : '当前工作区没有定时任务。');
    }) as never,
  };

  const pauseTool: ToolDef = {
    name: 'pause_scheduled_task',
    description: '暂停一个定时任务（不再按调度触发，可随时恢复）。',
    inputSchema: { taskId: z.string().min(1) },
    handler: (async (args: { taskId: string }) => {
      try {
        scheduledTasksService.updateTask(args.taskId, { status: 'paused' });
        return textResult('任务已暂停。');
      } catch (err) {
        return textResult(`暂停失败：${err instanceof Error ? err.message : String(err)}`, true);
      }
    }) as never,
  };

  const resumeTool: ToolDef = {
    name: 'resume_scheduled_task',
    description: '恢复一个已暂停的定时任务。',
    inputSchema: { taskId: z.string().min(1) },
    handler: (async (args: { taskId: string }) => {
      try {
        scheduledTasksService.updateTask(args.taskId, { status: 'active' });
        return textResult('任务已恢复，将按调度继续触发。');
      } catch (err) {
        return textResult(`恢复失败：${err instanceof Error ? err.message : String(err)}`, true);
      }
    }) as never,
  };

  const runNowTool: ToolDef = {
    name: 'run_scheduled_task_now',
    description: '立即执行一个已确认的定时任务（草稿或未确认的任务不能执行）。',
    inputSchema: { taskId: z.string().min(1) },
    handler: (async (args: { taskId: string }) => {
      try {
        const run = await scheduledTasksService.runNow(args.taskId);
        return textResult(`已触发执行（run id: ${run.id}），执行过程可在任务执行历史或对应会话中查看。`);
      } catch (err) {
        if (err instanceof SchedulerError) return textResult(`无法执行：${err.message}`, true);
        return textResult(`无法执行：${err instanceof Error ? err.message : String(err)}`, true);
      }
    }) as never,
  };

  return [draftTool, listTool, pauseTool, resumeTool, runNowTool];
}

/**
 * Stateless HTTP MCP endpoint, mounted before the global guards like the
 * browser MCP (its requests carry a bearer token, not browser origins).
 */
export function createScheduledTasksMcpHttpRouter(
  depsFor: (sessionId: string) => Promise<ScheduledTasksMcpDeps | null>,
): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  router.use(json());

  router.post('/:sessionId', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    const deps = await depsFor(sessionId);
    if (!deps) {
      res.status(404).json({ error: 'Session not found or not eligible for scheduled-task tools' });
      return;
    }
    const server = new McpServer({ name: SCHEDULED_TASKS_MCP_KEY, version: '0.1.0' });
    for (const def of buildScheduledTaskToolDefinitions(deps)) {
      server.registerTool(
        def.name,
        { description: def.description, inputSchema: def.inputSchema },
        def.handler as never,
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      diagLog(`[scheduled-tasks-mcp] request failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP request failed' });
      }
    }
  });

  return router;
}
