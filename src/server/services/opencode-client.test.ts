import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpencodeServeArgs,
  buildOpencodeServeEnv,
  OPENCODE_LISTENING_RE,
  SseParser,
  mapOpencodePart,
  type OpencodePart,
} from './opencode-client.js';

describe('buildOpencodeServeArgs', () => {
  it('defaults to loopback with random port', () => {
    assert.deepEqual(buildOpencodeServeArgs({}), [
      'serve',
      '--hostname=127.0.0.1',
      '--port=0',
    ]);
  });

  it('honors explicit host and port', () => {
    assert.deepEqual(buildOpencodeServeArgs({ hostname: '0.0.0.0', port: 4096 }), [
      'serve',
      '--hostname=0.0.0.0',
      '--port=4096',
    ]);
  });
});

describe('buildOpencodeServeEnv', () => {
  it('serializes config into OPENCODE_CONFIG_CONTENT', () => {
    const env = buildOpencodeServeEnv({ config: { permission: { edit: 'ask' } } });
    assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify({ permission: { edit: 'ask' } }));
  });

  it('merges caller env over process.env', () => {
    const env = buildOpencodeServeEnv({ env: { XDG_DATA_HOME: '/tmp/x' } });
    assert.equal(env.XDG_DATA_HOME, '/tmp/x');
    assert.equal(env.OPENCODE_CONFIG_CONTENT, '{}');
  });
});

describe('OPENCODE_LISTENING_RE', () => {
  it('extracts the URL from the readiness line', () => {
    const match = 'opencode server listening on http://127.0.0.1:4096'.match(
      OPENCODE_LISTENING_RE,
    );
    assert.equal(match?.[1], 'http://127.0.0.1:4096');
  });
});

describe('SseParser', () => {
  it('parses a single complete frame', () => {
    const parser = new SseParser();
    const events = parser.feed(
      'data: {"type":"session.idle","properties":{"sessionID":"s1"}}\n\n',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session.idle');
    assert.equal(events[0].properties.sessionID, 's1');
  });

  it('reassembles a frame split across chunks', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.feed('data: {"type":"message.part.upd'), []);
    const events = parser.feed('ated","properties":{"x":1}}\n\n');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'message.part.updated');
  });

  it('parses multiple frames in one chunk and ignores comments', () => {
    const parser = new SseParser();
    const events = parser.feed(
      ': keepalive\n\n' +
        'data: {"type":"a","properties":{}}\n\n' +
        'data: {"type":"b","properties":{}}\n\n',
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ['a', 'b'],
    );
  });

  it('drops unparseable frames without throwing', () => {
    const parser = new SseParser();
    const events = parser.feed('data: {not json}\n\ndata: {"type":"ok","properties":{}}\n\n');
    assert.deepEqual(
      events.map((e) => e.type),
      ['ok'],
    );
  });
});

describe('mapOpencodePart', () => {
  it('maps text parts', () => {
    const part: OpencodePart = { id: 'p1', type: 'text', text: 'hello' };
    assert.deepEqual(mapOpencodePart(part), [{ type: 'text', text: 'hello' }]);
  });

  it('maps reasoning parts to thinking', () => {
    const part: OpencodePart = { id: 'p2', type: 'reasoning', text: 'hmm' };
    assert.deepEqual(mapOpencodePart(part), [
      { type: 'thinking', text: 'hmm', state: 'complete' },
    ]);
  });

  it('maps a running tool part to a streaming tool_use', () => {
    const part: OpencodePart = {
      id: 'p3',
      type: 'tool',
      callID: 'call-1',
      tool: 'write',
      state: { status: 'running', input: { filePath: '/tmp/a' } },
    };
    assert.deepEqual(mapOpencodePart(part), [
      {
        type: 'tool_use',
        toolUseId: 'call-1',
        toolName: 'write',
        input: { filePath: '/tmp/a' },
        state: 'streaming',
      },
    ]);
  });

  it('maps a completed tool part to tool_use + tool_result', () => {
    const part: OpencodePart = {
      id: 'p4',
      type: 'tool',
      callID: 'call-2',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt' },
    };
    assert.deepEqual(mapOpencodePart(part), [
      {
        type: 'tool_use',
        toolUseId: 'call-2',
        toolName: 'bash',
        input: { command: 'ls' },
        state: 'complete',
      },
      { type: 'tool_result', toolUseId: 'call-2', output: 'file.txt', isError: false },
    ]);
  });

  it('maps an errored tool part to an isError tool_result', () => {
    const part: OpencodePart = {
      id: 'p5',
      type: 'tool',
      callID: 'call-3',
      tool: 'read',
      state: { status: 'error', input: { filePath: '/nope' }, error: 'ENOENT' },
    };
    const mapped = mapOpencodePart(part);
    assert.equal(mapped.length, 2);
    assert.deepEqual(mapped[1], {
      type: 'tool_result',
      toolUseId: 'call-3',
      output: 'ENOENT',
      isError: true,
    });
  });

  it('flags subtask parts as unmapped with a pointer to child sessions', () => {
    const part: OpencodePart = { id: 'p6', type: 'subtask', prompt: 'x' };
    const [mapped] = mapOpencodePart(part);
    assert.equal(mapped.type, 'unmapped');
    assert.equal(mapped.type === 'unmapped' ? mapped.partType : '', 'subtask');
  });

  it('flags unknown part types as fidelity gaps', () => {
    const part: OpencodePart = { id: 'p7', type: 'brand-new-part' };
    const [mapped] = mapOpencodePart(part);
    assert.equal(mapped.type, 'unmapped');
  });
});
