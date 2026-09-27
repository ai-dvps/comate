import '../test-utils/test-env.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BotEscalationLedgerService,
  ESCALATION_APPROVAL_TTL_MS,
  __setEscalationTtlForTesting,
} from './bot-escalation-ledger.js';
import { BotAuditLogger } from './bot-audit-logger.js';
import { createIsolatedStore } from '../test-utils/test-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

describe('bot-escalation-ledger (U8)', { concurrency: false }, () => {
  let store: SqliteStore;
  let ledger: BotEscalationLedgerService;

  beforeEach(() => {
    store = createIsolatedStore();
    ledger = new BotEscalationLedgerService(store, new BotAuditLogger(store));
  });

  afterEach(() => {
    __setEscalationTtlForTesting(undefined);
    store.resetData();
  });

  function pendingInput(overrides: Record<string, unknown> = {}) {
    return {
      requestId: 'req-1',
      botId: 'bot-1',
      sessionId: 'sess-1',
      audience: 'self' as const,
      requester: { channel: 'wecom', channelUserId: 'owner-1', role: 'owner' },
      recipients: [{ userId: 'owner-1', taskId: 'req-1' }],
      rulePayload: { toolName: 'Bash', command: 'curl https://example.com' },
      ...overrides,
    };
  }

  it('createPending + get round-trips the row (parse/write)', () => {
    const entry = ledger.createPending(pendingInput());
    assert.ok(entry);
    assert.strictEqual(entry.state, 'pending');
    assert.strictEqual(entry.audience, 'self');
    assert.strictEqual(entry.resolvedAt, null);
    assert.strictEqual(entry.resolution, null);

    const fetched = ledger.get('req-1');
    assert.deepStrictEqual(fetched, entry);
    assert.deepStrictEqual(fetched!.requester, { channel: 'wecom', channelUserId: 'owner-1', role: 'owner' });
    assert.deepStrictEqual(fetched!.recipients, [{ userId: 'owner-1', taskId: 'req-1' }]);
    assert.deepStrictEqual(fetched!.rulePayload, { toolName: 'Bash', command: 'curl https://example.com' });
  });

  it('applies the default 30-minute TTL when no explicit ttlMs is given', () => {
    const now = 1_800_000_000_000;
    const entry = ledger.createPending(pendingInput({ now }));
    assert.ok(entry);
    assert.strictEqual(Date.parse(entry.expiresAt) - Date.parse(entry.createdAt), ESCALATION_APPROVAL_TTL_MS);
    assert.strictEqual(ESCALATION_APPROVAL_TTL_MS, 30 * 60 * 1000);
  });

  it('honors an explicit ttlMs (tool-input timeout) and the test override', () => {
    const now = 1_800_000_000_000;
    const withTtl = ledger.createPending(pendingInput({ requestId: 'req-ttl', now, ttlMs: 5000 }));
    assert.strictEqual(Date.parse(withTtl!.expiresAt) - now, 5000);

    __setEscalationTtlForTesting(1234);
    const overridden = ledger.createPending(pendingInput({ requestId: 'req-override', now }));
    assert.strictEqual(Date.parse(overridden!.expiresAt) - now, 1234);
  });

  it('clamps audience=self to admins when the requester is not owner/admin (fail-safe invariant)', () => {
    const entry = ledger.createPending(
      pendingInput({
        requestId: 'req-clamp',
        audience: 'self',
        requester: { channel: 'wecom', channelUserId: 'user-1', role: 'normal' },
      }),
    );
    assert.ok(entry);
    assert.strictEqual(entry.audience, 'admins', 'self-audience must never survive a normal requester');
    assert.strictEqual(ledger.get('req-clamp')!.audience, 'admins');
  });

  it('keeps audience=admins for a normal requester (default fail-safe)', () => {
    const entry = ledger.createPending(
      pendingInput({
        requestId: 'req-admins',
        audience: 'admins',
        requester: { channel: 'wecom', channelUserId: 'user-1', role: 'normal' },
      }),
    );
    assert.strictEqual(entry!.audience, 'admins');
  });

  it('settle(approved) transitions pending → approved with resolution meta; a second settle is a no-op', () => {
    ledger.createPending(pendingInput());
    const settled = ledger.settle('req-1', 'approved', {
      approver: { type: 'wecom', channelKey: 'wecom', channelUserId: 'owner-1' },
      decision: 'allow',
      source: 'self-approval',
    });
    assert.ok(settled);
    assert.strictEqual(settled.state, 'approved');
    assert.ok(settled.resolvedAt);
    assert.deepStrictEqual(settled.resolution, {
      approver: { type: 'wecom', channelKey: 'wecom', channelUserId: 'owner-1' },
      decision: 'allow',
      source: 'self-approval',
    });

    // Late/duplicate resolution (double click, replay) must not flip the row.
    const late = ledger.settle('req-1', 'denied', {
      approver: { type: 'user' },
      decision: 'deny',
      source: 'desktop',
    });
    assert.strictEqual(late, null);
    assert.strictEqual(ledger.get('req-1')!.state, 'approved');
  });

  it('expire transitions pending → expired and refuses to expire a settled row', () => {
    ledger.createPending(pendingInput());
    const expired = ledger.expire('req-1', {
      approver: { type: 'system' },
      decision: 'expired',
      source: 'timeout',
    });
    assert.ok(expired);
    assert.strictEqual(expired.state, 'expired');
    assert.strictEqual(expired.resolution!.source, 'timeout');

    assert.strictEqual(
      ledger.expire('req-1', { approver: { type: 'system' }, decision: 'expired', source: 'boot-recovery' }),
      null,
    );
    assert.strictEqual(ledger.get('req-1')!.resolution!.source, 'timeout');
  });

  it('expireAllPendingForBoot expires every pending row, leaves settled rows, and audits each expiry', () => {
    ledger.createPending(pendingInput({ requestId: 'req-p1' }));
    ledger.createPending(
      pendingInput({
        requestId: 'req-p2',
        sessionId: 'sess-2',
        requester: { channel: 'wecom', channelUserId: 'admin-1', role: 'admin' },
      }),
    );
    ledger.createPending(pendingInput({ requestId: 'req-settled' }));
    ledger.settle('req-settled', 'approved', {
      approver: { type: 'wecom', channelKey: 'wecom', channelUserId: 'owner-1' },
      decision: 'allow',
      source: 'self-approval',
    });

    const expired = ledger.expireAllPendingForBoot();
    assert.strictEqual(expired.length, 2);
    assert.deepStrictEqual(
      expired.map((e) => e.id).sort(),
      ['req-p1', 'req-p2'],
    );
    for (const entry of expired) {
      assert.strictEqual(entry.state, 'expired');
      assert.strictEqual(entry.resolution!.source, 'boot-recovery');
      assert.strictEqual(entry.resolution!.approver.type, 'system');
    }

    // Persisted state: pending rows gone, settled row untouched.
    assert.strictEqual(store.listBotEscalations({ state: 'pending' }).length, 0);
    assert.strictEqual(ledger.get('req-settled')!.state, 'approved');

    // One sandbox_escape_expired audit row per expired entry (actor system).
    const auditRows = store.listAuditLogs('bot-1').filter((r) => r.eventType === 'sandbox_escape_expired');
    assert.strictEqual(auditRows.length, 2);
    for (const row of auditRows) {
      assert.strictEqual(row.actorType, 'system');
      assert.strictEqual(row.details.source, 'boot-recovery');
      assert.ok(typeof row.details.requestId === 'string');
      assert.ok(row.details.requester);
    }

    // Idempotent: a second boot pass finds nothing pending.
    assert.strictEqual(ledger.expireAllPendingForBoot().length, 0);
  });

  it('never auto-allows during boot recovery (fail-closed)', () => {
    ledger.createPending(pendingInput());
    ledger.expireAllPendingForBoot();
    const entry = ledger.get('req-1')!;
    assert.strictEqual(entry.state, 'expired');
    assert.strictEqual(entry.resolution!.decision, 'expired');
  });

  it('createPending never throws — returns null when the insert fails', () => {
    // No bot row + a requestId conflict surfaces the failure path: seed req-1,
    // then attempt to create it again (PRIMARY KEY conflict).
    assert.ok(ledger.createPending(pendingInput()));
    assert.strictEqual(ledger.createPending(pendingInput()), null);
  });

  // -------------------------------------------------------------------------
  // U11 anti-spam queries (KTD-19)
  // -------------------------------------------------------------------------

  it('findPendingBySignature matches only pending rows with the same generalized signature', () => {
    ledger.createPending(
      pendingInput({
        requestId: 'req-sig-1',
        rulePayload: { toolName: 'Bash', command: 'curl https://a.com/1', dedupeSignature: 'escape(Bash:curl)' },
      }),
    );
    // Variant command, same signature → the pending is found (dedupe hit).
    const hit = ledger.findPendingBySignature('bot-1', 'escape(Bash:curl)');
    assert.ok(hit);
    assert.strictEqual(hit.id, 'req-sig-1');

    // Settled rows no longer dedupe.
    ledger.settle('req-sig-1', 'approved', {
      approver: { type: 'wecom', channelKey: 'wecom', channelUserId: 'owner-1' },
      decision: 'allow',
      source: 'wecom-card',
    });
    assert.strictEqual(ledger.findPendingBySignature('bot-1', 'escape(Bash:curl)'), null);

    // Different signature / different bot → no hit.
    ledger.createPending(
      pendingInput({
        requestId: 'req-sig-2',
        rulePayload: { toolName: 'Bash', command: 'wget https://a.com', dedupeSignature: 'escape(Bash:wget)' },
      }),
    );
    assert.strictEqual(ledger.findPendingBySignature('bot-1', 'escape(Bash:curl)'), null);
    assert.strictEqual(ledger.findPendingBySignature('bot-other', 'escape(Bash:wget)'), null);

    // U8 rows without a signature never dedupe.
    ledger.createPending(pendingInput({ requestId: 'req-sig-3' }));
    assert.strictEqual(ledger.findPendingBySignature('bot-1', 'escape(Bash:git)'), null);
  });

  it('countCreatedSince counts the requester inside the window only', () => {
    const now = Date.parse('2026-08-01T12:00:00Z');
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    // Inside the window, same requester.
    ledger.createPending(pendingInput({ requestId: 'req-w1', now: now - 10 * 60 * 1000 }));
    ledger.createPending(pendingInput({ requestId: 'req-w2', now: now - 20 * 60 * 1000 }));
    // Inside the window, different requester.
    ledger.createPending(
      pendingInput({
        requestId: 'req-w3',
        now: now - 5 * 60 * 1000,
        requester: { channel: 'wecom', channelUserId: 'user-2', role: 'normal' },
      }),
    );
    // Older than the window, same requester.
    ledger.createPending(pendingInput({ requestId: 'req-w4', now: now - 2 * 60 * 60 * 1000 }));

    assert.strictEqual(ledger.countCreatedSince('bot-1', 'owner-1', hourAgo), 2);
    assert.strictEqual(ledger.countCreatedSince('bot-1', 'user-2', hourAgo), 1);
    assert.strictEqual(ledger.countCreatedSince('bot-1', 'nobody', hourAgo), 0);
    // Settled rows still count (the cap bounds request VOLUME, not open cards).
    ledger.settle('req-w1', 'denied', {
      approver: { type: 'system' },
      decision: 'deny',
      source: 'timeout',
    });
    assert.strictEqual(ledger.countCreatedSince('bot-1', 'owner-1', hourAgo), 2);
  });

  it('countPending counts outstanding rows for the bot', () => {
    assert.strictEqual(ledger.countPending('bot-1'), 0);
    ledger.createPending(pendingInput({ requestId: 'req-p1' }));
    ledger.createPending(pendingInput({ requestId: 'req-p2' }));
    assert.strictEqual(ledger.countPending('bot-1'), 2);
    ledger.settle('req-p1', 'denied', {
      approver: { type: 'system' },
      decision: 'deny',
      source: 'timeout',
    });
    assert.strictEqual(ledger.countPending('bot-1'), 1);
    // Other bots' pendings don't count.
    ledger.createPending(pendingInput({ requestId: 'req-p3', botId: 'bot-2' }));
    assert.strictEqual(ledger.countPending('bot-1'), 1);
  });
});
