import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_DEAD_LOOP_DETECTION_SETTINGS,
  ReadLoopDetector,
  computeFingerprint,
  detectSubagentLoop,
  isWastedCall,
  resolveDeadLoopDetectionSettings,
  validateDeadLoopDetectionSettings,
} from './dead-loop-detector.js';
import type { WorkspaceSettings } from '../models/workspace.js';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

describe('dead-loop-detector settings', () => {
  it('returns global defaults when workspace settings are empty', () => {
    const resolved = resolveDeadLoopDetectionSettings({});
    assert.deepStrictEqual(resolved, DEFAULT_DEAD_LOOP_DETECTION_SETTINGS);
  });

  it('returns global defaults when workspace settings are undefined', () => {
    const resolved = resolveDeadLoopDetectionSettings(undefined);
    assert.deepStrictEqual(resolved, DEFAULT_DEAD_LOOP_DETECTION_SETTINGS);
  });

  it('merges partial line1 overrides with defaults', () => {
    const settings: WorkspaceSettings = {
      deadLoopDetection: {
        line1: { blockThreshold: 7 },
      },
    };
    const resolved = resolveDeadLoopDetectionSettings(settings);
    assert.strictEqual(resolved.enabled, true);
    assert.strictEqual(resolved.line1.warnThreshold, 3);
    assert.strictEqual(resolved.line1.blockThreshold, 7);
    assert.strictEqual(resolved.line2.windowSize, 20);
  });

  it('merges partial line2 overrides with defaults', () => {
    const settings: WorkspaceSettings = {
      deadLoopDetection: {
        enabled: false,
        line2: { pollIntervalMs: 1000 },
      },
    };
    const resolved = resolveDeadLoopDetectionSettings(settings);
    assert.strictEqual(resolved.enabled, false);
    assert.strictEqual(resolved.line2.pollIntervalMs, 1000);
    assert.strictEqual(resolved.line2.interruptTimeoutMs, 30000);
  });

  it('validates undefined settings', () => {
    assert.strictEqual(validateDeadLoopDetectionSettings(undefined), undefined);
  });

  it('rejects non-object deadLoopDetection', () => {
    assert.strictEqual(
      validateDeadLoopDetectionSettings('bad'),
      'deadLoopDetection must be an object',
    );
  });

  it('rejects non-boolean enabled', () => {
    assert.strictEqual(
      validateDeadLoopDetectionSettings({ enabled: 'yes' }),
      'deadLoopDetection.enabled must be a boolean',
    );
  });

  it('rejects negative line1 thresholds', () => {
    assert.strictEqual(
      validateDeadLoopDetectionSettings({ line1: { warnThreshold: -1 } }),
      'deadLoopDetection.line1.warnThreshold must be a non-negative number',
    );
  });

  it('rejects invalid line2 windowSize', () => {
    assert.strictEqual(
      validateDeadLoopDetectionSettings({ line2: { windowSize: 0 } }),
      'deadLoopDetection.line2.windowSize must be a positive number',
    );
  });
});

describe('ReadLoopDetector', () => {
  const FILE = '/workspace/a.txt';

  it('allows the first read of a file', () => {
    const detector = new ReadLoopDetector({ warnThreshold: 2, blockThreshold: 4 });
    assert.deepStrictEqual(detector.beforeRead(FILE), { type: 'allow' });
  });

  it('blocks after the block threshold is crossed and returns cached content', () => {
    const detector = new ReadLoopDetector({ warnThreshold: 1, blockThreshold: 2 });
    detector.recordReadResult(FILE, 'hello');
    detector.recordReadResult(FILE, 'Wasted call');
    detector.recordReadResult(FILE, 'Wasted call');

    const action = detector.beforeRead(FILE);
    assert.strictEqual(action.type, 'block');
    assert.strictEqual((action as { type: 'block'; cachedResult: unknown }).cachedResult, 'hello');
  });

  it('warns when the warning threshold is reached', () => {
    const detector = new ReadLoopDetector({ warnThreshold: 1, blockThreshold: 3 });
    detector.recordReadResult(FILE, 'hello');
    detector.recordReadResult(FILE, 'Wasted call');

    const action = detector.beforeRead(FILE);
    assert.strictEqual(action.type, 'warn');
    assert.ok(
      (action as { type: 'warn'; guidance: string }).guidance.includes('already been read'),
    );
  });

  it('resets the counter when a read returns new content', () => {
    const detector = new ReadLoopDetector({ warnThreshold: 1, blockThreshold: 2 });
    detector.recordReadResult(FILE, 'hello');
    detector.recordReadResult(FILE, 'Wasted call');
    detector.recordReadResult(FILE, 'new content');

    assert.deepStrictEqual(detector.beforeRead(FILE), { type: 'allow' });
  });

  it('does not reset counters for a different file', () => {
    const detector = new ReadLoopDetector({ warnThreshold: 1, blockThreshold: 2 });
    detector.recordReadResult(FILE, 'hello');
    detector.recordReadResult(FILE, 'Wasted call');

    detector.recordReadResult('/workspace/b.txt', 'other');
    const action = detector.beforeRead(FILE);
    assert.strictEqual(action.type, 'warn');
  });

  it('recognizes wasted-call signal variants', () => {
    assert.strictEqual(isWastedCall('Wasted call — file unchanged'), true);
    assert.strictEqual(isWastedCall({ type: 'file_unchanged' }), true);
    assert.strictEqual(isWastedCall('{"type":"file_unchanged"}'), true);
    assert.strictEqual(isWastedCall('hello'), false);
    assert.strictEqual(isWastedCall({ content: 'hello' }), false);
  });
});

describe('detectSubagentLoop', () => {
  function makeToolUseMessage(toolName: string, input: unknown): SessionMessage {
    return {
      uuid: crypto.randomUUID(),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: toolName, input, id: crypto.randomUUID() }],
      },
    } as SessionMessage;
  }

  it('detects a loop when the same tool+input repeats in the window', () => {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(makeToolUseMessage('Read', { file_path: '/x/y.txt' }));
    }

    const result = detectSubagentLoop(messages, 20, 5);
    assert.ok(result);
    assert.strictEqual(result?.toolName, 'Read');
    assert.strictEqual(result?.count, 6);
  });

  it('does not flag a loop below the threshold', () => {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 4; i++) {
      messages.push(makeToolUseMessage('Read', { file_path: '/x/y.txt' }));
    }

    const result = detectSubagentLoop(messages, 20, 5);
    assert.strictEqual(result, undefined);
  });

  it('ignores repeats outside the trailing window', () => {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeToolUseMessage('Read', { file_path: '/x/y.txt' }));
    }

    const result = detectSubagentLoop(messages, 5, 6);
    assert.strictEqual(result, undefined);
  });

  it('treats equivalent inputs with different key order as the same fingerprint', () => {
    const messages: SessionMessage[] = [
      makeToolUseMessage('Read', { file_path: '/x/y.txt', offset: 0 }),
      makeToolUseMessage('Read', { offset: 0, file_path: '/x/y.txt' }),
    ];

    const result = detectSubagentLoop(messages, 20, 2);
    assert.ok(result);
    assert.strictEqual(result?.count, 2);
  });

  it('does not flag alternating tools with different inputs', () => {
    const messages: SessionMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(
        makeToolUseMessage(i % 2 === 0 ? 'Read' : 'Grep', {
          pattern: i % 2 === 0 ? 'foo' : 'bar',
        }),
      );
    }

    const result = detectSubagentLoop(messages, 20, 5);
    assert.strictEqual(result, undefined);
  });

  it('computes stable fingerprints', () => {
    const fp1 = computeFingerprint('Read', { file_path: '/a.txt', offset: 0 });
    const fp2 = computeFingerprint('Read', { offset: 0, file_path: '/a.txt' });
    assert.strictEqual(fp1, fp2);
  });
});
