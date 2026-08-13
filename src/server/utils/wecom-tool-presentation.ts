export type WecomToolCategory =
  | 'project_read'
  | 'command'
  | 'file_write'
  | 'web_research'
  | 'question'
  | 'browser'
  | 'other';

export function getWecomToolCategory(toolName: string): WecomToolCategory {
  if (['Read', 'Grep', 'Glob', 'LSP'].includes(toolName)) return 'project_read';
  if (toolName === 'Bash') return 'command';
  if (toolName === 'Edit' || toolName === 'Write') return 'file_write';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'web_research';
  if (toolName === 'AskUserQuestion') return 'question';
  if (/browser/i.test(toolName)) return 'browser';
  return 'other';
}

export function summarizeWecomToolOperation(
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

const SENSITIVE_NAME = String.raw`(?:password|passwd|pwd|token|api[-_]?key|secret|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization)`;

/** Keep an operation recognizable without forwarding credentials into WeCom. */
function redactSensitiveText(text: string): string {
  return text
    // Quoted HTTP authorization headers may contain spaces after "Bearer".
    .replace(/(["'])(authorization|proxy-authorization)\s*:\s*[^"']*\1/gi, '$1$2: [REDACTED]$1')
    .replace(/((?:authorization|proxy-authorization)\s*:\s*)(?:bearer\s+)?[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(\bbearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    // Shell environment assignments and common credential-bearing CLI flags.
    .replace(new RegExp(`((?:^|\\s)${SENSITIVE_NAME}\\s*=\\s*)(["'][^"']*["']|[^\\s]+)`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`((?:^|\\s)--?${SENSITIVE_NAME}=)(["'][^"']*["']|[^\\s]+)`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`((?:^|\\s)--?${SENSITIVE_NAME}\\s+)(["'][^"']*["']|[^\\s]+)`, 'gi'), '$1[REDACTED]')
    // URLs: hide userinfo and values of credential-like query parameters.
    .replace(/(https?:\/\/)[^/@\s"']+@/gi, '$1[REDACTED]@')
    .replace(new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#\\s"']*`, 'gi'), '$1[REDACTED]');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
