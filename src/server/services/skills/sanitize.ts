/**
 * Sanitize untrusted strings before terminal output.
 *
 * Ported from `src/server/vendor/vercel-skills/src/sanitize.ts` verbatim.
 * Lives in the adapter because upstream uses `.ts` extension imports
 * and we need it as a building block for `search.ts` and `skills-discovery.ts`.
 *
 * Strips ALL terminal escape sequences from a string, including:
 *   - CSI sequences  (ESC [ ... final_byte)    — cursor movement, screen clear, SGR colors
 *   - OSC sequences  (ESC ] ... BEL/ST)         — window title, hyperlinks
 *   - Simple escapes (ESC followed by one char)  — e.g. ESC 7 (save cursor)
 *   - C1 control codes (0x80–0x9F)
 *   - Raw control characters (BEL, BS, etc.)     — except \t and \n which are safe
 */

// CSI sequences: ESC[ followed by parameter bytes (0x30-0x3F), intermediate bytes (0x20-0x2F), and a final byte (0x40-0x7E)
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

// OSC sequences: ESC] ... terminated by BEL (\x07) or ST (ESC\)
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

// DCS, PM, APC sequences: ESC P|^|_ ... terminated by ST (ESC\)
// eslint-disable-next-line no-control-regex
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;

// Simple two-byte escape sequences: ESC followed by a single char in 0x20-0x7E range
// Includes ESC 7 (DECSC), ESC 8 (DECRC), ESC c (RIS), ESC M (RI), etc.
// eslint-disable-next-line no-control-regex
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;

// C1 control codes (0x80–0x9F) — used as 8-bit equivalents of ESC sequences
const C1_RE = /[\x80-\x9f]/g;

// Raw control characters except tab (\x09) and newline (\x0a)
// Includes BEL (\x07), BS (\x08), CR (\x0d), and others
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x06\x07\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]/g;

/**
 * Strip all terminal escape sequences and dangerous control characters
 * from a string.
 *
 * Safe for use on untrusted input before printing to the terminal.
 */
export function stripTerminalEscapes(str: string): string {
  return str
    .replace(OSC_RE, '') // OSC first (longest match)
    .replace(DCS_PM_APC_RE, '') // DCS/PM/APC
    .replace(CSI_RE, '') // CSI sequences
    .replace(SIMPLE_ESC_RE, '') // Simple ESC+char
    .replace(C1_RE, '') // C1 control codes
    .replace(CONTROL_RE, ''); // Raw control chars (keep \t \n)
}

/**
 * Sanitize a skill metadata string (name, description, etc.) for safe display.
 *
 * In addition to stripping escape sequences, this also trims whitespace and
 * collapses internal newlines into spaces (skill names/descriptions should
 * be single-line when displayed).
 */
export function sanitizeMetadata(str: string): string {
  return stripTerminalEscapes(str)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}
