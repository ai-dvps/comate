import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFallbackSessionTitle } from './session-title.js';

describe('deriveFallbackSessionTitle', () => {
  it('uses the first meaningful sentence and removes a leading skill invocation', () => {
    assert.equal(
      deriveFallbackSessionTitle('/ce-debug   修复登录后的重定向循环。请检查路由守卫。'),
      '修复登录后的重定向循环',
    );
  });

  it('strips ANSI sequences, timestamps, and log levels from log prompts', () => {
    assert.equal(
      deriveFallbackSessionTitle(
        '\u001B[31m2026-08-15 10:23:12.123 [ERROR] TypeError: Cannot read properties of undefined\u001B[0m\n    at handleLogin (app.ts:4:2)',
      ),
      'TypeError: Cannot read properties of undefined',
    );
  });

  it('prefers prose before a fenced code block', () => {
    assert.equal(
      deriveFallbackSessionTitle('帮我修复这个并发问题：\n\n```ts\nfunction run() {}\n```'),
      '帮我修复这个并发问题',
    );
  });

  it('uses a useful identifier for a code-only prompt', () => {
    assert.equal(
      deriveFallbackSessionTitle('```ts\nimport { x } from "x"\nfunction handleLogin() {\n}\n```'),
      'handleLogin',
    );
  });

  it('recognizes an unfenced source excerpt instead of using its import line', () => {
    assert.equal(
      deriveFallbackSessionTitle('import { x } from "x"\nfunction handleLogin() {\n  return x\n}'),
      'handleLogin',
    );
  });

  it('redacts credentials before placing prompt text in the sidebar', () => {
    const title = deriveFallbackSessionTitle('Bearer super-secret-token 调用接口失败');
    assert.equal(title, 'Bearer [REDACTED] 调用接口失败');
  });

  it('redacts standalone provider tokens and natural-language API keys', () => {
    const cases = [
      'sk-1234567890abcdef',
      'sk-proj-1234567890abcdef',
      'ghp_1234567890abcdefghij',
      'glpat-1234567890abcdef',
      'xoxb-1234567890-abcdef',
      'api key is abcdefghijklmnop',
    ];

    for (const secret of cases) {
      const title = deriveFallbackSessionTitle(`请求失败 ${secret} 请帮忙排查`);
      assert.ok(title.includes('[REDACTED]'), `${secret} should be redacted`);
      assert.ok(!title.includes(secret), `${secret} should not survive in the title`);
    }
  });

  it('does not redact ordinary short words and placeholders', () => {
    assert.equal(
      deriveFallbackSessionTitle('sketch sk-test api key is missing'),
      'sketch sk-test api key is missing',
    );
  });

  it('truncates by display width without splitting full-width characters', () => {
    const title = deriveFallbackSessionTitle('这是一个非常非常非常非常非常非常非常非常非常非常非常非常长的会话标题');
    assert.ok(title.endsWith('…'));
    assert.ok(title.length < 35);
  });

  it('falls back to a humanized command or New chat when no content remains', () => {
    assert.equal(deriveFallbackSessionTitle('/ce-debug'), 'Ce debug');
    assert.equal(deriveFallbackSessionTitle('   '), 'New chat');
  });
});
