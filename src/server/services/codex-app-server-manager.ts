import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { sanitizeSubprocessEnv } from '../utils/sanitize-env.js';
import { CODEX_EXPECTED_VERSION, resolveCodexBinary } from '../utils/resolve-codex-binary.js';
import { CodexRpcClient, CodexRpcError } from './codex-rpc-client.js';

export class CodexAppServerManager extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private client?: CodexRpcClient;
  private starting?: Promise<CodexRpcClient>;
  private generation = 0;

  async ensureClient(): Promise<CodexRpcClient> {
    if (this.client && this.process?.exitCode === null) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    let delayMs = 100;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await (await this.ensureClient()).request<T>(method, params, timeoutMs);
      } catch (error) {
        if (!(error instanceof CodexRpcError) || error.code !== -32001 || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs + Math.floor(Math.random() * 50)));
        delayMs *= 2;
      }
    }
  }

  private async start(): Promise<CodexRpcClient> {
    const binary = resolveCodexBinary();
    if (!binary) throw new Error('Pinned Codex runtime is unavailable');
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim();
    if (!version.endsWith(CODEX_EXPECTED_VERSION)) {
      throw new Error(`Codex version mismatch: expected ${CODEX_EXPECTED_VERSION}, got ${version}`);
    }
    const env = sanitizeSubprocessEnv(process.env as Record<string, string | undefined>);
    // CODEX_HOME deliberately survives sanitization: native CLI and Comate share identity/history.
    if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
    const child = spawn(binary, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    const client = new CodexRpcClient(child.stdout, child.stdin);
    this.client = client;
    const generation = ++this.generation;
    child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', redact(chunk.toString())));
    child.once('exit', (code, signal) => {
      if (this.process === child) {
        this.process = undefined;
        this.client = undefined;
      }
      client.close(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`));
      this.emit('exit', { code, signal, generation });
    });
    await client.request('initialize', {
      clientInfo: { name: 'comate', title: 'Comate', version: '0.3.1' },
      capabilities: null,
    }, 10_000);
    return client;
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.client?.close();
    this.client = undefined;
    if (child?.exitCode === null) child.kill('SIGTERM');
  }
}

function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(authorization|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(-4_000);
}

export const codexAppServerManager = new CodexAppServerManager();
