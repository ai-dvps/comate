import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ALLOW_ALL_PRESET,
  CATEGORY_TOOL_MAP,
  REPLY_TOOL_NAME,
  SAFE_PRESET,
  categorizeTool,
  evaluateToolPermission,
  getToolPermissionDenialReason,
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

  it('admin bypass returns allow for tools in denied categories', () => {
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Bash', true), 'allow');
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Edit', true), 'allow');
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'WebFetch', true), 'allow');
    assert.equal(evaluateToolPermission(SAFE_PRESET, REPLY_TOOL_NAME, true), 'allow');
  });

  it('admin bypass overrides per-tool deny overrides', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
      overrides: { Bash: 'deny', Read: 'deny', Edit: 'ask' },
    };
    assert.equal(evaluateToolPermission(policy, 'Bash', true), 'allow');
    assert.equal(evaluateToolPermission(policy, 'Read', true), 'allow');
    assert.equal(evaluateToolPermission(policy, 'Edit', true), 'allow');
  });

  it('admin bypass still returns unknown for uncategorized tools', () => {
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'mcp__someServer__tool', true), 'unknown');
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Skill_MySkill', true), 'unknown');
  });

  it('non-admin callers are unaffected by the admin parameter', () => {
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Bash', false), 'deny');
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Bash'), 'deny');
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

  it('ALLOW_ALL_PRESET allows every category except browser (anti-grandfather, KTD-4 ①)', () => {
    assert.equal(ALLOW_ALL_PRESET.posture, 'allow-all');
    for (const [category, value] of Object.entries(ALLOW_ALL_PRESET.categoryDefaults)) {
      if (category === 'browser') {
        assert.equal(value, 'deny', 'browser must stay denied even in allow-all');
      } else {
        assert.equal(value, 'allow');
      }
    }
  });

  it('CATEGORY_TOOL_MAP covers all seven categories', () => {
    const categories = Object.keys(CATEGORY_TOOL_MAP);
    assert.deepEqual(categories.sort(), [
      'browser',
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

describe('getToolPermissionDenialReason', () => {
  it('returns override-deny when a per-tool override denies', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...ALLOW_ALL_PRESET.categoryDefaults },
      overrides: { Edit: 'deny' },
    };
    assert.equal(getToolPermissionDenialReason(policy, 'Edit'), 'override-deny');
  });

  it('returns category-deny when the category default denies and there is no override', () => {
    assert.equal(getToolPermissionDenialReason(SAFE_PRESET, 'Bash'), 'category-deny');
    assert.equal(getToolPermissionDenialReason(SAFE_PRESET, 'Read'), undefined);
  });

  it('returns undefined when an override allows or asks a tool in a denied category', () => {
    const allowOverride: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
      overrides: { Bash: 'allow' },
    };
    assert.equal(getToolPermissionDenialReason(allowOverride, 'Bash'), undefined);

    const askOverride: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
      overrides: { Bash: 'ask' },
    };
    assert.equal(getToolPermissionDenialReason(askOverride, 'Bash'), undefined);
  });

  it('returns undefined for unknown tools and undefined policies', () => {
    assert.equal(getToolPermissionDenialReason(SAFE_PRESET, 'SomeFutureTool'), undefined);
    assert.equal(getToolPermissionDenialReason(undefined, 'Bash'), undefined);
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

describe('browser category (U4, KTD-4 ①)', () => {
  const BROWSER_TOOLS = [
    'mcp__comate-browser__open',
    'mcp__comate-browser__snapshot',
    'mcp__comate-browser__act',
    'mcp__comate-browser__submit',
    'mcp__comate-browser__extract',
    'mcp__comate-browser__requestHandoff',
  ];

  it('categorizes every comate-browser tool via the prefix entry, and only those', () => {
    for (const tool of BROWSER_TOOLS) {
      assert.equal(categorizeTool(tool), 'browser', `${tool} must be browser-category`);
    }
    // Other MCP servers stay uncategorized (fall through per R10).
    assert.equal(categorizeTool('mcp__comate-browserX__open'), undefined);
    assert.equal(categorizeTool('mcp__other__open'), undefined);
    assert.equal(categorizeTool('Bash'), 'shell');
  });

  it('SAFE_PRESET denies the browser category', () => {
    assert.equal(SAFE_PRESET.categoryDefaults.browser, 'deny');
    for (const tool of BROWSER_TOOLS) {
      assert.equal(evaluateToolPermission(SAFE_PRESET, tool), 'deny');
    }
  });

  it('ALLOW_ALL_PRESET still denies the browser category (no grandfathered inheritance)', () => {
    assert.equal(ALLOW_ALL_PRESET.categoryDefaults.browser, 'deny');
    for (const tool of BROWSER_TOOLS) {
      assert.equal(evaluateToolPermission(ALLOW_ALL_PRESET, tool), 'deny');
    }
  });

  it('admin bypass does not apply to the browser category', () => {
    for (const tool of BROWSER_TOOLS) {
      assert.equal(evaluateToolPermission(ALLOW_ALL_PRESET, tool, true), 'deny');
      assert.equal(evaluateToolPermission(SAFE_PRESET, tool, true), 'deny');
    }
    // Sanity: the bypass still works for non-browser categories.
    assert.equal(evaluateToolPermission(SAFE_PRESET, 'Bash', true), 'allow');
  });

  it('per-tool overrides still apply to browser tools (category evaluation only)', () => {
    const policy: ToolPermissionPolicy = {
      posture: 'custom',
      categoryDefaults: { ...SAFE_PRESET.categoryDefaults },
      overrides: { 'mcp__comate-browser__snapshot': 'allow' },
    };
    assert.equal(evaluateToolPermission(policy, 'mcp__comate-browser__snapshot'), 'allow');
    assert.equal(evaluateToolPermission(policy, 'mcp__comate-browser__act'), 'deny');
  });

  it('getToolPermissionDenialReason reports category-deny for browser tools', () => {
    assert.equal(getToolPermissionDenialReason(SAFE_PRESET, 'mcp__comate-browser__open'), 'category-deny');
    assert.equal(getToolPermissionDenialReason(ALLOW_ALL_PRESET, 'mcp__comate-browser__submit'), 'category-deny');
    assert.equal(getToolPermissionDenialReason(SAFE_PRESET, 'mcp__other__open'), undefined);
  });

  it('MIGRATION CONTRACT: a stored pre-U4 policy (no browser key) sanitizes to browser=deny', () => {
    const legacy = {
      posture: 'allow-all',
      categoryDefaults: {
        fileRead: 'allow',
        fileWrite: 'allow',
        shell: 'allow',
        network: 'allow',
        subagents: 'allow',
        reply: 'allow',
        // browser: absent — this is the pre-U4 stored shape
      },
    } as unknown as ToolPermissionPolicy;
    const workspace = createMockWorkspace({
      settings: { wecomBotEnabled: true, wecomToolPermissions: legacy },
    });
    const result = resolveEffectivePolicy(workspace);
    assert.equal(result.policy.categoryDefaults.browser, 'deny', 'sanitizePolicy must backfill browser from SAFE_PRESET');
    // And the evaluator itself fails closed on the raw legacy shape too.
    assert.equal(evaluateToolPermission(legacy, 'mcp__comate-browser__open'), 'deny');
    assert.equal(evaluateToolPermission(legacy, 'mcp__comate-browser__open', true), 'deny');
  });

  it('grandfathered resolution (bot enabled, policy unset) resolves browser=deny', () => {
    const workspace = createMockWorkspace({
      settings: { wecomBotEnabled: true },
    });
    const result = resolveEffectivePolicy(workspace);
    assert.equal(result.source, 'grandfathered-allow-all');
    assert.equal(result.policy.categoryDefaults.browser, 'deny');
  });
});