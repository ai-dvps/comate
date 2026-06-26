import '../test-utils/test-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitWecomMessage } from './wecom-message-split.js';

const MAX = 20480;

/** Strip a trailing ` (n/N)` part indicator so chunks can be rejoined. */
function stripIndicator(chunk: string): string {
  return chunk.replace(/ \(\d+\/\d+\)$/, '');
}

/** Assert every chunk is within the byte limit. */
function assertAllWithinLimit(chunks: string[]): void {
  for (const chunk of chunks) {
    assert.ok(
      Buffer.byteLength(chunk, 'utf8') <= MAX,
      `chunk exceeds limit: ${Buffer.byteLength(chunk, 'utf8')} bytes`,
    );
  }
}

describe('splitWecomMessage', () => {
  it('returns a single chunk under the limit with no indicator', () => {
    const text = 'a'.repeat(1000);
    const chunks = splitWecomMessage(text);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0], text);
    assert.ok(!chunks[0].includes('('));
  });

  it('keeps an exactly-at-limit input as one chunk', () => {
    const text = 'a'.repeat(MAX);
    const chunks = splitWecomMessage(text);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(Buffer.byteLength(chunks[0], 'utf8'), MAX);
  });

  it('splits over-limit ASCII on newlines and tags each chunk', () => {
    const lines: string[] = [];
    let total = 0;
    let i = 0;
    while (total < 30000) {
      const line = `line-${i++}-`.padEnd(80, 'x');
      lines.push(line);
      total += line.length + 1;
    }
    const text = lines.join('\n');
    assert.ok(Buffer.byteLength(text, 'utf8') > MAX);

    const chunks = splitWecomMessage(text);
    assert.ok(chunks.length > 1, 'expected multiple chunks');
    assertAllWithinLimit(chunks);

    // Every chunk carries a part indicator.
    for (const chunk of chunks) {
      assert.match(chunk, / \(\d+\/\d+\)$/);
    }
    // Content is preserved when indicators are stripped and rejoined.
    assert.strictEqual(chunks.map(stripIndicator).join(''), text);
  });

  it('never splits a multibyte UTF-8 (CJK) character', () => {
    const text = '汉'.repeat(8000); // 24000 bytes, 3 bytes/char
    const chunks = splitWecomMessage(text);
    assert.ok(chunks.length > 1);
    assertAllWithinLimit(chunks);
    assert.strictEqual(chunks.map(stripIndicator).join(''), text);
  });

  it('falls back to word boundaries when there are no newlines', () => {
    const words: string[] = [];
    let total = 0;
    while (total < 30000) {
      const w = 'word'.padEnd(12, 'x');
      words.push(w);
      total += w.length + 1;
    }
    const text = words.join(' ');
    assert.ok(!text.includes('\n'));

    const chunks = splitWecomMessage(text);
    assert.ok(chunks.length > 1);
    assertAllWithinLimit(chunks);
    assert.strictEqual(chunks.map(stripIndicator).join(''), text);
  });

  it('splits a single long token at character boundaries', () => {
    const text = 'x'.repeat(50000); // no newline, no space
    const chunks = splitWecomMessage(text);
    assert.ok(chunks.length > 1);
    assertAllWithinLimit(chunks);
    assert.strictEqual(chunks.map(stripIndicator).join(''), text);
  });

  it('reserves margin so the part indicator never pushes a chunk over', () => {
    const text = 'a'.repeat(MAX + 1); // just over -> 2 chunks
    const chunks = splitWecomMessage(text);
    assert.strictEqual(chunks.length, 2);
    assertAllWithinLimit(chunks);
    assert.strictEqual(chunks.map(stripIndicator).join(''), text);
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    assert.deepStrictEqual(splitWecomMessage(''), []);
    assert.deepStrictEqual(splitWecomMessage('   \n\t '), []);
  });
});
