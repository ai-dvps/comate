import '../test-utils/test-env.js';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { CodexRpcClient, CodexRpcError } from './codex-rpc-client.js';

describe('CodexRpcClient', () => {
  it('multiplexes out-of-order responses and notifications', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new CodexRpcClient(input, output);
    const notifications: unknown[] = [];
    client.on('notification', (value) => notifications.push(value));
    const first = client.request('first');
    const second = client.request('second');
    input.write('{"id":2,"result":"b"}\n{"method":"turn/started","params":{}}\n{"id":1,"result":"a"}\n');
    assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
    assert.equal(notifications.length, 1);
    client.close();
  });

  it('surfaces protocol errors and structured RPC failures', async () => {
    const input = new PassThrough();
    const client = new CodexRpcClient(input, new PassThrough());
    const protocol = new Promise<Error>((resolve) => client.once('protocolError', resolve));
    input.write('not json\n');
    assert.match((await protocol).message, /malformed JSON/);
    const request = client.request('busy');
    input.write('{"id":1,"error":{"code":-32001,"message":"busy"}}\n');
    await assert.rejects(request, (error: CodexRpcError) => error.code === -32001);
    client.close();
  });
});
