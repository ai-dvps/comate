import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCALATION_GLOBAL_PENDING_CAP,
  ESCALATION_PER_USER_HOURLY_CAP,
  OVERRIDE_DENY_CAP_PER_TURN,
  computeAlwaysAllowRules,
  exactSessionUpdatedPermissions,
  generalizedEscalationSignature,
} from './bot-escalation-guard.js';
import type { PermissionSuggestion } from '../types/message.js';

describe('bot-escalation-guard (U11)', () => {
  describe('generalizedEscalationSignature (KTD-19)', () => {
    it('collapses parameter variants of the same command into one signature', () => {
      const a = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'curl https://a.com/1' });
      const b = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'curl https://evil.com' });
      assert.strictEqual(a, b, 'parameter variants dedupe together (50 variants → 1 pending)');
    });

    it('distinguishes different command heads', () => {
      const a = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'curl https://a.com' });
      const b = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'wget https://a.com' });
      assert.notStrictEqual(a, b);
    });

    it('strips wrapper prefixes (timeout/nice/command) like the SDK rule engine', () => {
      const plain = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'curl https://a.com' });
      const wrapped = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'timeout 30 curl https://a.com' });
      const niced = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'nice -n 5 curl https://a.com' });
      const commanded = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'command curl https://a.com' });
      assert.strictEqual(plain, wrapped);
      assert.strictEqual(plain, niced);
      assert.strictEqual(plain, commanded);
    });

    it('composes per-subcommand heads for compound commands', () => {
      const a = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'git status && curl https://a.com/1' });
      const b = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'git status && curl https://a.com/2' });
      const c = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'git pull && curl https://a.com/1' });
      const d = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'git status && wget https://a.com/1' });
      assert.strictEqual(a, b);
      // Coarse by design: git-subcommand variants share a head — merging is
      // deny-side safe and bounds card spam (KTD-19).
      assert.strictEqual(a, c);
      assert.notStrictEqual(a, d);
    });

    it('scopes by reason so U9 network/mcp-write escalations never collide with escape', () => {
      const escape = generalizedEscalationSignature({ reason: 'escape', toolName: 'Bash', command: 'curl https://a.com' });
      const network = generalizedEscalationSignature({ reason: 'network', toolName: 'Bash', command: 'curl https://a.com' });
      assert.notStrictEqual(escape, network);
    });

    it('falls back to reason(toolName) when there is no command (U9 MCP tools)', () => {
      const sig = generalizedEscalationSignature({ reason: 'mcp-write', toolName: 'mcp__docs__update' });
      assert.strictEqual(sig, 'mcp-write(mcp__docs__update)');
    });
  });

  describe('computeAlwaysAllowRules (KTD-18)', () => {
    const addRulesAllow: PermissionSuggestion = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'curl *' }],
      behavior: 'allow',
      destination: 'localSettings',
    };

    it('produces the exact-match literal rule for a Bash command (AE8)', () => {
      const out = computeAlwaysAllowRules({
        toolName: 'Bash',
        command: 'curl https://a.com/x',
        suggestions: [addRulesAllow],
      });
      assert.deepStrictEqual(out.rules, ['Bash(curl https://a.com/x)']);
      assert.strictEqual(out.suppressedReason, undefined);
    });

    it('suppresses when any suggestion is not addRules+allow (setMode dropped + button hidden)', () => {
      const out = computeAlwaysAllowRules({
        toolName: 'Bash',
        command: 'curl https://a.com/x',
        suggestions: [
          addRulesAllow,
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      });
      assert.deepStrictEqual(out.rules, []);
      assert.match(out.suppressedReason ?? '', /dropped-suggestion-types:setMode/);
    });

    it('suppresses addDirectories and replaceRules suggestions too', () => {
      const out = computeAlwaysAllowRules({
        toolName: 'Bash',
        command: 'ls /tmp',
        suggestions: [
          { type: 'addDirectories', directories: ['/tmp'], destination: 'session' },
          { type: 'replaceRules', rules: [], behavior: 'allow', destination: 'session' },
        ],
      });
      assert.deepStrictEqual(out.rules, []);
      assert.match(out.suppressedReason ?? '', /addDirectories/);
      assert.match(out.suppressedReason ?? '', /replaceRules/);
    });

    it('suppresses when there are no addRules suggestions at all (no always-allow button)', () => {
      const out = computeAlwaysAllowRules({
        toolName: 'Bash',
        command: 'curl https://a.com/x',
        suggestions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
      });
      assert.deepStrictEqual(out.rules, []);
      const noSuggestions = computeAlwaysAllowRules({ toolName: 'Bash', command: 'ls', suggestions: [] });
      assert.deepStrictEqual(noSuggestions.rules, []);
      assert.strictEqual(noSuggestions.suppressedReason, 'no-addRules-suggestion');
    });

    it('suppresses composite commands (exact-match rules cannot express them)', () => {
      for (const command of ['git status && curl x', 'cat a | grep b', 'echo a; rm b', 'echo `whoami`', 'echo $(id)']) {
        const out = computeAlwaysAllowRules({ toolName: 'Bash', command, suggestions: [addRulesAllow] });
        assert.deepStrictEqual(out.rules, [], command);
        assert.strictEqual(out.suppressedReason, 'composite-command');
      }
    });

    it('suppresses non-Bash tools (no literal rule form until U9)', () => {
      const out = computeAlwaysAllowRules({ toolName: 'mcp__docs__update', suggestions: [addRulesAllow] });
      assert.deepStrictEqual(out.rules, []);
      assert.strictEqual(out.suppressedReason, 'no-exact-rule-form');
    });
  });

  describe('exactSessionUpdatedPermissions (KTD-18)', () => {
    it('maps exact rules to addRules+allow+session only (never a settings file)', () => {
      const out = exactSessionUpdatedPermissions(['Bash(curl https://a.com/x)']);
      assert.deepStrictEqual(out, [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'curl https://a.com/x' }],
          behavior: 'allow',
          destination: 'session',
        },
      ]);
    });

    it('returns [] for unparseable rules', () => {
      assert.deepStrictEqual(exactSessionUpdatedPermissions(['not-a-rule']), []);
    });
  });

  it('anti-spam caps are sane bounds (KTD-19)', () => {
    assert.ok(ESCALATION_PER_USER_HOURLY_CAP > 0 && ESCALATION_PER_USER_HOURLY_CAP <= 60);
    assert.ok(ESCALATION_GLOBAL_PENDING_CAP >= ESCALATION_PER_USER_HOURLY_CAP);
    assert.ok(OVERRIDE_DENY_CAP_PER_TURN >= 2 && OVERRIDE_DENY_CAP_PER_TURN <= 20);
  });
});
