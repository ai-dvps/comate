import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ALLOW_ALL_PRESET,
  CATEGORY_TOOL_MAP,
  REPLY_TOOL_NAME,
  SAFE_PRESET,
  evaluateToolPermission,
  resolveEffectivePolicy,
  type ToolPermissionPolicy,
} from './tool-permission-policy.js';
import type { Workspace } from '../models/workspace.js';

function createMockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Test',
    description: '',
    folderPath: '/tmp/test',
    settings: {},
    skills: [],
    mcpServers: [],
    hooks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('evaluateToolPermission', () => {
  it('returns ask when category default is ask', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults, shell: 'ask' },
    };
    assert.equal(evaluateToolPermission(policy, 'Bash'), 'ask');
  });

  it('returns ask when per-tool override is ask', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults, shell: 'deny' },
      overrides: { Bash: 'ask' },
    };
    assert.equal(evaluateToolPermission(policy, 'Bash'), 'ask');
  });

  it('returns allow when override is allow even if category default is ask', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults, shell: 'ask' },
      overrides: { Bash: 'allow' },
    };
    assert.equal(evaluateToolPermission(policy, 'Bash'), 'allow');
  });

  it('returns deny when override is deny even if category default is ask', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...ALLOW_ALL_PRESET.categoryDefaults, shell: 'ask' },
      overrides: { Bash: 'deny' },
    };
    assert.equal(evaluateToolPermission(policy, 'Bash'), 'deny');
  });

  it('unknown tools fall through to allow-all regardless of policy', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
    };
    assert.equal(evaluateToolPermission(policy, 'mcp__someServer__tool'), 'unknown');
    assert.equal(evaluateToolPermission(policy, 'Skill_MySkill'), 'unknown');
    assert.equal(evaluateToolPermission(policy, 'SomeFutureTool'), 'unknown');
  });

  it('SAFE_PRESET and ALLOW_ALL_PRESET contain no ask values', () => {
    for (const value of Object.values(SAFE_PRESET.categoryDefaults)) {
      assert.ok(value !== 'ask', 'SAFE_PRESET should not contain ask');
    }
    for (const value of Object.values(ALLOW_ALL_PRESET.categoryDefaults)) {
      assert.ok(value !== 'ask', 'ALLOW_ALL_PRESET should not contain ask');
    }
  });

  it('returns override value when override exists for the tool', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
      overrides: { Bash: 'allow' },
    };
    // Shell default is deny in SAFE_PRESET, but override allows Bash
    assert.equal(evaluateToolPermission(policy, 'Bash'), 'allow');
  });

  it('returns deny when override denies even if category default allows', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...ALLOW_ALL_PRESET.categoryDefaults },
      overrides: { Edit: 'deny' },
    };
    // fileWrite default is allow in ALLOW_ALL, but override denies Edit
    assert.equal(evaluateToolPermission(policy, 'Edit'), 'deny');
  });

  it('returns category default when no override present', () => {
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Read'), 'allow');
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Bash'), 'deny');
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'WebFetch'), 'deny');
    assert.equal(evaluateToolPermission(SAFE_PRESET, REPLY_TOOL_NAME), 'allow');
  });

  it('returns unknown for tool not in any category (MCP, Skill, future SDK tool)', () => {
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'mcp__someServer__tool'), 'unknown');
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Skill_MySkill'), 'unknown');
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'SomeFutureTool'), 'unknown');
  });

  it('returns unknown when policy is undefined (caller falls through to allow per R10)', () => {
    assert.equal(evaluateToolPermission(undefined, 'Bash'), 'unknown');
    assert.equal(evaluateToolPermission(undefined, 'Read'), 'unknown');
  });

  it('SAFE_PRESET matches R3 table (Read allow; Write/Shell/Network/Sub-agents deny; Reply allow)', () => {
    assert.equal(SAFE_PRESET.posture, 'safe');
    assert.equal(SAFE_PRESET.categoryDefaults.fileRead, 'allow');
    assert.equal(SAFE_PRESET.categoryDefaults.fileWrite, 'deny');
    assert.equal(SAFE_PRESET.categoryDefaults.shell, 'deny');
    assert.equal(SAFE_PRESET.categoryDefaults.network, 'deny');
    assert.equal(SAFE_PRESET.categoryDefaults.subagents, 'deny');
    assert.equal(SAFE_PRESET.categoryDefaults.reply, 'allow');
  });

  it('ALLOW_ALL_PRESET allows every category', () => {
    assert.equal(ALLOW_ALL_PRESET.posture, 'allow-all');
    for (const value of Object.values(ALLOW_ALL_PRESET.categoryDefaults)) {
      assert.equal(value, 'allow');
    }
  });

  it('CATEGORY_TOOL_MAP covers all six categories', () => {
    const categories = Object.keys(CATEGORY_TOOL_MAP);
    assert.deepEqual(categories.sort(), [
      'fileRead',
      'fileWrite',
      'network',
      'reply',
      'shell',
      'subagents',
    ]);
  });

  it('CATEGORY_TOOL_MAP contains the documented tool membership per R3', () => {
    assert.deepEqual(CATEGORY_TOOL_MAP.fileRead.sort(), ['Glob', 'Grep', 'Read']);
    assert.deepEqual(CATEGORY_TOOL_MAP.fileWrite.sort(), ['Edit', 'NotebookEdit', 'Write']);
    assert.deepEqual(CATEGORY_TOOL_MAP.shell, ['Bash']);
    assert.deepEqual(CATEGORY_TOOL_MAP.network.sort(), ['WebFetch', 'WebSearch']);
    assert.ok(CATEGORY_TOOL_MAP.subagents.includes('Agent'));
    assert.ok(CATEGORY_TOOL_MAP.subagents.includes('TaskOutput'));
    assert.deepEqual(CATEGORY_TOOL_MAP.reply, [REPLY_TOOL_NAME]);
  });
});

describe('resolveEffectivePolicy', () => {
  it('returns explicit policy when wecomToolPermissions is set', () => {
    const explicit: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults, shell: 'allow' },
    };
    const workspace = createMockWorkspace({
      settings: { wecomBotEnabled: true, wecomToolPermissions: explicit },
    });
    const result = resolveEffectivePolicy(workspace);
    assert.equal(result.source, 'explicit');
    assert.equal(result.needsUpgradePrompt, false);
    assert.equal(result.policy.categoryDefaults.shell, 'allow');
  });

  it('returns allow-all with needsUpgradePrompt=true when bot enabled and policy unset (grandfathered)', () => {
    const workspace = createMockWorkspace({
      settings: { wecomBotEnabled: true },
    });
    const result = resolveEffectivePolicy(workspace);
    assert.equal(result.source, 'grandfathered-allow-all');
    assert.equal(result.needsUpgradePrompt, true);
    assert.equal(result.policy.posture, 'allow-all');
  });

  it('returns allow-all with no prompt when bot disabled and policy unset', () => {
    const workspace = createMockWorkspace({
      settings: { wecomBotEnabled: false },
    });
    const result = resolveEffectivePolicy(workspace);
    assert.equal(result.source, 'default-allow-all');
    assert.equal(result.needsUpgradePrompt, false);
  });

  it('uses explicit policy even when bot is disabled', () => {
    const explicit: ToolPermissionPolicy = {
      posture: 'safe',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
    };
    const workspace = createMockWorkspace({
      settings: { wecomBotEnabled: false, wecomToolPermissions: explicit },
    });
    const result = resolveEffectivePolicy(workspace);
    assert.equal(result.source, 'explicit');
    assert.equal(result.policy.posture, 'safe');
  });

  it('sanitizes malformed categoryDefaults entries (falls back to SAFE_PRESET defaults)', () => {
    // Pass a policy with missing categories and invalid values
    const malformed = {
      posture: 'custom',
      categoryDefaults: { shell: 'deny', fileRead: 'ask' }, // missing other categories, includes ask
      // @ts-expect-error testing runtime malformed input
      overrides: { Bash: 'invalid-value', Edit: 'ask' },
    };
    const workspace = createMockWorkspace({
      settings: { wecomBotEnabled: true, wecomToolPermissions: malformed },
    });
    const result = resolveEffectivePolicy(workspace);
    // Sanitized: missing categories filled from SAFE_PRESET, invalid override dropped, ask preserved
    assert.equal(result.policy.categoryDefaults.shell, 'deny');
    assert.equal(result.policy.categoryDefaults.fileRead, 'ask');
    assert.equal(result.policy.categoryDefaults.reply, 'allow'); // filled from SAFE_PRESET
    assert.equal(result.policy.overrides?.Edit, 'ask');
    assert.equal(result.policy.overrides?.Bash, undefined); // invalid override dropped
  });

  it('sanitizes invalid posture value to custom', () => {
    // @ts-expect-error testing runtime malformed input
    const malformed: ToolPermissionPolicy = {
      posture: 'invalid-posture',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
    };
    const workspace = createMockWorkspace({
      settings: { wecomBotEnabled: true, wecomToolPermissions: malformed },
    });
    const result = resolveEffectivePolicy(workspace);
    assert.equal(result.policy.posture, 'custom');
  });
});