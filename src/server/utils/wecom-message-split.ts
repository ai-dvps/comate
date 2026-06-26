/**
 * Split a string into chunks each at or under a UTF-8 byte limit.
 *
 * WeCom caps a single markdown message at 20480 UTF-8 bytes. When a bot reply
 * exceeds that, it must be delivered as multiple sequential messages. This
 * utility performs the split without ever breaking inside a UTF-8 multi-byte
 * sequence, preferring line boundaries, then word boundaries, then character
 * boundaries. When more than one chunk results, each is suffixed with a
 * ` (n/N)` part indicator.
 *
 * Returns an empty array for empty or whitespace-only input so callers can
 * skip sending an empty message.
 */

const DEFAULT_MAX_BYTES = 20480;

/**
 * Bytes reserved on each chunk for the ` (n/N)` part indicator. The widest
 * realistic indicator (` (999/999)`) is 9 ASCII bytes; 16 gives headroom for
 * larger part counts without risking an overflow.
 */
const INDICATOR_MARGIN = 16;

/**
 * UTF-8 byte length of the UTF-16 code point starting at `index` in `text`.
 * Advances past surrogate pairs.
 */
function codePointByteLength(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) return 0;
  return Buffer.byteLength(String.fromCodePoint(codePoint), 'utf8');
}

/**
 * Number of UTF-16 code units consumed by the code point at `index`.
 */
function codePointStep(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) return 1;
  return codePoint > 0xffff ? 2 : 1;
}

/**
 * Find the largest end index `> pos` such that `text.slice(pos, end)` is at or
 * under `target` bytes, advancing by whole code points (never mid-character).
 * Always advances at least one code point so progress is guaranteed.
 */
function findByteBoundedEnd(text: string, pos: number, target: number): number {
  let end = pos;
  let bytes = 0;
  while (end < text.length) {
    const step = codePointStep(text, end);
    const charBytes = codePointByteLength(text, end);
    if (bytes + charBytes > target) break;
    bytes += charBytes;
    end += step;
  }
  // Guarantee forward progress: if the very first code point exceeds the
  // target (only possible when target < 4), include it anyway.
  if (end === pos) {
    end = pos + codePointStep(text, pos);
  }
  return end;
}

/**
 * Pull the preferred split boundary back to a newline, then a space, so chunks
 * break on readable seams whenever possible. Falls back to the character
 * boundary at `end` when neither is present in the window.
 */
function preferredBoundary(text: string, pos: number, end: number): number {
  for (let k = end - 1; k > pos; k--) {
    if (text[k] === '\n') return k + 1;
  }
  for (let k = end - 1; k > pos; k--) {
    if (text[k] === ' ') return k + 1;
  }
  return end;
}

function chunkByBytes(text: string, target: number): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = findByteBoundedEnd(text, pos, target);
    if (end >= text.length) {
      chunks.push(text.slice(pos));
      break;
    }
    const boundary = preferredBoundary(text, pos, end);
    chunks.push(text.slice(pos, boundary));
    pos = boundary;
  }
  return chunks;
}

export function splitWecomMessage(text: string, maxBytes: number = DEFAULT_MAX_BYTES): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Common case: the whole text fits in one message, no indicator needed.
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return [text];
  }

  // Reserve room for the part indicator on each chunk.
  const target = Math.max(1, maxBytes - INDICATOR_MARGIN);
  const rawChunks = chunkByBytes(text, target);
  const total = rawChunks.length;

  return rawChunks.map((chunk, index) => `${chunk} (${index + 1}/${total})`);
}
