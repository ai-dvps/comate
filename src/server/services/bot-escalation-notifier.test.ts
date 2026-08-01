import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  notifyEscalationPending,
  notifyEscalationResolved,
  subscribeEscalationPending,
  subscribeEscalationResolved,
} from './bot-escalation-notifier.js';
import type { BotEscalationEntry } from '../storage/sqlite-store.js';

function entry(id: string): BotEscalationEntry {
  return {
    id,
    botId: 'bot-1',
    sessionId: 'sess-1',
    audience: 'admins',
    requester: { channel: 'wecom', channelUserId: 'user-1', role: 'normal' },
    recipients: [{ userId: 'owner-1', taskId: id }],
    rulePayload: { toolName: 'Bash', command: 'curl https://a.com/x' },
    state: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    resolvedAt: null,
    resolution: null,
  };
}

describe('bot-escalation-notifier (U11)', () => {
  it('delivers pending and resolved events to subscribers', () => {
    const pendings: string[] = [];
    const resolved: string[] = [];
    const unsubP = subscribeEscalationPending((e) => pendings.push(e.id));
    const unsubR = subscribeEscalationResolved((e) => resolved.push(e.id));
    try {
      notifyEscalationPending(entry('req-1'));
      notifyEscalationResolved(entry('req-1'));
      assert.deepStrictEqual(pendings, ['req-1']);
      assert.deepStrictEqual(resolved, ['req-1']);
    } finally {
      unsubP();
      unsubR();
    }
  });

  it('unsubscribed listeners stop receiving events', () => {
    const seen: string[] = [];
    const unsub = subscribeEscalationPending((e) => seen.push(e.id));
    notifyEscalationPending(entry('req-a'));
    unsub();
    notifyEscalationPending(entry('req-b'));
    assert.deepStrictEqual(seen, ['req-a']);
  });

  it('a throwing listener never breaks the others (fire-and-forget)', () => {
    const seen: string[] = [];
    const unsubBad = subscribeEscalationPending(() => {
      throw new Error('boom');
    });
    const unsubGood = subscribeEscalationPending((e) => seen.push(e.id));
    try {
      assert.doesNotThrow(() => notifyEscalationPending(entry('req-x')));
      assert.deepStrictEqual(seen, ['req-x']);
    } finally {
      unsubBad();
      unsubGood();
    }
  });

  it('an async listener rejection is logged, never propagated', async () => {
    const unsub = subscribeEscalationResolved(() => Promise.reject(new Error('wecom down')));
    try {
      assert.doesNotThrow(() => notifyEscalationResolved(entry('req-y')));
      // Let the rejection settle — nothing should escape.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      unsub();
    }
  });
});
