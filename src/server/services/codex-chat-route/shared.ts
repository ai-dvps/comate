export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
}

export function canonicalJsonString(value: string): string {
  try {
    return JSON.stringify(sortJson(JSON.parse(value)));
  } catch {
    return value;
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

export function splitThink(text: string): { reasoning?: string; text: string } {
  const match = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(text);
  return match
    ? { reasoning: match[1].trim(), text: text.slice(match[0].length) }
    : { text };
}
