import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadItem } from '../generated/codex-protocol/v2/ThreadItem.js';

interface CodexNotificationParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  item?: ThreadItem;
}

/** Pure per-session mapper from Codex item lifecycle notifications to the
 * SDK-shaped compatibility stream consumed by the shared renderer. */
export class CodexEventMapper {
  private readonly startedMessages = new Set<string>();
  private readonly startedParts = new Set<string>();
  private readonly stoppedParts = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly indexes = new Map<string, number>();
  private nextIndex = 0;

  constructor(private readonly model = 'codex') {}

  map(method: string, params: CodexNotificationParams): SDKMessage[] {
    const turnId = params.turnId;
    if (!turnId) return [];
    if (method === 'item/agentMessage/delta') {
      return this.delta(turnId, String(params.itemId ?? ''), 'text', String(params.delta ?? ''));
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      return this.delta(turnId, String(params.itemId ?? ''), 'thinking', String(params.delta ?? ''));
    }
    if (method === 'item/started' && params.item) {
      return this.started(turnId, params.item);
    }
    if (method === 'item/completed' && params.item) {
      return this.completed(turnId, params.item);
    }
    return [];
  }

  private started(turnId: string, item: ThreadItem): SDKMessage[] {
    if (item.type === 'agentMessage') return this.startPart(turnId, item.id, 'text');
    if (item.type === 'reasoning') return this.startPart(turnId, item.id, 'thinking');
    const tool = projectCodexToolItem(item);
    if (!tool) return [];
    return this.startTool(turnId, item.id, tool.name, tool.input);
  }

  private completed(turnId: string, item: ThreadItem): SDKMessage[] {
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      return this.stopPart(turnId, item.id);
    }
    const tool = projectCodexToolItem(item);
    if (!tool || this.completedTools.has(item.id)) return [];
    this.completedTools.add(item.id);
    return [
      ...this.startTool(turnId, item.id, tool.name, tool.input),
      {
        type: 'user',
        uuid: `${item.id}:result`,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: item.id,
            content: tool.output,
            is_error: tool.isError,
          }],
        },
      } as unknown as SDKMessage,
    ];
  }

  private delta(
    turnId: string,
    itemId: string,
    kind: 'text' | 'thinking',
    delta: string,
  ): SDKMessage[] {
    if (!itemId || !delta) return [];
    return [
      ...this.startPart(turnId, itemId, kind),
      {
        type: 'stream_event',
        uuid: turnId,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: this.index(itemId),
          delta: kind === 'text'
            ? { type: 'text_delta', text: delta }
            : { type: 'thinking_delta', thinking: delta },
        },
      } as unknown as SDKMessage,
    ];
  }

  private startPart(turnId: string, itemId: string, kind: 'text' | 'thinking'): SDKMessage[] {
    if (!itemId || this.startedParts.has(itemId)) return [];
    this.startedParts.add(itemId);
    return [
      ...this.startMessage(turnId),
      {
        type: 'stream_event',
        uuid: turnId,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_start',
          index: this.index(itemId),
          content_block: kind === 'text'
            ? { type: 'text', text: '' }
            : { type: 'thinking', thinking: '' },
        },
      } as unknown as SDKMessage,
    ];
  }

  private stopPart(turnId: string, itemId: string): SDKMessage[] {
    if (!this.startedParts.has(itemId) || this.stoppedParts.has(itemId)) return [];
    this.stoppedParts.add(itemId);
    return [{
      type: 'stream_event',
      uuid: turnId,
      parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: this.index(itemId) },
    } as unknown as SDKMessage];
  }

  private startTool(turnId: string, itemId: string, name: string, input: unknown): SDKMessage[] {
    if (this.startedParts.has(itemId)) return [];
    this.startedParts.add(itemId);
    this.stoppedParts.add(itemId);
    return [
      ...this.startMessage(turnId),
      {
        type: 'stream_event',
        uuid: turnId,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_start',
          index: this.index(itemId),
          content_block: { type: 'tool_use', id: itemId, name, input },
        },
      } as unknown as SDKMessage,
      {
        type: 'stream_event',
        uuid: turnId,
        parent_tool_use_id: null,
        event: { type: 'content_block_stop', index: this.index(itemId) },
      } as unknown as SDKMessage,
    ];
  }

  private startMessage(turnId: string): SDKMessage[] {
    if (this.startedMessages.has(turnId)) return [];
    this.startedMessages.add(turnId);
    return [{
      type: 'stream_event',
      uuid: turnId,
      parent_tool_use_id: null,
      event: {
        type: 'message_start',
        message: {
          id: turnId,
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    } as unknown as SDKMessage];
  }

  private index(itemId: string): number {
    const existing = this.indexes.get(itemId);
    if (existing !== undefined) return existing;
    const index = this.nextIndex++;
    this.indexes.set(itemId, index);
    return index;
  }
}

export function projectCodexToolItem(item: ThreadItem): {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
} | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        name: 'Bash',
        input: { command: item.command, cwd: item.cwd },
        output: item.aggregatedOutput ?? '',
        isError: item.status === 'failed' || item.status === 'declined' || (item.exitCode ?? 0) !== 0,
      };
    case 'fileChange':
      return {
        name: 'Edit',
        input: { changes: item.changes },
        output: JSON.stringify(item.changes),
        isError: item.status === 'failed' || item.status === 'declined',
      };
    case 'mcpToolCall':
      return {
        name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments,
        output: stringify(item.error ?? item.result ?? ''),
        isError: item.status === 'failed' || item.error !== null,
      };
    case 'dynamicToolCall':
      return {
        name: item.namespace ? `${item.namespace}__${item.tool}` : item.tool,
        input: item.arguments,
        output: stringify(item.contentItems ?? ''),
        isError: item.status === 'failed' || item.success === false,
      };
    case 'collabAgentToolCall':
      return {
        name: 'Task',
        input: { tool: item.tool, prompt: item.prompt, model: item.model },
        output: stringify({ receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates }),
        isError: item.status === 'failed',
      };
    default:
      return null;
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
