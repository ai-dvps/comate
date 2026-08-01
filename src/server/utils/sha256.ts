import { createHash } from 'node:crypto';

/** Lowercase hex SHA-256 digest of a string (token hashes, integrity siblings). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
