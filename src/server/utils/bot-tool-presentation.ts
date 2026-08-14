export type BotToolCategory =
  | 'project_read'
  | 'command'
  | 'file_write'
  | 'web_research'
  | 'question'
  | 'browser'
  | 'other';

export function getBotToolCategory(toolName: string): BotToolCategory {
  if (['Read', 'Grep', 'Glob', 'LSP'].includes(toolName)) return 'project_read';
  if (toolName === 'Bash') return 'command';
  if (toolName === 'Edit' || toolName === 'Write') return 'file_write';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'web_research';
  if (toolName === 'AskUserQuestion') return 'question';
  if (/browser/i.test(toolName)) return 'browser';
  return 'other';
}

export function botToolStatusText(toolName: string): string {
  switch (getBotToolCategory(toolName)) {
    case 'project_read': return '正在查看项目…';
    case 'command': return '正在执行命令…';
    case 'file_write': return '正在修改文件…';
    case 'web_research': return '正在查找资料…';
    case 'question': return '正在准备问题…';
    case 'browser': return '正在检查页面…';
    default: return '正在处理…';
  }
}

export function humanizeBotToolName(toolName: string): string {
  switch (getBotToolCategory(toolName)) {
    case 'project_read': return '查看项目';
    case 'command': return '执行命令';
    case 'file_write': return '修改文件';
    case 'web_research': return '查找资料';
    case 'question': return '回答问题';
    case 'browser': return '操作页面';
    default: return '执行操作';
  }
}

export function summarizeBotToolOperation(
  input: unknown,
  fallback: string,
  max: number,
): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url', 'query']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return truncate(redactSensitiveText(value).replace(/\s+/g, ' ').trim(), max);
      }
    }
  }
  return truncate(redactSensitiveText(fallback), max);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
import { redactSensitiveText } from './sensitive-text.js';
