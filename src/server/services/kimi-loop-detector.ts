import type { Provider } from '../models/provider.js';

/** Default number of consecutive identical tool calls that triggers a denial. */
export const DEFAULT_KIMI_LOOP_THRESHOLD = 3;

/**
 * Detects whether a provider is a Kimi/Moonshot model based on the model name
 * or base URL. This is intentionally simple so no new provider flag or UI
 * setting is required.
 */
export function isKimiProvider(provider?: Provider): boolean {
  if (!provider) return false;
  const model = provider.model?.toLowerCase() ?? '';
  const baseUrl = provider.baseUrl.toLowerCase();
  return (
    model.startsWith('kimi-') ||
    model.startsWith('moonshot-') ||
    baseUrl.includes('moonshot.cn') ||
    baseUrl.includes('kimi')
  );
}

export interface KimiLoopDetectorOptions {
  /** Number of consecutive identical tool calls required to deny. */
  threshold?: number;
}

export interface KimiLoopAllowResult {
  behavior: 'allow';
}

export interface KimiLoopDenyResult {
  behavior: 'deny';
  message: string;
}

export type KimiLoopResult = KimiLoopAllowResult | KimiLoopDenyResult;

/**
 * Tracks the last N main-agent tool calls within a single user turn. When the
 * same tool is called with the same arguments `threshold` times in a row, the
 * next call is denied with guidance asking the model to stop looping.
 *
 * The detector is scoped to a user turn; callers should call `reset()` at the
 * start of each new user message.
 */
export class KimiLoopDetector {
  private readonly threshold: number;
  private readonly fingerprints: string[] = [];

  constructor(options: KimiLoopDetectorOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_KIMI_LOOP_THRESHOLD;
    if (this.threshold < 2) {
      throw new Error('KimiLoopDetector threshold must be at least 2');
    }
  }

  /**
   * Records a tool call and returns whether it should be allowed.
   * The first `threshold - 1` repeats are allowed; the `threshold`-th repeat
   * (and any further repeats) is denied.
   */
  beforeToolUse(toolName: string, input: unknown): KimiLoopResult {
    const fingerprint = computeFingerprint(toolName, input);
    this.fingerprints.push(fingerprint);

    if (this.fingerprints.length < this.threshold) {
      return { behavior: 'allow' };
    }

    // Keep only the trailing window of size `threshold`.
    if (this.fingerprints.length > this.threshold) {
      this.fingerprints.shift();
    }

    const allSame = this.fingerprints.every((fp) => fp === fingerprint);
    if (allSame) {
      return {
        behavior: 'deny',
        message: `You have already called ${toolName} with the same arguments repeatedly. Stop looping and proceed with the task.`,
      };
    }

    return { behavior: 'allow' };
  }

  /** Clears the trailing window, e.g. at the start of a new user turn. */
  reset(): void {
    this.fingerprints.length = 0;
  }
}

/**
 * Computes a stable fingerprint for a tool call so that equivalent inputs with
 * different key ordering are treated as identical.
 */
export function computeFingerprint(toolName: string, input: unknown): string {
  return `${toolName}|${stableJson(input)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((sorted, key) => {
          sorted[key] = (val as Record<string, unknown>)[key];
          return sorted;
        }, {});
    }
    return val;
  });
}
