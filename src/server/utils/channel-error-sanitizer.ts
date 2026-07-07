/**
 * Sanitize a channel connection error so it is safe to expose through the API.
 *
 * Redacts:
 * - URLs (including webhook URLs with embedded tokens)
 * - IPv4 / IPv6 addresses
 * - Long alphanumeric tokens that are likely secrets or ciphertext
 * - Stack traces (truncates at the first "    at " frame)
 *
 * The result is intended for UI display only. Full diagnostic details should
 * be logged server-side with `diagLog`.
 */
export function sanitizeChannelError(error: unknown): string {
  if (error === undefined || error === null) {
    return 'Unknown error';
  }

  let message = typeof error === 'string' ? error : String(error);

  // Redact URLs.
  message = message.replace(/https?:\/\/[^\s"<>]+/gi, '<url>');

  // Redact IPv4 addresses.
  message = message.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>');

  // Redact IPv6 addresses (simplified heuristic).
  message = message.replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, '<ip>');

  // Redact long tokens that are likely secrets / ciphertext.
  message = message.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<secret>');

  // Strip stack traces.
  const stackIndex = message.indexOf('\n    at ');
  if (stackIndex >= 0) {
    message = message.slice(0, stackIndex).trim();
  }

  // Cap length to avoid exposing large blobs.
  if (message.length > 240) {
    message = `${message.slice(0, 240)}…`;
  }

  return message || 'Unknown error';
}
