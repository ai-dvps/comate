import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMcpTool,
  parseMcpToolName,
  sanitizeMcpClassificationOverrides,
} from './mcp-tool-classification.js';

describe('parseMcpToolName', () => {
  it('parses the mcp__<server>__<tool> convention', () => {
    assert.deepStrictEqual(parseMcpToolName('mcp__docs__search'), { server: 'docs', tool: 'search' });
  });

  it('keeps double-underscore tool suffixes with the tool segment', () => {
    assert.deepStrictEqual(parseMcpToolName('mcp__docs__admin__purge'), {
      server: 'docs',
      tool: 'admin__purge',
    });
  });

  it('splits single-underscore server names at the first double underscore', () => {
    assert.deepStrictEqual(parseMcpToolName('mcp__my_server__search'), {
      server: 'my_server',
      tool: 'search',
    });
  });

  it('known server names disambiguate by longest match', () => {
    assert.deepStrictEqual(
      parseMcpToolName('mcp__my__server__tool', ['my', 'my__server']),
      { server: 'my__server', tool: 'tool' },
    );
    // Without the known server, the first-__ split wins.
    assert.deepStrictEqual(parseMcpToolName('mcp__my__server__tool'), {
      server: 'my',
      tool: 'server__tool',
    });
  });

  it('rejects non-MCP names and malformed MCP names', () => {
    for (const name of [
      'Bash',
      'Read',
      'Skill',
      'mcp__',
      'mcp__docs',
      'mcp__docs__',
      'mcp____search',
      'mcp_docs__search',
      '',
    ]) {
      assert.strictEqual(parseMcpToolName(name), null, `${name} must not parse`);
    }
  });
});

describe('classifyMcpTool (U9, KTD-20)', () => {
  it('readOnlyHint honored first: readOnly:true classifies read', () => {
    assert.strictEqual(
      classifyMcpTool({ tool: 'search', annotations: { readOnly: true } }),
      'read',
    );
  });

  it('destructiveHint true classifies write', () => {
    assert.strictEqual(
      classifyMcpTool({ tool: 'purge', annotations: { destructive: true } }),
      'write',
    );
  });

  it('contradictory annotations (readOnly:true + destructive:true) fail toward write', () => {
    assert.strictEqual(
      classifyMcpTool({ tool: 'purge', annotations: { readOnly: true, destructive: true } }),
      'write',
    );
  });

  it('readOnly:false means the tool may modify its environment → write', () => {
    assert.strictEqual(
      classifyMcpTool({ tool: 'update', annotations: { readOnly: false } }),
      'write',
    );
  });

  it('no annotations → unknown (fail-closed, never allow-all per R10)', () => {
    assert.strictEqual(classifyMcpTool({ tool: 'mystery' }), 'unknown');
    assert.strictEqual(classifyMcpTool({ tool: 'mystery', annotations: {} }), 'unknown');
    assert.strictEqual(
      classifyMcpTool({ tool: 'mystery', annotations: { readOnly: undefined } }),
      'unknown',
    );
  });

  it('per-server default override wins over annotations', () => {
    assert.strictEqual(
      classifyMcpTool({
        tool: 'search',
        annotations: { readOnly: true },
        override: { default: 'write' },
      }),
      'write',
    );
    assert.strictEqual(
      classifyMcpTool({
        tool: 'purge',
        annotations: { destructive: true },
        override: { default: 'read' },
      }),
      'read',
    );
  });

  it('per-tool override wins over the server default AND annotations', () => {
    assert.strictEqual(
      classifyMcpTool({
        tool: 'search',
        annotations: { readOnly: true },
        override: { default: 'read', tools: { search: 'write' } },
      }),
      'write',
    );
  });

  it('override still resolves unknown tools when annotations are absent', () => {
    assert.strictEqual(
      classifyMcpTool({ tool: 'anything', override: { default: 'read' } }),
      'read',
    );
    assert.strictEqual(
      classifyMcpTool({ tool: 'anything', override: { tools: { other: 'read' } } }),
      'unknown',
    );
  });
});

describe('sanitizeMcpClassificationOverrides (fail-closed read path)', () => {
  it('passes a well-formed override map through', () => {
    const out = sanitizeMcpClassificationOverrides({
      docs: { default: 'read', tools: { purge: 'write' } },
      files: { tools: { upload: 'write' } },
    });
    assert.deepStrictEqual(out, {
      docs: { default: 'read', tools: { purge: 'write' } },
      files: { tools: { upload: 'write' } },
    });
  });

  it('drops invalid entries and invalid class values', () => {
    const out = sanitizeMcpClassificationOverrides({
      ok: { default: 'read' },
      'bad-class': { default: 'unknown' },
      'bad-tools': { tools: { a: 'allow', b: 'read' } },
      'not-an-object': 'read',
      'empty-tools': { tools: 'nope' },
    });
    assert.deepStrictEqual(out, {
      ok: { default: 'read' },
      'bad-tools': { tools: { b: 'read' } },
    });
  });

  it('non-object input and all-invalid maps collapse to undefined (absent)', () => {
    assert.strictEqual(sanitizeMcpClassificationOverrides(undefined), undefined);
    assert.strictEqual(sanitizeMcpClassificationOverrides(null), undefined);
    assert.strictEqual(sanitizeMcpClassificationOverrides('read'), undefined);
    assert.strictEqual(sanitizeMcpClassificationOverrides([]), undefined);
    assert.strictEqual(sanitizeMcpClassificationOverrides({}), undefined);
    assert.strictEqual(
      sanitizeMcpClassificationOverrides({ bad: { default: 'unknown' } }),
      undefined,
    );
  });

  it('never stores an unknown class — overrides can only widen to read/write explicitly', () => {
    const out = sanitizeMcpClassificationOverrides({ docs: { default: 'read', tools: {} } });
    assert.deepStrictEqual(out, { docs: { default: 'read' } });
  });
});
