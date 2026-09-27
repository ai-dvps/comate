/**
 * Shared mini-harness for the CDP gate scripts (scripts/test-electron-cdp.ts,
 * scripts/test-shell-cdp.ts): the skip/fail `unavailable` helper, the
 * check/assert/results collector, and a loopback port allocator.
 *
 * Pure test tooling — each script keeps its own banner, check bodies, and
 * final PASS/FAIL summary line.
 */

import { createServer } from 'node:http';

export interface GateHarnessOptions {
  /** Lowercase gate label for SKIP lines, e.g. 'electron shell CDP gate'. */
  gateName: string;
  /** Env var that (set to '1') turns a skip into a failure — release gate. */
  requiredEnvVar: string;
}

export interface GateCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface GateHarness {
  /** True when the gate is required (env flag or `--required` argv). */
  readonly required: boolean;
  /** Skip (exit 0) or fail (throw) when the gate cannot run here. */
  unavailable(reason: string): never;
  check(name: string, fn: () => Promise<void>): Promise<void>;
  assert(cond: unknown, message: string): asserts cond;
  readonly results: GateCheckResult[];
}

export function createGateHarness(options: GateHarnessOptions): GateHarness {
  const { gateName, requiredEnvVar } = options;
  const required =
    process.env[requiredEnvVar] === '1' || process.argv.includes('--required');

  function unavailable(reason: string): never {
    if (required) {
      throw new Error(
        `${gateName.charAt(0).toUpperCase()}${gateName.slice(1)} required but unavailable: ${reason}`,
      );
    }
    console.log(`SKIP ${gateName}: ${reason}`);
    process.exit(0);
  }

  const results: GateCheckResult[] = [];
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ok  ${name}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, ok: false, detail });
      console.error(`FAIL  ${name}: ${detail}`);
    }
  }
  function assert(cond: unknown, message: string): asserts cond {
    if (!cond) throw new Error(message);
  }

  return { required, unavailable, check, assert, results };
}

/** Allocate an OS-assigned port on 127.0.0.1, then release it. */
export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port allocation failed');
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
