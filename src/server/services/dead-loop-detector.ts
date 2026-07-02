import type {
  DeadLoopDetectionSettings,
  WorkspaceSettings,
} from '../models/workspace.js';

export interface ResolvedDeadLoopLine1Settings {
  warnThreshold: number;
  blockThreshold: number;
}

export interface ResolvedDeadLoopLine2Settings {
  windowSize: number;
  threshold: number;
  pollIntervalMs: number;
  interruptTimeoutMs: number;
}

export interface ResolvedDeadLoopDetectionSettings {
  enabled: boolean;
  line1: ResolvedDeadLoopLine1Settings;
  line2: ResolvedDeadLoopLine2Settings;
}

export const DEFAULT_DEAD_LOOP_DETECTION_SETTINGS: ResolvedDeadLoopDetectionSettings = {
  enabled: true,
  line1: {
    warnThreshold: 3,
    blockThreshold: 5,
  },
  line2: {
    windowSize: 20,
    threshold: 5,
    pollIntervalMs: 5000,
    interruptTimeoutMs: 30000,
  },
};

export function resolveDeadLoopDetectionSettings(
  settings?: WorkspaceSettings,
): ResolvedDeadLoopDetectionSettings {
  const configured = settings?.deadLoopDetection;
  return {
    enabled: configured?.enabled ?? DEFAULT_DEAD_LOOP_DETECTION_SETTINGS.enabled,
    line1: {
      warnThreshold:
        configured?.line1?.warnThreshold ?? DEFAULT_DEAD_LOOP_DETECTION_SETTINGS.line1.warnThreshold,
      blockThreshold:
        configured?.line1?.blockThreshold ??
        DEFAULT_DEAD_LOOP_DETECTION_SETTINGS.line1.blockThreshold,
    },
    line2: {
      windowSize:
        configured?.line2?.windowSize ?? DEFAULT_DEAD_LOOP_DETECTION_SETTINGS.line2.windowSize,
      threshold:
        configured?.line2?.threshold ?? DEFAULT_DEAD_LOOP_DETECTION_SETTINGS.line2.threshold,
      pollIntervalMs:
        configured?.line2?.pollIntervalMs ??
        DEFAULT_DEAD_LOOP_DETECTION_SETTINGS.line2.pollIntervalMs,
      interruptTimeoutMs:
        configured?.line2?.interruptTimeoutMs ??
        DEFAULT_DEAD_LOOP_DETECTION_SETTINGS.line2.interruptTimeoutMs,
    },
  };
}

export function validateDeadLoopDetectionSettings(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'deadLoopDetection must be an object';
  }
  const settings = value as DeadLoopDetectionSettings;

  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') {
    return 'deadLoopDetection.enabled must be a boolean';
  }

  if (settings.line1 !== undefined) {
    const line1Error = validateLine1Settings(settings.line1);
    if (line1Error) return line1Error;
  }

  if (settings.line2 !== undefined) {
    const line2Error = validateLine2Settings(settings.line2);
    if (line2Error) return line2Error;
  }

  return undefined;
}

function validateLine1Settings(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'deadLoopDetection.line1 must be an object';
  }
  const line1 = value as Record<string, unknown>;

  if (line1.warnThreshold !== undefined) {
    if (typeof line1.warnThreshold !== 'number' || line1.warnThreshold < 0) {
      return 'deadLoopDetection.line1.warnThreshold must be a non-negative number';
    }
  }
  if (line1.blockThreshold !== undefined) {
    if (typeof line1.blockThreshold !== 'number' || line1.blockThreshold < 0) {
      return 'deadLoopDetection.line1.blockThreshold must be a non-negative number';
    }
  }
  return undefined;
}

function validateLine2Settings(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'deadLoopDetection.line2 must be an object';
  }
  const line2 = value as Record<string, unknown>;

  if (line2.windowSize !== undefined) {
    if (typeof line2.windowSize !== 'number' || line2.windowSize < 1) {
      return 'deadLoopDetection.line2.windowSize must be a positive number';
    }
  }
  if (line2.threshold !== undefined) {
    if (typeof line2.threshold !== 'number' || line2.threshold < 1) {
      return 'deadLoopDetection.line2.threshold must be a positive number';
    }
  }
  if (line2.pollIntervalMs !== undefined) {
    if (typeof line2.pollIntervalMs !== 'number' || line2.pollIntervalMs < 1) {
      return 'deadLoopDetection.line2.pollIntervalMs must be a positive number';
    }
  }
  if (line2.interruptTimeoutMs !== undefined) {
    if (typeof line2.interruptTimeoutMs !== 'number' || line2.interruptTimeoutMs < 1) {
      return 'deadLoopDetection.line2.interruptTimeoutMs must be a positive number';
    }
  }
  return undefined;
}
