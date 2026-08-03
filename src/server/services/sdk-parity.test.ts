import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import { resolveSdkBinary } from '../utils/resolve-sdk-binary.js';

/**
 * SDK-behavior parity tests (U1, KTD-25).
 *
 * The bot permission gate (chat-service.ts canUseTool closures) depends on a
 * set of @anthropic-ai/claude-agent-sdk contracts that are NOT covered by the
 * SDK's semver surface: compound-bash per-subcommand evaluation, the built-in
 * read-only auto-approve set, the sandbox Options channel, and the
 * CanUseTool/PermissionResult shapes. A future SDK upgrade that silently
 * changes any of these must fail HERE — loudly — instead of weakening the bot
 * gate in production. See docs/solutions/integration-issues/
 * claude-sdk-transcript-path-encoding-windows-analytics.md for the "SDK
 * coupling assumptions must fail loudly" doctrine.
 */

const require = createRequire(import.meta.url);

function resolveSdkPackageDir(): string {
  // The package's exports map hides ./package.json, so resolve the main entry
  // (sdk.mjs) and take its directory.
  return path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
}

function readSdkTypes(): string {
  return fs.readFileSync(path.join(resolveSdkPackageDir(), 'sdk.d.ts'), 'utf8');
}

function readSdkRuntimeSource(): string {
  return fs.readFileSync(path.join(resolveSdkPackageDir(), 'sdk.mjs'), 'utf8');
}

function extractRegion(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `SDK surface is missing region start marker: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.notStrictEqual(end, -1, `SDK surface is missing region end marker: ${endMarker}`);
  return src.slice(start, end + endMarker.length);
}

let cliBinaryCache: Buffer | undefined;

function readCliBinary(): Buffer {
  if (!cliBinaryCache) {
    const binaryPath = resolveSdkBinary();
    assert.ok(
      binaryPath,
      'resolveSdkBinary() must locate the platform CLI binary — the parity probe reads the read-only command set from it',
    );
    cliBinaryCache = fs.readFileSync(binaryPath);
  }
  return cliBinaryCache;
}

/**
 * The built-in read-only command set auto-approved by the CLI's compound-bash
 * evaluator before canUseTool is consulted (CLI 2.1.220, shipped with SDK
 * 0.3.220). The bot gate's bash policy assumes exactly this set: a future SDK
 * that WIDENS it would let commands bypass canUseTool silently, and one that
 * narrows it changes user-visible behavior. Any drift must be reviewed and
 * re-pinned deliberately.
 */
const PINNED_READ_ONLY_COMMANDS = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'grep',
  'egrep',
  'fgrep',
  'diff',
  'du',
  'df',
  'echo',
  'strings',
  'hexdump',
  'od',
  'nl',
  'cut',
  'column',
  'tr',
  'tac',
  'rev',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'sha256sum',
  'sha1sum',
  'md5sum',
  'cd',
];

function extractReadOnlyCommandSet(): { commands: string[]; occurrences: number } {
  const buf = readCliBinary();
  const marker = 'new Set(["ls","cat"';
  const commands: string[] = [];
  let occurrences = 0;
  let idx = -1;
  while ((idx = buf.indexOf(marker, idx + 1)) !== -1) {
    occurrences += 1;
    const window = buf.subarray(idx, idx + 512).toString('latin1');
    const match = window.match(/new Set\(\[([^\]]*)\]\)/);
    assert.ok(match, `read-only command set literal found at offset ${idx} but could not be parsed`);
    for (const entry of match[1].split(',')) {
      commands.push(entry.replace(/"/g, ''));
    }
  }
  return { commands, occurrences };
}

describe('sdk-parity (bot gate contracts)', { concurrency: false }, () => {
  it('Options.sandbox accepts SandboxSettings and failIfUnavailable defaults per the documented contract', async () => {
    // Type-surface contract: Options exposes the sandbox channel and the
    // SandboxSettings schema carries the filesystem/network/credentials groups
    // the bot sandbox policy is built on.
    const dts = readSdkTypes();
    assert.ok(
      dts.includes('sandbox?: SandboxSettings;'),
      'Options no longer declares `sandbox?: SandboxSettings` — the sandbox Options channel is gone',
    );
    const schemaRegion = extractRegion(
      dts,
      'declare const SandboxSettingsSchema',
      '}, z.core.$loose>;',
    );
    for (const field of ['enabled:', 'failIfUnavailable:', 'network:', 'filesystem:', 'credentials:']) {
      assert.ok(
        schemaRegion.includes(field),
        `SandboxSettings lost the "${field}" group the bot sandbox policy depends on`,
      );
    }
    // Documented default: enabled:true via the Options channel implies
    // failIfUnavailable:true unless explicitly overridden. The bot gate relies
    // on this fail-closed default.
    assert.ok(
      dts.includes('`failIfUnavailable` defaults to `true`'),
      'SDK documentation no longer states the failIfUnavailable default — re-verify the fail-closed contract',
    );
    // The shipped runtime must actually implement the documented default
    // (minification strips comments but not property names).
    const runtimeSource = readSdkRuntimeSource();
    assert.ok(
      runtimeSource.includes('failIfUnavailable'),
      'SDK runtime no longer references failIfUnavailable — the documented default may have been dropped',
    );

    // Value-level construction: an Options literal carrying the full
    // SandboxSettings surface must be accepted and passed through unchanged.
    const sandbox: NonNullable<Options['sandbox']> = {
      enabled: true,
      failIfUnavailable: false,
      filesystem: { allowWrite: ['/tmp'], denyRead: ['/etc'] },
      network: { allowedDomains: ['example.com'], strictAllowlist: true },
      credentials: { envVars: [{ name: 'WECOM_BOT_SECRET', mode: 'deny' }] },
    };
    const options: Options = { cwd: '/tmp', sandbox };
    assert.deepStrictEqual(options.sandbox, sandbox, 'Options.sandbox must pass through unchanged');

    // Behavioral probe: the Options channel is live — query() validates the
    // sandbox option before spawning the CLI (a settings FILE path conflicts
    // with it). If this stops throwing, the SDK stopped consuming
    // Options.sandbox on this channel. The validation may surface
    // synchronously from query() or as a rejection of the first next().
    let q: ReturnType<typeof query> | undefined;
    try {
      q = query({
        prompt: 'parity probe',
        options: {
          sandbox: { enabled: true },
          settings: '/nonexistent/settings.json',
          pathToClaudeCodeExecutable: '/nonexistent/claude',
        },
      });
    } catch (err) {
      assert.match(
        (err as Error).message,
        /Cannot use both a settings file path and the sandbox option/,
        'query() rejected the sandbox+settings-file combination with an unexpected error',
      );
    }
    if (q) {
      try {
        const first = q.next();
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('sandbox parity probe timed out')), 15000);
        });
        await assert.rejects(
          Promise.race([first, timeout]),
          /Cannot use both a settings file path and the sandbox option/,
          'query() must reject a settings-file path combined with Options.sandbox — the sandbox Options channel is no longer validated',
        );
      } finally {
        try {
          q.close();
        } catch {
          // The query may already be torn down after the rejection.
        }
      }
    }
  });

  it('compound-bash per-subcommand evaluation is exposed via the subcommandResults decision-reason discriminator', () => {
    // The bot gate relies on the SDK evaluating each subcommand of a compound
    // bash invocation BEFORE canUseTool fires. The type surface exposes this
    // through the decision_reason_type discriminator on the wire
    // permission-request type.
    const dts = readSdkTypes();
    assert.ok(
      dts.includes(
        "decision_reason_type?: 'rule' | 'mode' | 'subcommandResults' | 'permissionPromptTool' | 'hook' | 'asyncAgent' | 'sandboxOverride' | 'workingDir' | 'safetyCheck' | 'classifier' | 'other';",
      ),
      'SDK wire type lost the subcommandResults decision_reason_type discriminator the bot gate matches on',
    );
    assert.ok(
      dts.includes('For compound bash commands this is "subcommandResults"'),
      'SDK docs no longer tie subcommandResults to compound-bash per-subcommand evaluation',
    );
    // The shipped CLI binary must actually implement the discriminator.
    const buf = readCliBinary();
    assert.notStrictEqual(
      buf.indexOf('subcommandResults'),
      -1,
      'CLI binary lost the subcommandResults evaluator — compound-bash handling changed',
    );
  });

  it('built-in read-only command set matches the pinned list (widening must fail loudly)', () => {
    const { commands, occurrences } = extractReadOnlyCommandSet();
    assert.strictEqual(
      occurrences,
      1,
      'expected exactly one read-only command set literal in the CLI binary — the probe is ambiguous and must be re-anchored',
    );
    assert.deepStrictEqual(
      [...commands].sort(),
      [...PINNED_READ_ONLY_COMMANDS].sort(),
      'CLI read-only auto-approve set drifted from the pinned list — review the bot permission gate before adopting this SDK',
    );
  });

  it('CanUseTool signature and PermissionResult shapes match chat-service usage', async () => {
    const dts = readSdkTypes();
    const canUseToolRegion = extractRegion(
      dts,
      'export declare type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {',
      '}) => Promise<PermissionResult | null>;',
    );
    for (const fragment of [
      'signal: AbortSignal;',
      'suggestions?: PermissionUpdate[];',
      'title?: string;',
      'description?: string;',
      'toolUseID: string;',
    ]) {
      assert.ok(
        canUseToolRegion.includes(fragment),
        `CanUseTool lost the field chat-service.ts relies on: ${fragment}`,
      );
    }
    const permissionResultRegion = extractRegion(
      dts,
      "export declare type PermissionResult = {",
      'message: string;',
    );
    for (const fragment of [
      "behavior: 'allow';",
      'updatedInput?: Record<string, unknown>;',
      "updatedPermissions?: PermissionUpdate[];",
      "behavior: 'deny';",
      'message: string;',
    ]) {
      assert.ok(
        permissionResultRegion.includes(fragment),
        `PermissionResult lost the shape chat-service.ts relies on: ${fragment}`,
      );
    }

    // Runtime shape probe mirroring the chat-service.ts callback: allow with
    // updatedPermissions, deny with a generic message.
    const callback: CanUseTool = async (toolName, input, opts) => {
      assert.ok(opts.signal instanceof AbortSignal, 'canUseTool options must carry an AbortSignal');
      assert.strictEqual(typeof opts.toolUseID, 'string', 'canUseTool options must carry toolUseID');
      if (toolName === 'SecretTool') {
        const deny: PermissionResult = {
          behavior: 'deny',
          message: "I can't do that in this workspace.",
        };
        return deny;
      }
      const updatedPermissions: PermissionUpdate[] = [
        {
          type: 'addRules',
          rules: [{ toolName, ruleContent: 'ls *' }],
          behavior: 'allow',
          destination: 'session',
        },
      ];
      const allow: PermissionResult = { behavior: 'allow', updatedInput: input, updatedPermissions };
      return allow;
    };
    const optsBag = {
      signal: new AbortController().signal,
      suggestions: [],
      title: 'Run command',
      description: 'Claude wants to run ls',
      toolUseID: 'toolu_parity_1',
      requestId: 'req_parity_1',
    };
    const allowResult = await callback('Bash', { command: 'ls' }, optsBag);
    assert.deepStrictEqual(allowResult, {
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'ls *' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });
    const denyResult = await callback('SecretTool', {}, optsBag);
    assert.deepStrictEqual(denyResult, {
      behavior: 'deny',
      message: "I can't do that in this workspace.",
    });
  });
});
