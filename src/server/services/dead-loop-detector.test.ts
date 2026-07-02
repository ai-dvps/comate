import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_DEAD_LOOP_DETECTION_SETTINGS,
  resolveDeadLoopDetectionSettings,
  validateDeadLoopDetectionSettings,
} from './dead-loop-detector.js';
import type { WorkspaceSettings } from '../models/workspace.js';

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
