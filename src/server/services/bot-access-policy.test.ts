import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  deriveBotAccess,
  sanitizeBotRolePolicy,
  createDefaultBotRolePolicy,
  validateUserDirName,
  userDirNameKey,
  PUBLIC_CAPABILITY_DIRS,
  WECOM_API_DOMAINS,
  LOOPBACK_DOMAINS,
  type BotAccessMember,
  type DeriveBotAccessOptions,
} from './bot-access-policy.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { SAFE_PRESET } from './tool-permission-policy.js';
import type { Bot, BotRoleKey, BotRolePolicy } from '../models/bot.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = '/tmp/bot-access-ws';
const HOME = '/home/tester';
const COMATE_DATA = '/var/lib/comate-data';
const CLI_PATH = '/opt/comate/wecom-cli/index.js';
const CLI_DIR = '/opt/comate/wecom-cli';
const MARKETPLACE = '/opt/comate/marketplace';
const CLAUDE_PROJECTS = `${HOME}/.claude/projects`;
const PLUGIN_CACHE = `${HOME}/.claude/plugins/cache`;

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Test Bot',
    activeWorkspaceId: 'ws-1',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

function makeMember(roleKey: BotRoleKey, overrides: Partial<BotAccessMember> = {}): BotAccessMember {
  return { roleKey, channelUserId: 'alice', plaintextUserId: null, ...overrides };
}

function makeOptions(overrides: Partial<DeriveBotAccessOptions> = {}): DeriveBotAccessOptions {
  return {
    homeDir: HOME,
    comateDataDir: COMATE_DATA,
    wecomCliPath: CLI_PATH,
    marketplacePath: MARKETPLACE,
    settingsEnv: { ANTHROPIC_API_KEY: 'sk-live-test-value' },
    ...overrides,
  };
}

function derive(member: BotAccessMember | null, policy?: BotRolePolicy, options: Partial<DeriveBotAccessOptions> = {}) {
  return deriveBotAccess(makeBot(), member, policy ?? createDefaultBotRolePolicy('normal'), WS, makeOptions(options));
}

const BROWSER_DENY_RULE = 'mcp__comate-browser__*';

// ---------------------------------------------------------------------------
// Three-role derivation matrix
// ---------------------------------------------------------------------------

describe('deriveBotAccess role matrix', () => {
  it('owner: unrestricted filesystem except transcript library and Comate data dir', () => {
    const out = derive(makeMember('owner'));
    assert.deepStrictEqual(out.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: true,
      allowAppleEvents: false,
      enableWeakerNetworkIsolation: false,
      excludedCommands: [],
      filesystem: {
        allowWrite: ['/'],
        denyWrite: [COMATE_DATA, CLAUDE_PROJECTS],
        denyRead: [COMATE_DATA, CLAUDE_PROJECTS],
      },
      network: {
        allowedDomains: ['127.0.0.1', 'localhost', 'qyapi.weixin.qq.com'],
        strictAllowlist: true,
      },
      credentials: {
        files: [],
        envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }],
      },
    });
    assert.deepStrictEqual(out.permissionRules, {
      allow: [],
      ask: [],
      deny: [
        'Read(~/.claude/projects/**)',
        'Edit(~/.claude/projects/**)',
        `Read(/${COMATE_DATA}/**)`,
        `Edit(/${COMATE_DATA}/**)`,
        BROWSER_DENY_RULE,
      ],
    });
    assert.deepStrictEqual(out.passlistRules, []);
  });

  it('admin: workspace read, workspace + capability-dir write, home read lockdown', () => {
    const out = derive(makeMember('admin'), undefined, {
      sensitiveFileDenylist: ['secrets/**'],
    });
    assert.deepStrictEqual(out.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: true,
      allowAppleEvents: false,
      enableWeakerNetworkIsolation: false,
      excludedCommands: [],
      filesystem: {
        denyRead: ['~/', '/home', '/Users', COMATE_DATA, CLAUDE_PROJECTS],
        allowRead: [WS, PLUGIN_CACHE, CLI_DIR],
        denyWrite: [`${WS}/.claude`],
        allowWrite: [`${WS}/.claude/skills`, `${WS}/.claude/agents`],
      },
      network: {
        allowedDomains: ['127.0.0.1', 'localhost', 'qyapi.weixin.qq.com'],
        strictAllowlist: true,
      },
      credentials: {
        files: [
          { path: '~/.aws', mode: 'deny' },
          { path: '~/.ssh', mode: 'deny' },
        ],
        envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }],
      },
    });
    assert.deepStrictEqual(out.permissionRules, {
      allow: [
        `Read(/${WS}/**)`,
        `Edit(/${WS}/.claude/skills/**)`,
        `Edit(/${WS}/.claude/agents/**)`,
      ],
      ask: [],
      deny: [
        'Read(.env*)', 'Edit(.env*)',
        'Read(*id_rsa*)', 'Edit(*id_rsa*)',
        'Read(*.pem)', 'Edit(*.pem)',
        'Read(*.key)', 'Edit(*.key)',
        'Read(*.db)', 'Edit(*.db)',
        'Read(*.sqlite*)', 'Edit(*.sqlite*)',
        'Read(*.log)', 'Edit(*.log)',
        'Read(.credentials.json)', 'Edit(.credentials.json)',
        'Read(~/.aws/**)', 'Edit(~/.aws/**)',
        'Read(~/.ssh/**)', 'Edit(~/.ssh/**)',
        'Read(secrets/**)', 'Edit(secrets/**)',
        'Read(~/.claude/projects/**)', 'Edit(~/.claude/projects/**)',
        `Read(/${COMATE_DATA}/**)`, `Edit(/${COMATE_DATA}/**)`,
        BROWSER_DENY_RULE,
      ],
    });
  });

  it('normal: own data dir only, data isolation deny-parent + allow-self, network deny', () => {
    const out = derive(makeMember('normal'), undefined, {
      sensitiveFileDenylist: ['secrets/**'],
    });
    assert.deepStrictEqual(out.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      allowAppleEvents: false,
      enableWeakerNetworkIsolation: false,
      excludedCommands: [],
      filesystem: {
        denyRead: ['~/', '/home', '/Users', COMATE_DATA, CLAUDE_PROJECTS, `${WS}/data`],
        allowRead: [WS, `${WS}/data/alice`, PLUGIN_CACHE, CLI_DIR],
        denyWrite: [WS],
        allowWrite: [`${WS}/data/alice`, `${WS}/data/alice/.runtime`],
      },
      network: {
        allowedDomains: ['127.0.0.1', 'localhost', 'qyapi.weixin.qq.com'],
        strictAllowlist: true,
      },
      credentials: {
        files: [
          { path: '~/.aws', mode: 'deny' },
          { path: '~/.ssh', mode: 'deny' },
        ],
        envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }],
      },
    });
    assert.deepStrictEqual(out.permissionRules, {
      allow: [
        `Read(/${WS}/data/alice/**)`,
        `Edit(/${WS}/data/alice/**)`,
      ],
      ask: [],
      deny: [
        'Read(.claude/**)', 'Edit(.claude/**)',
        'Read(.env*)', 'Edit(.env*)',
        'Read(*id_rsa*)', 'Edit(*id_rsa*)',
        'Read(*.pem)', 'Edit(*.pem)',
        'Read(*.key)', 'Edit(*.key)',
        'Read(*.db)', 'Edit(*.db)',
        'Read(*.sqlite*)', 'Edit(*.sqlite*)',
        'Read(*.log)', 'Edit(*.log)',
        'Read(.credentials.json)', 'Edit(.credentials.json)',
        'Read(~/.aws/**)', 'Edit(~/.aws/**)',
        'Read(~/.ssh/**)', 'Edit(~/.ssh/**)',
        'Read(secrets/**)', 'Edit(secrets/**)',
        'Read(~/.claude/projects/**)', 'Edit(~/.claude/projects/**)',
        `Read(/${COMATE_DATA}/**)`, `Edit(/${COMATE_DATA}/**)`,
        BROWSER_DENY_RULE,
      ],
    });
  });

  it('data isolation never enumerates other known user dirs', () => {
    const out = derive(makeMember('normal'));
    const serialized = JSON.stringify(out.sandbox.filesystem);
    assert.ok(!serialized.includes('bob'), 'no other user dir in sandbox filesystem');
    assert.ok(!serialized.includes('data/charlie'), 'no other user dir in sandbox filesystem');
  });

  it('bot-level network allowlist merges over the defaults', () => {
    const policy = createDefaultBotRolePolicy('normal');
    policy.networkAllowlist = ['docs.example.com', 'qyapi.weixin.qq.com'];
    const out = derive(makeMember('normal'), policy);
    assert.deepStrictEqual(out.sandbox.network?.allowedDomains, [
      '127.0.0.1',
      'docs.example.com',
      'localhost',
      'qyapi.weixin.qq.com',
    ]);
  });

  it('passlist rules project to structural rule strings and compile into inline allow rules', () => {
    const policy = createDefaultBotRolePolicy('normal');
    policy.passlistRules = [
      {
        rule: 'Bash(git status)',
        provenance: { addedBy: 'owner-1', source: 'approval', createdAt: '2026-07-31T00:00:00.000Z' },
      },
      { rule: 'Bash(ls)' },
    ];
    const out = derive(makeMember('normal'), policy);
    assert.deepStrictEqual(out.passlistRules, ['Bash(git status)', 'Bash(ls)']);
    // U4 (KTD-2/KTD-13): the passlist is evaluated by the SDK structural rule
    // engine, so the derivation compiles it into settings.permissions.allow
    // (appended after the role's file-tool allows; deny rules still win).
    assert.deepStrictEqual(out.permissionRules.allow.slice(-2), ['Bash(git status)', 'Bash(ls)']);
  });

  it('passlist compiles into allow rules for every role', () => {
    for (const role of ['owner', 'admin', 'normal'] as const) {
      const policy = createDefaultBotRolePolicy(role);
      policy.passlistRules = [{ rule: 'Bash(git status)' }];
      const out = derive(makeMember(role), policy);
      assert.ok(
        out.permissionRules.allow.includes('Bash(git status)'),
        `${role} derivation must compile the passlist into allow rules`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Closed capability-dir set (KTD-29 / AE6 derivation-layer assertion)
// ---------------------------------------------------------------------------

describe('closed public capability-dir set', () => {
  it('admin write surface under .claude is exactly skills/ and agents/', () => {
    assert.deepStrictEqual([...PUBLIC_CAPABILITY_DIRS], ['skills', 'agents']);
    const out = derive(makeMember('admin'));
    const claudeAllows = (out.sandbox.filesystem?.allowWrite ?? []).filter((p) => p.includes('.claude'));
    assert.deepStrictEqual(claudeAllows, [`${WS}/.claude/skills`, `${WS}/.claude/agents`]);
    const editAllows = out.permissionRules.allow.filter((r) => r.startsWith('Edit('));
    assert.deepStrictEqual(editAllows, [
      `Edit(/${WS}/.claude/skills/**)`,
      `Edit(/${WS}/.claude/agents/**)`,
    ]);
  });

  it('no allow entry (any role, any list) references workspace plugins/ or credential files', () => {
    for (const role of ['owner', 'admin', 'normal'] as BotRoleKey[]) {
      const out = derive(makeMember(role));
      const allowSurface = [
        ...out.permissionRules.allow,
        ...(out.sandbox.filesystem?.allowWrite ?? []),
        ...(out.sandbox.filesystem?.allowRead ?? []),
      ].join('\n');
      assert.ok(!allowSurface.includes(`${WS}/.claude/plugins`), `${role}: workspace plugins/ not in allow surface`);
      for (const needle of ['.credentials.json', '.aws', '.ssh', 'id_rsa', '.pem', '.key']) {
        assert.ok(!allowSurface.includes(needle), `${role}: ${needle} not in allow surface`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sanitizer: fail-closed backfill
// ---------------------------------------------------------------------------

describe('sanitizeBotRolePolicy', () => {
  it('backfills new fields on the pre-U2 shape and preserves legacy data verbatim', () => {
    const oldShape = {
      normalToolPolicy: {
        posture: 'custom',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
          browser: 'deny',
        },
      },
      skillAllowlist: ['skill-a'],
      bashWhitelist: ['ls'],
    };
    const out = sanitizeBotRolePolicy(oldShape);
    // Legacy fields are preserved verbatim; the nested tool policy is
    // normalized by the same sanitizePolicy contract (fail-closed backfill).
    assert.strictEqual(out.normalToolPolicy.posture, 'custom');
    assert.deepStrictEqual(out.normalToolPolicy.categoryDefaults, oldShape.normalToolPolicy.categoryDefaults);
    assert.deepStrictEqual(out.skillAllowlist, ['skill-a']);
    assert.deepStrictEqual(out.bashWhitelist, ['ls']);
    assert.deepStrictEqual(out.disabledSkills, []);
    assert.deepStrictEqual(out.passlistRules, []);
    assert.deepStrictEqual(out.networkAllowlist, []);
    assert.strictEqual(out.skills, undefined);
  });

  it('returns the full fail-closed default for non-object input', () => {
    for (const bad of [null, undefined, 42, 'nope', [1, 2]]) {
      const out = sanitizeBotRolePolicy(bad);
      assert.deepStrictEqual(out, createDefaultBotRolePolicy('normal'), `input ${String(bad)}`);
    }
  });

  it('fail-closes a corrupt normalToolPolicy through the nested sanitizePolicy contract', () => {
    const out = sanitizeBotRolePolicy({
      normalToolPolicy: { posture: 'bogus', categoryDefaults: { fileRead: 'maybe', shell: 'deny' } },
    });
    assert.strictEqual(out.normalToolPolicy.posture, 'custom');
    assert.strictEqual(out.normalToolPolicy.categoryDefaults.fileRead, SAFE_PRESET.categoryDefaults.fileRead);
    assert.strictEqual(out.normalToolPolicy.categoryDefaults.shell, 'deny');
    assert.strictEqual(out.normalToolPolicy.categoryDefaults.browser, 'deny');
  });

  it('fail-closes a non-object normalToolPolicy to SAFE_PRESET', () => {
    const out = sanitizeBotRolePolicy({ normalToolPolicy: 7 });
    assert.strictEqual(out.normalToolPolicy.posture, SAFE_PRESET.posture);
    assert.deepStrictEqual(out.normalToolPolicy.categoryDefaults, SAFE_PRESET.categoryDefaults);
  });

  it('drops malformed list fields to empty arrays', () => {
    const out = sanitizeBotRolePolicy({
      skillAllowlist: 'oops',
      bashWhitelist: [1, 'ls', null],
      disabledSkills: { no: true },
      networkAllowlist: ['ok.com', '', 'has space', 'http://scheme.com', 5, '*.wild.com'],
    });
    assert.deepStrictEqual(out.skillAllowlist, []);
    assert.deepStrictEqual(out.bashWhitelist, ['ls']);
    assert.deepStrictEqual(out.disabledSkills, []);
    assert.deepStrictEqual(out.networkAllowlist, ['ok.com', '*.wild.com']);
  });

  it('skills: absent stays absent, valid array filters, invalid fail-closes to empty', () => {
    assert.strictEqual(sanitizeBotRolePolicy({}).skills, undefined);
    assert.deepStrictEqual(sanitizeBotRolePolicy({ skills: ['a', 1, 'b'] }).skills, ['a', 'b']);
    assert.deepStrictEqual(sanitizeBotRolePolicy({ skills: [] }).skills, []);
    assert.deepStrictEqual(sanitizeBotRolePolicy({ skills: 'all' }).skills, []);
  });

  it('passlist rules keep valid entries, accept bare strings, drop the rest', () => {
    const out = sanitizeBotRolePolicy({
      passlistRules: [
        'Bash(ls)',
        { rule: 'Bash(git status)', provenance: { addedBy: 'u1', source: 'approval', createdAt: '2026-07-31T00:00:00.000Z' } },
        { rule: 'Bash(bad)', provenance: { addedBy: 1, source: 'approval', createdAt: 'x' } },
        { rule: '' },
        { rule: 5 },
        42,
        {},
      ],
    });
    assert.deepStrictEqual(out.passlistRules, [
      { rule: 'Bash(ls)' },
      { rule: 'Bash(git status)', provenance: { addedBy: 'u1', source: 'approval', createdAt: '2026-07-31T00:00:00.000Z' } },
      { rule: 'Bash(bad)' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Store integration: read-path sanitizer + createBot seeding
// ---------------------------------------------------------------------------

describe('sqlite-store BotRolePolicy read path', () => {
  it('createBot seeds the new model defaults on every role', () => {
    const store = new SqliteStore(':memory:');
    store.resetData();
    const bot = store.createBot({ name: 'Seeded' });
    const normal = store.getBotRoleByKey(bot.id, 'normal');
    assert.deepStrictEqual(normal?.permissions, createDefaultBotRolePolicy('normal'));
    const owner = store.getBotRoleByKey(bot.id, 'owner');
    assert.deepStrictEqual(owner?.permissions, createDefaultBotRolePolicy('owner'));
  });

  it('old-shape stored policy reads back with fail-closed backfill', () => {
    const store = new SqliteStore(':memory:');
    store.resetData();
    const bot = store.createBot({ name: 'OldShape' });
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const oldShape = {
      normalToolPolicy: {
        posture: 'safe',
        categoryDefaults: {
          fileRead: 'allow',
          fileWrite: 'deny',
          shell: 'deny',
          network: 'deny',
          subagents: 'deny',
          reply: 'allow',
          browser: 'deny',
        },
      },
      skillAllowlist: ['skill-a'],
      bashWhitelist: ['ls'],
    } as unknown as BotRolePolicy;
    store.updateBotRole(role.id, oldShape);
    const reread = store.getBotRoleByKey(bot.id, 'normal');
    assert.deepStrictEqual(reread?.permissions, sanitizeBotRolePolicy(oldShape));
    assert.deepStrictEqual(reread?.permissions.disabledSkills, []);
    assert.deepStrictEqual(reread?.permissions.passlistRules, []);
    assert.deepStrictEqual(reread?.permissions.networkAllowlist, []);
    assert.deepStrictEqual(reread?.permissions.skillAllowlist, ['skill-a']);
  });

  it('corrupt permissions_json reads back as the fail-closed default', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-access-store-'));
    const dbFile = path.join(tmpDir, 'data.db');
    const store = new SqliteStore(dbFile);
    store.resetData();
    const bot = store.createBot({ name: 'Corrupt' });
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);

    const raw = new Database(dbFile);
    raw.prepare('UPDATE bot_roles SET permissions_json = ? WHERE id = ?').run('{{{ not json', role.id);
    raw.close();

    const reread = store.getBotRoleByKey(bot.id, 'normal');
    assert.deepStrictEqual(reread?.permissions, createDefaultBotRolePolicy('normal'));
    store.resetData();
  });
});

// ---------------------------------------------------------------------------
// New bot zero-config derivation (R14 / AE4 defaults)
// ---------------------------------------------------------------------------

describe('new-bot zero-config derivation', () => {
  it('a freshly created bot derives sandboxed normal access with network deny and empty passlist', () => {
    const store = new SqliteStore(':memory:');
    store.resetData();
    const bot = store.createBot({ name: 'ZeroConfig' });
    const role = store.getBotRoleByKey(bot.id, 'normal');
    assert.ok(role);
    const out = deriveBotAccess(bot, makeMember('normal'), role.permissions, WS, makeOptions());
    assert.strictEqual(out.sandbox.enabled, true);
    assert.strictEqual(out.sandbox.failIfUnavailable, true);
    assert.strictEqual(out.sandbox.network?.strictAllowlist, true);
    assert.deepStrictEqual(out.sandbox.network?.allowedDomains, [
      '127.0.0.1',
      'localhost',
      'qyapi.weixin.qq.com',
    ]);
    assert.deepStrictEqual(out.passlistRules, []);
    assert.deepStrictEqual(out.sandbox.filesystem?.allowWrite, [
      `${WS}/data/alice`,
      `${WS}/data/alice/.runtime`,
    ]);
    assert.strictEqual(out.sandbox.allowUnsandboxedCommands, false);
  });
});

// ---------------------------------------------------------------------------
// userDirName validation
// ---------------------------------------------------------------------------

describe('validateUserDirName', () => {
  const cases: Array<[string, boolean]> = [
    ['..', false],
    ['a/b', false],
    ['a\\b', false],
    ['A*', false],
    ['a?b', false],
    ['a[b', false],
    ['~x', false],
    ['a..b', false],
    ['', false],
    ['anonymous', false],
    ['ANONYMOUS', false],
    ['AnOnYmOuS', false],
    ['x'.repeat(65), false],
    ['.abc', false],
    ['-abc', false],
    ['_abc', false],
    ['a b', false],
    ['café', false],
    ['alice', true],
    ['A1.b-c_d', true],
    ['0', true],
    ['a'.repeat(64), true],
  ];

  for (const [name, expected] of cases) {
    it(`${JSON.stringify(name)} -> ${expected ? 'valid' : 'invalid'}`, () => {
      assert.strictEqual(validateUserDirName(name).ok, expected);
    });
  }

  it('NFC-normalizes before validating', () => {
    // 'é' decomposed still fails the ASCII charset, but normalization must not throw
    // and the verdict must be identical for composed and decomposed input.
    const composed = validateUserDirName('é');
    const decomposed = validateUserDirName('é');
    assert.strictEqual(composed.ok, false);
    assert.strictEqual(decomposed.ok, false);
  });
});

describe('userDirNameKey', () => {
  it('case-folds for collision checks', () => {
    assert.strictEqual(userDirNameKey('Alice'), userDirNameKey('ALICE'));
    assert.strictEqual(userDirNameKey('Alice'), 'alice');
  });

  it('NFC-normalizes so composed and decomposed forms collide', () => {
    assert.strictEqual(userDirNameKey('Å'), userDirNameKey('Å'));
  });
});

describe('fail-closed derivation on invalid identity', () => {
  const closedShapeAssertions = (out: ReturnType<typeof derive>) => {
    assert.deepStrictEqual(out.permissionRules.allow, []);
    assert.deepStrictEqual(out.sandbox.filesystem?.allowWrite, []);
    assert.deepStrictEqual(out.sandbox.filesystem?.allowRead, []);
    assert.deepStrictEqual(out.sandbox.filesystem?.denyRead, ['/']);
    assert.deepStrictEqual(out.sandbox.filesystem?.denyWrite, ['/']);
    assert.deepStrictEqual(out.sandbox.network?.allowedDomains, []);
    assert.strictEqual(out.sandbox.network?.strictAllowlist, true);
    assert.deepStrictEqual(out.passlistRules, []);
  };

  it('normal member with an invalid userDirName derives a fully closed shape', () => {
    for (const bad of ['..', 'a/b', 'A*', '~x', 'anonymous', '']) {
      const out = derive(makeMember('normal', { channelUserId: bad }));
      closedShapeAssertions(out);
    }
  });

  it('normal member without any identity derives a fully closed shape', () => {
    const out = derive(makeMember('normal', { channelUserId: null }));
    closedShapeAssertions(out);
  });

  it('null member derives a fully closed shape', () => {
    const out = derive(null);
    closedShapeAssertions(out);
  });

  it('closed derivation never targets data/anonymous as an allow', () => {
    const out = derive(makeMember('normal', { channelUserId: null }));
    assert.ok(!JSON.stringify(out).includes('data/anonymous'));
  });
});

describe('identity stability', () => {
  it('prefers plaintextUserId over channelUserId deterministically (no flapping double dir)', () => {
    const member = makeMember('normal', { channelUserId: 'enc-1', plaintextUserId: 'Alice' });
    const first = derive(member);
    const second = derive(member);
    assert.deepStrictEqual(first, second);
    const serialized = JSON.stringify(first);
    assert.ok(serialized.includes(`${WS}/data/Alice`), 'plaintext id is the dir');
    assert.ok(!serialized.includes('enc-1'), 'encrypted id never appears once plaintext resolves');
  });

  it('falls back to channelUserId while plaintext is unresolved', () => {
    const out = derive(makeMember('normal', { channelUserId: 'enc-1', plaintextUserId: null }));
    assert.ok(JSON.stringify(out.sandbox.filesystem).includes(`${WS}/data/enc-1`));
  });
});

// ---------------------------------------------------------------------------
// credentials.envVars computation (KTD-8)
// ---------------------------------------------------------------------------

describe('credentials.envVars computation', () => {
  it('contains every provider customEnvVars key for each provider fixture', () => {
    const providerFixtures = [
      { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn', MOONSHOT_API_KEY: 'mk-123456' },
      { OPENAI_API_KEY: 'ok-123456', ZHIPU_AUTH_TOKEN: 'zt-123456' },
      { CUSTOM_PROVIDER_SECRET: 'cs-123456' },
      {},
    ];
    for (const customEnvVars of providerFixtures) {
      const out = derive(makeMember('normal'), undefined, { providerEnv: customEnvVars });
      const denied = new Set((out.sandbox.credentials?.envVars ?? []).map((e) => e.name));
      for (const key of Object.keys(customEnvVars)) {
        assert.ok(denied.has(key), `${key} must be denied (provider fixture ${JSON.stringify(Object.keys(customEnvVars))})`);
      }
      assert.ok(denied.has('ANTHROPIC_API_KEY'), 'settingsEnv keys always denied');
    }
  });

  it('denies secret-looking and canary-matching child env vars, keeps the benign allowlist', () => {
    const out = derive(makeMember('normal'), undefined, {
      settingsEnv: { ANTHROPIC_API_KEY: 'sk-canary-value-123' },
      childEnv: {
        PATH: '/usr/bin',
        HOME: HOME,
        LANG: 'en_US.UTF-8',
        TMPDIR: '/tmp',
        WECOM_CLI_PATH: CLI_PATH,
        GITHUB_TOKEN: 'ghp-example',
        DISGUISED: 'prefix-sk-canary-value-123-suffix',
        BORING: 'hello',
      },
    });
    const denied = new Set((out.sandbox.credentials?.envVars ?? []).map((e) => e.name));
    assert.ok(denied.has('ANTHROPIC_API_KEY'));
    assert.ok(denied.has('GITHUB_TOKEN'), 'secret-looking name denied');
    assert.ok(denied.has('DISGUISED'), 'value-canary match denied');
    assert.ok(!denied.has('BORING'), 'benign value under threshold not denied');
    for (const benign of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'WECOM_CLI_PATH']) {
      assert.ok(!denied.has(benign), `${benign} stays allowed`);
    }
  });

  it('credential files are denied for non-owner roles only', () => {
    for (const role of ['admin', 'normal'] as BotRoleKey[]) {
      const out = derive(makeMember(role));
      assert.deepStrictEqual(out.sandbox.credentials?.files, [
        { path: '~/.aws', mode: 'deny' },
        { path: '~/.ssh', mode: 'deny' },
      ]);
    }
    assert.deepStrictEqual(derive(makeMember('owner')).sandbox.credentials?.files, []);
  });
});

// ---------------------------------------------------------------------------
// Plugins (KTD-3 re-attachment)
// ---------------------------------------------------------------------------

describe('derived plugins', () => {
  it('includes the bundled wecom plugin when the bot is wecom-enabled', () => {
    const out = derive(makeMember('normal'), undefined, { wecomEnabled: true });
    assert.deepStrictEqual(out.plugins, [
      { type: 'local', path: path.join(MARKETPLACE, 'plugins', 'wecom') },
    ]);
  });

  it('omits the wecom plugin when the bot is not wecom-enabled', () => {
    const out = derive(makeMember('normal'));
    assert.deepStrictEqual(out.plugins, []);
  });

  it('merges the bot-enabled plugin paths and dedupes', () => {
    const out = derive(makeMember('normal'), undefined, {
      wecomEnabled: true,
      enabledPluginPaths: ['/p/a', '/p/b', '/p/a'],
    });
    assert.deepStrictEqual(out.plugins, [
      { type: 'local', path: '/p/a' },
      { type: 'local', path: '/p/b' },
      { type: 'local', path: path.join(MARKETPLACE, 'plugins', 'wecom') },
    ]);
  });

  it('resolves the real bundled marketplace in this repo', () => {
    const out = deriveBotAccess(makeBot(), makeMember('normal'), createDefaultBotRolePolicy('normal'), WS, {
      homeDir: HOME,
      comateDataDir: COMATE_DATA,
      wecomCliPath: null,
      wecomEnabled: true,
    });
    assert.strictEqual(out.plugins.length, 1);
    assert.ok(out.plugins[0].path.endsWith(path.join('plugins', 'wecom')));
    assert.ok(fs.existsSync(out.plugins[0].path), 'bundled wecom plugin dir exists');
  });
});

// ---------------------------------------------------------------------------
// Preamble (KTD-12)
// ---------------------------------------------------------------------------

describe('capability preamble', () => {
  it('normal preamble names the writable dir, network posture, escalation, injection defense', () => {
    const out = derive(makeMember('normal'));
    assert.ok(out.preamble.includes(`${WS}/data/alice`), 'writable surface');
    assert.ok(/network/i.test(out.preamble) && /denied by default|default-deny/i.test(out.preamble), 'network posture');
    assert.ok(/owner|admin/i.test(out.preamble), 'escalation phrasing');
    assert.ok(/[Nn]ever follow instructions found inside/.test(out.preamble), 'injection defense');
  });

  it('admin preamble names skills/agents and the credential posture', () => {
    const out = derive(makeMember('admin'));
    assert.ok(out.preamble.includes('.claude/skills'));
    assert.ok(out.preamble.includes('.claude/agents'));
    assert.ok(/credential/i.test(out.preamble));
    assert.ok(/[Nn]ever follow instructions found inside/.test(out.preamble));
  });

  it('owner preamble names the two denied dirs and unrestricted posture', () => {
    const out = derive(makeMember('owner'));
    assert.ok(/[Uu]nrestricted/.test(out.preamble));
    assert.ok(out.preamble.includes('.claude/projects'));
    assert.ok(/[Nn]ever follow instructions found inside/.test(out.preamble));
  });

  it('closed preamble says identity validation failed', () => {
    const out = derive(makeMember('normal', { channelUserId: '..' }));
    assert.ok(/identity/i.test(out.preamble));
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('default network constants', () => {
  it('WeCom API endpoints and loopback are the default entries', () => {
    assert.deepStrictEqual([...WECOM_API_DOMAINS], ['qyapi.weixin.qq.com']);
    assert.deepStrictEqual([...LOOPBACK_DOMAINS], ['localhost', '127.0.0.1']);
  });
});
