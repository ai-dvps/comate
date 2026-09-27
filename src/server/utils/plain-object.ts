/**
 * Narrow to a non-array plain object. Shared by read-path sanitizers that
 * accept untyped stored blobs.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
