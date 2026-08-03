import fs from 'node:fs';
import { brokerRequestSchema, brokerResultSchema, type BrokerResult } from '@comate/api-contracts';
import { resolveContext } from '../../lib/context.js';
import { postJson } from '../../lib/http.js';

const MAX_INPUT_BYTES = 1024 * 1024;

export interface RequestOptions {
  recipePath?: string;
  stdin: boolean;
  json: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Input exceeds the 1 MiB limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readRecipeFile(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Recipe path is not a file.');
  if (stat.size > MAX_INPUT_BYTES) throw new Error('Recipe exceeds the 1 MiB limit.');
  return fs.readFileSync(filePath, 'utf8');
}

function parseInput(text: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Recipe input is not valid JSON.');
  }
  const parsed = brokerRequestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Recipe does not match the supported Comate API contract.');
  return parsed.data;
}

function humanResult(result: BrokerResult): string {
  if (!result.ok) return `Request failed (${result.code}): ${result.message}\nRecovery: ${result.recovery}`;
  return `HTTP ${result.status}\n${JSON.stringify({ headers: result.headers, body: result.body }, null, 2)}`;
}

export async function runApiRequest(options: RequestOptions): Promise<number> {
  if (options.stdin === Boolean(options.recipePath)) {
    throw new Error('Choose exactly one input: --recipe <path> or --stdin.');
  }
  const text = options.stdin ? await readStdin() : readRecipeFile(options.recipePath!);
  const request = parseInput(text);
  const context = resolveContext();
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const response = await postJson(
      `${context.serverUrl}/api/broker/request`,
      request,
      context.token,
      { signal: abort.signal },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Comate rejected the request (HTTP ${response.status}).`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.body);
    } catch {
      throw new Error('Comate returned an invalid JSON response.');
    }
    const parsed = brokerResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Comate returned an incompatible broker response.');
    if (options.json) process.stdout.write(`${JSON.stringify(parsed.data)}\n`);
    else if (parsed.data.ok) process.stdout.write(`${humanResult(parsed.data)}\n`);
    else process.stderr.write(`${humanResult(parsed.data)}\n`);
    return parsed.data.ok ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
