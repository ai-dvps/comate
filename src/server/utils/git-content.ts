export const MAX_GIT_CONTENT_SIZE = 500 * 1024;
export const MAX_GIT_CONTENT_LINES = 5_000;

export function capGitContent(buffer: Buffer): { content: string; truncated: boolean } {
  const byteTruncated = buffer.length > MAX_GIT_CONTENT_SIZE;
  const text = buffer.subarray(0, MAX_GIT_CONTENT_SIZE).toString('utf8');
  const lines = text.split('\n');
  if (lines.length > MAX_GIT_CONTENT_LINES) {
    return {
      content: lines.slice(0, MAX_GIT_CONTENT_LINES).join('\n'),
      truncated: true,
    };
  }
  return { content: text, truncated: byteTruncated };
}
