import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { transformResponsesRequest } from '../src/server/services/codex-chat-route/request-transform.js';
import { resolveCodexBinary } from '../src/server/utils/resolve-codex-binary.js';
import { normalizeCodexProtocolImports } from './lib/codex-protocol.js';

function snapshot(root: string, current = root): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of snapshot(root, absolute)) files.set(name, content);
    } else if (entry.isFile()) {
      files.set(path.relative(root, absolute), readFileSync(absolute));
    }
  }
  return files;
}

describe('Codex protocol generation', () => {
  it('matches the exact pinned binary', () => {
    const binary = resolveCodexBinary();
    assert.ok(binary, 'pinned Codex binary missing');
    const generated = mkdtempSync(path.join(tmpdir(), 'comate-codex-protocol-'));
    execFileSync(binary, ['app-server', 'generate-ts', '--out', generated]);
    normalizeCodexProtocolImports(generated);
    const checkedIn = path.resolve('src/server/generated/codex-protocol');
    const actual = snapshot(generated);
    const expected = snapshot(checkedIn);
    assert.deepEqual([...actual.keys()], [...expected.keys()]);
    for (const [name, content] of actual) assert.deepEqual(content, expected.get(name), name);
  });

  it('keeps the routed Chat characterization inside the pinned Codex item contract', () => {
    const fixturePath = path.resolve(
      'src/server/services/codex-chat-route/fixtures/codex-0.149-tool-followup.json',
    );
    const fixtureText = readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(fixtureText) as {
      characterizedWith: string;
      request: Record<string, unknown>;
      observations: { previous_response_id: string };
    };
    assert.equal(fixture.characterizedWith, '@openai/codex 0.149.0 app-server');
    assert.equal(fixture.observations.previous_response_id, 'absent');
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(
      packageJson.dependencies['@openai/codex'],
      '0.149.0',
      'update the routed Chat characterization before changing the pinned Codex runtime',
    );

    const responseItem = readFileSync(
      path.resolve('src/server/generated/codex-protocol/ResponseItem.ts'),
      'utf8',
    );
    const contentItem = readFileSync(
      path.resolve('src/server/generated/codex-protocol/ContentItem.ts'),
      'utf8',
    );
    for (const itemType of ['function_call', 'function_call_output']) {
      assert.match(responseItem, new RegExp(`"${itemType}"`));
    }
    assert.match(contentItem, /"input_text"/);

    const converted = transformResponsesRequest(fixture.request, {
      providerId: 'provider-fixture',
      credential: 'credential-sentinel',
      sessionId: 'raw-session-sentinel',
      promptCacheRouting: 'auto',
    });
    assert.deepStrictEqual(
      converted.body.messages.slice(-2).map((message) => message.role),
      ['assistant', 'tool'],
    );
    const serialized = JSON.stringify(converted.body);
    assert.doesNotMatch(serialized, /credential-sentinel|raw-session-sentinel|authorization/i);
  });
});
