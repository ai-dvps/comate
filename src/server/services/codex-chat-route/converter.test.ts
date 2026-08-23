import '../../test-utils/test-env.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ConverterError, safeUpstreamError } from './errors.js';
import { prepareRequestHistory } from './history.js';
import {
  derivePromptCacheIdentity,
  transformResponsesRequest,
} from './request-transform.js';
import { transformChatResponse } from './response-transform.js';
import { ChatSseToResponses, SseFrameDecoder } from './sse-transform.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(
  new URL(`./fixtures/${name}`, import.meta.url),
  'utf8',
));

describe('Responses to Chat request conversion', () => {
  it('converts instructions, images, limits, tools, namespaces, effort, and cache identity', () => {
    const result = transformResponsesRequest(fixture('request-basic.json'), {
      providerId: 'provider-kimi',
      credential: 'credential-sentinel',
      sessionId: 'raw-session-id',
      promptCacheRouting: 'auto',
      effortWireMapping: { xhigh: 'max' },
      suppressSamplingParameters: true,
    });

    assert.equal(result.body.model, 'kimi-k2.5');
    assert.equal(result.body.max_completion_tokens, 128);
    assert.equal(result.body.reasoning_effort, 'max');
    assert.equal(result.body.temperature, undefined);
    assert.equal(result.body.top_p, undefined);
    assert.deepStrictEqual(result.body.stream_options, { include_usage: true });
    assert.deepStrictEqual(result.body.messages[0], { role: 'system', content: 'Be concise.' });
    assert.deepStrictEqual(result.body.messages[1], {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: 'https://example.invalid/image.png', detail: 'low' } },
      ],
    });
    const tools = result.body.tools as Array<{ function: { name: string } }>;
    assert.deepStrictEqual(tools.map((tool) => tool.function.name), [
      'weather',
      'calendar__create',
      'apply_patch',
    ]);
    assert.match(result.body.prompt_cache_key, /^pc_[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(JSON.stringify(result.body), /raw-session-id|credential-sentinel/);
    assert.equal(result.toolNames.get('calendar__create')?.namespace, 'calendar');
  });

  it('converts complete tool history without converter-owned state and canonicalizes arguments', () => {
    const input = {
      model: 'model',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'weather' }] },
        { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"b":2,"a":1}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
    };
    const first = transformResponsesRequest(input, baseOptions());
    const afterRestart = transformResponsesRequest(structuredClone(input), baseOptions());
    assert.deepStrictEqual(afterRestart.body.messages, first.body.messages);
    assert.deepStrictEqual(first.body.messages.slice(1), [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"a":1,"b":2}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    ]);
  });

  it('attaches Responses reasoning to the following Chat assistant tool call', () => {
    const transformed = transformResponsesRequest({
      input: [
        { role: 'user', content: 'inspect' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need a tool.' }] },
        { type: 'function_call', call_id: 'call_1', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    }, baseOptions());
    assert.deepStrictEqual(transformed.body.messages[1], {
      role: 'assistant', content: null, reasoning_content: 'Need a tool.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
    });
  });

  it('replays the pinned Codex tool-followup characterization after route or process restart', () => {
    const captured = fixture('codex-0.149-tool-followup.json') as {
      request: Record<string, unknown>;
      observations: { previous_response_id: string };
    };
    const first = transformResponsesRequest(captured.request, baseOptions());
    const regeneratedRoute = transformResponsesRequest(structuredClone(captured.request), {
      ...baseOptions(),
      routeId: 'a-new-route-generation',
    });
    assert.equal(captured.observations.previous_response_id, 'absent');
    assert.deepStrictEqual(regeneratedRoute.body.messages, first.body.messages);
    assert.deepStrictEqual(first.body.messages.slice(-2), [
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'workspace\n' },
    ]);
  });

  it('fails closed on opaque previous_response_id continuity instead of inventing persistent history', () => {
    assert.throws(
      () => prepareRequestHistory({
        previous_response_id: 'resp_earlier',
        input: [{ type: 'function_call_output', call_id: 'call_missing', output: 'done' }],
      }),
      (error: unknown) => error instanceof ConverterError && error.code === 'continuity_state_required',
    );
  });

  it('rejects unsupported media, excessive images, request bytes, and tool arguments', () => {
    assert.throws(
      () => transformResponsesRequest({ input: [{ role: 'user', content: [{ type: 'input_audio', audio_url: 'data:audio/wav;base64,AA==' }] }] }, baseOptions()),
      matchesCode('unsupported_media'),
    );
    assert.throws(
      () => transformResponsesRequest({ input: [{ role: 'user', content: Array.from({ length: 3 }, () => ({ type: 'input_image', image_url: 'https://example.invalid/x' })) }] }, { ...baseOptions(), limits: { maxImages: 2 } }),
      matchesCode('image_limit_exceeded'),
    );
    assert.throws(
      () => transformResponsesRequest({ input: '123456' }, { ...baseOptions(), limits: { maxRequestBytes: 5 } }),
      matchesCode('request_too_large'),
    );
    assert.throws(
      () => transformResponsesRequest({ input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '1234' }] }, { ...baseOptions(), limits: { maxToolArgumentBytes: 3 } }),
      matchesCode('tool_arguments_too_large'),
    );
    assert.throws(
      () => transformResponsesRequest({ input: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }] }, { ...baseOptions(), limits: { maxHistoryItems: 1 } }),
      matchesCode('history_too_large'),
    );
    assert.throws(
      () => transformResponsesRequest({ input: 'search', tools: [{ type: 'web_search' }] }, baseOptions()),
      matchesCode('unsupported_event'),
    );
  });

  it('rotates cache identity with Provider or credential while remaining stable across route regeneration', () => {
    const common = { providerId: 'p1', credential: 'k1', sessionId: 'session-raw' };
    const first = derivePromptCacheIdentity(common);
    assert.equal(first, derivePromptCacheIdentity({ ...common, routeId: 'route-b' }));
    assert.notEqual(first, derivePromptCacheIdentity({ ...common, providerId: 'p2' }));
    assert.notEqual(first, derivePromptCacheIdentity({ ...common, credential: 'k2' }));
    assert.doesNotMatch(first, /p1|k1|session-raw|route-b/);
  });

  it('bounds long namespace tool names and restores namespaced/custom response calls', () => {
    const namespace = 'namespace_'.repeat(8);
    const transformed = transformResponsesRequest({
      input: 'use tools',
      tools: [
        { type: 'namespace', name: namespace, tools: [{ type: 'function', name: 'child', parameters: {} }] },
        { type: 'custom', name: 'apply_patch' },
      ],
    }, baseOptions());
    const tools = transformed.body.tools as Array<{ function: { name: string } }>;
    assert.ok(tools[0].function.name.length <= 64);
    const response = transformChatResponse({
      id: 'tools', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'c1', function: { name: tools[0].function.name, arguments: '{"z":2,"a":1}' } },
        { id: 'c2', function: { name: 'apply_patch', arguments: '{"input":"*** patch ***"}' } },
      ] } }],
    }, { toolNames: transformed.toolNames });
    assert.deepStrictEqual(response.output[0], {
      id: 'fc_c1', type: 'function_call', status: 'completed', call_id: 'c1',
      name: 'child', namespace, arguments: '{"a":1,"z":2}',
    });
    assert.deepStrictEqual(response.output[1], {
      id: 'ctc_c2', type: 'custom_tool_call', status: 'completed', call_id: 'c2',
      name: 'apply_patch', input: '*** patch ***',
    });
  });
});

describe('Chat response conversion', () => {
  it('converts text, think reasoning, tools, and cached usage', () => {
    const response = transformChatResponse(fixture('chat-response.json'));
    assert.equal(response.status, 'completed');
    assert.equal(response.output[0].type, 'reasoning');
    assert.equal(response.output[0].summary[0].text, 'Check the forecast');
    assert.equal(response.output[1].content[0].text, 'It may rain.');
    assert.deepStrictEqual(response.output[2], {
      id: 'fc_call_weather', type: 'function_call', status: 'completed',
      call_id: 'call_weather', name: 'weather', arguments: '{"city":"Shanghai"}',
    });
    assert.deepStrictEqual(response.usage, {
      input_tokens: 20, input_tokens_details: { cached_tokens: 12 },
      output_tokens: 8, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 28,
    });
  });

  it('maps length, content filter, and upstream error responses', () => {
    const incomplete = transformChatResponse({ id: 'c', choices: [{ finish_reason: 'length', message: { content: '' } }] });
    assert.equal(incomplete.status, 'incomplete');
    assert.deepStrictEqual(incomplete.incomplete_details, { reason: 'max_output_tokens' });
    assert.throws(
      () => transformChatResponse({ error: { message: 'bad credential-sentinel', code: 'invalid_api_key' } }),
      (error: unknown) => error instanceof ConverterError
        && error.code === 'upstream_authentication'
        && !error.message.includes('credential-sentinel'),
    );
  });

  it('bounds non-stream response and tool argument bytes', () => {
    assert.throws(
      () => transformChatResponse({ choices: [{ message: { content: '123456' } }] }, { limits: { maxResponseBytes: 5 } }),
      matchesCode('response_too_large'),
    );
    assert.throws(
      () => transformChatResponse({ choices: [{ message: { tool_calls: [
        { id: 'c', function: { name: 'f', arguments: '1234' } },
      ] } }] }, { limits: { maxToolArgumentBytes: 3 } }),
      matchesCode('tool_arguments_too_large'),
    );
  });
});

describe('Chat SSE to Responses conversion', () => {
  it('handles arbitrarily fragmented Unicode, reasoning, text, tools, usage, and DONE', () => {
    const bytes = readFileSync(new URL('./fixtures/chat-stream.sse', import.meta.url));
    const converter = new ChatSseToResponses({ responseId: 'resp_stream' });
    const output: string[] = [];
    for (const byte of bytes) output.push(...converter.push(Uint8Array.of(byte)));
    output.push(...converter.finish());
    const joined = output.join('');
    assert.match(joined, /response\.reasoning_summary_text\.delta/);
    assert.match(joined, /分析/);
    assert.match(joined, /response\.output_text\.delta/);
    assert.match(joined, /你好/);
    assert.match(joined, /response\.function_call_arguments\.done/);
    assert.match(joined, /\{\\"city\\":\\"上海\\"\}/);
    assert.match(joined, /response\.completed/);
    assert.match(joined, /"cached_tokens":3/);
    assert.equal(converter.status().bufferedBytes, 0);
  });

  it('rejects malformed, oversized, and truncated frames without publishing continuity', () => {
    const malformed = new ChatSseToResponses({ responseId: 'r' });
    assert.throws(() => malformed.push(Buffer.from('data: {wat}\n\n')), matchesCode('malformed_sse'));
    assert.equal(malformed.snapshot(), null);

    const oversized = new SseFrameDecoder({ maxFrameBytes: 8 });
    assert.throws(() => oversized.push(Buffer.from('data: 123456789')), matchesCode('sse_frame_too_large'));

    const truncated = new ChatSseToResponses({ responseId: 'r2' });
    truncated.push(Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    assert.throws(() => truncated.finish(), matchesCode('upstream_stream_terminated'));
    assert.equal(truncated.snapshot(), null);
  });

  it('enforces cumulative response and tool argument budgets and clears buffers on cancel', () => {
    const responseLimited = new ChatSseToResponses({ responseId: 'r', limits: { maxResponseBytes: 10 } });
    assert.throws(
      () => responseLimited.push(Buffer.from('data: {"choices":[{"delta":{"content":"this is too long"}}]}\n\n')),
      matchesCode('response_too_large'),
    );
    responseLimited.cancel();
    assert.deepStrictEqual(responseLimited.status(), { bufferedBytes: 0, completed: false, cancelled: true });

    const argsLimited = new ChatSseToResponses({ responseId: 'r', limits: { maxToolArgumentBytes: 3 } });
    assert.throws(
      () => argsLimited.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"1234"}}]}}]}\n\n')),
      matchesCode('tool_arguments_too_large'),
    );

    const unclosedThink = new ChatSseToResponses({ responseId: 'r', limits: { maxResponseBytes: 8 } });
    unclosedThink.push(Buffer.from('data: {"choices":[{"delta":{"content":"<think>"}}]}\n\n'));
    assert.throws(
      () => unclosedThink.push(Buffer.from('data: {"choices":[{"delta":{"content":"12"}}]}\n\n')),
      matchesCode('response_too_large'),
    );
  });

  it('extracts a leading think block even when its tags are fragmented', () => {
    const converter = new ChatSseToResponses({ responseId: 'think' });
    const chunks = ['<thi', 'nk>private', ' thought</th', 'ink>answer'];
    const output = chunks.flatMap((content) => converter.push(Buffer.from(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
    )));
    output.push(...converter.push(Buffer.from(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    )));
    output.push(...converter.push(Buffer.from('data: [DONE]\n\n')));
    converter.finish();
    const joined = output.join('');
    assert.match(joined, /response\.reasoning_summary_text\.delta/);
    assert.match(joined, /private thought/);
    assert.match(joined, /response\.output_text\.delta/);
    assert.match(joined, /answer/);
  });

  it('waits for the usage-only trailer before completing', () => {
    const converter = new ChatSseToResponses({ responseId: 'usage-trailer' });
    const first = converter.push(Buffer.from(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    ));
    assert.doesNotMatch(first.join(''), /response\.completed/);
    const usage = converter.push(Buffer.from(
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n',
    ));
    assert.doesNotMatch(usage.join(''), /response\.completed/);
    const done = converter.push(Buffer.from('data: [DONE]\n\n'));
    assert.match(done.join(''), /response\.completed/);
    const snapshot = converter.snapshot() as { usage: { input_tokens: number } };
    assert.equal(snapshot.usage.input_tokens, 7);
  });

  it('publishes an incomplete snapshot only after DONE', () => {
    const converter = new ChatSseToResponses({ responseId: 'incomplete' });
    converter.push(Buffer.from(
      'data: {"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}\n\n',
    ));
    assert.equal(converter.snapshot(), null);
    converter.push(Buffer.from('data: [DONE]\n\n'));
    assert.deepStrictEqual(converter.snapshot()?.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(converter.snapshot()?.status, 'incomplete');
  });

  it('publishes decoded custom tool input instead of JSON argument fragments', () => {
    const toolNames = new Map([['apply_patch', { name: 'apply_patch', kind: 'custom' as const }]]);
    const converter = new ChatSseToResponses({ responseId: 'custom', toolNames });
    const events = [
      ...converter.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"apply_patch","arguments":"{\\"input\\":\\"*** "}}]}}]}\n\n')),
      ...converter.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"patch ***\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n')),
      ...converter.push(Buffer.from('data: [DONE]\n\n')),
    ].join('');
    assert.equal((events.match(/response\.custom_tool_call_input\.delta/g) ?? []).length, 2);
    assert.match(events, /"delta":"\*\*\* patch \*\*\*"/);
    assert.doesNotMatch(events, /"delta":"\{\\"input/);
  });
});

describe('safe converter errors', () => {
  it('maps upstream categories without leaking headers, URLs, bodies, or credentials', () => {
    const sentinel = 'credential-sentinel';
    for (const error of [
      safeUpstreamError({ status: 401, detail: sentinel }),
      safeUpstreamError({ status: 429, detail: sentinel }),
      safeUpstreamError({ timeout: true, detail: sentinel }),
      safeUpstreamError({ network: true, detail: sentinel }),
      safeUpstreamError({ status: 503, detail: sentinel }),
    ]) {
      assert.doesNotMatch(JSON.stringify(error.toResponsesError()), new RegExp(sentinel));
    }
  });
});

function baseOptions() {
  return { providerId: 'provider', credential: 'secret', sessionId: 'session' };
}

function matchesCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ConverterError && error.code === code;
}
