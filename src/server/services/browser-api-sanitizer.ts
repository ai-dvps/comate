import type {
  DisclosureReceipt,
  SanitizedDisclosure,
} from '@comate/api-contracts';

export interface SanitizerLimits {
  maxDepth: number;
  maxMembers: number;
  maxStringLength: number;
  maxDecodedBytes: number;
}

export interface SanitizerOptions {
  exactSecrets?: readonly string[];
  limits?: Partial<SanitizerLimits>;
}

export interface SanitizeBodyInput extends SanitizerOptions {
  contentType?: string;
  body: string | Buffer;
}

export interface Redaction {
  path: string;
  reason: 'credential_field' | 'exact_secret' | 'token_pattern' | 'auth_header' | 'transport_header';
}

export interface SanitizedHeaders {
  value: Record<string, string>;
  receipt: Pick<DisclosureReceipt, 'redactions'>;
}

export interface SanitizedUrl {
  value: string;
  query: Array<{ name: string; value: string }>;
  receipt: Pick<DisclosureReceipt, 'redactions'>;
}

const DEFAULT_LIMITS: SanitizerLimits = {
  maxDepth: 8,
  maxMembers: 256,
  maxStringLength: 4_096,
  maxDecodedBytes: 64 * 1_024,
};

const CREDENTIAL_KEY = /(?:^|[_-])(?:access[_-]?token|auth(?:orization)?|bearer|cookie|csrf|xsrf|password|passwd|secret|session|api[_-]?key|client[_-]?secret|refresh[_-]?token|private[_-]?key)(?:$|[_-])/i;
const TRANSPORT_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);
const AUTH_HEADERS = new Set(['authorization', 'cookie', 'proxy-authenticate', 'set-cookie', 'www-authenticate']);
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = new RegExp('\\b(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/-]+=*', 'gi');
const LONG_TOKEN_PATTERN = /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g;

class StructureLimitError extends Error {}

interface WalkState {
  readonly limits: SanitizerLimits;
  readonly secrets: readonly string[];
  readonly redactions: Redaction[];
  members: number;
  truncated: boolean;
}

function limitsFor(partial?: Partial<SanitizerLimits>): SanitizerLimits {
  const merged = { ...DEFAULT_LIMITS, ...partial };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }
  return merged;
}

function secretsFor(values?: readonly string[]): readonly string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))]
    .sort((a, b) => b.length - a.length);
}

function redactString(
  input: string,
  path: string,
  state: WalkState,
): { value: string; sensitive: boolean } {
  let value = input;
  let sensitive = false;
  for (const secret of state.secrets) {
    if (!value.includes(secret)) continue;
    value = value.split(secret).join('<redacted:secret>');
    state.redactions.push({ path, reason: 'exact_secret' });
    sensitive = true;
  }
  const redactPattern = (pattern: RegExp): void => {
    pattern.lastIndex = 0;
    if (!pattern.test(value)) return;
    pattern.lastIndex = 0;
    value = value.replace(pattern, '<redacted:token>');
    state.redactions.push({ path, reason: 'token_pattern' });
    sensitive = true;
  };
  redactPattern(BEARER_PATTERN);
  redactPattern(JWT_PATTERN);
  redactPattern(LONG_TOKEN_PATTERN);
  return { value, sensitive };
}

function redactValue(value: unknown, path: string, depth: number, state: WalkState): unknown {
  if (depth > state.limits.maxDepth) throw new StructureLimitError('depth');
  state.members += 1;
  if (state.members > state.limits.maxMembers) throw new StructureLimitError('members');

  if (typeof value === 'string') {
    let redacted = redactString(value, path, state).value;
    if (redacted.length > state.limits.maxStringLength) {
      redacted = redacted.slice(0, state.limits.maxStringLength);
      state.truncated = true;
    }
    return redacted;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((member, index) => redactValue(member, `${path}[${index}]`, depth + 1, state));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      const memberPath = `${path}.${key}`;
      state.members += 1;
      if (state.members > state.limits.maxMembers) throw new StructureLimitError('members');
      if (CREDENTIAL_KEY.test(key)) {
        output[key] = '<redacted:secret>';
        state.redactions.push({ path: memberPath, reason: 'credential_field' });
      } else {
        output[key] = redactValue(member, memberPath, depth + 1, state);
      }
    }
    return output;
  }
  // Undefined, bigint, functions, symbols, and exotic values never cross the boundary.
  return '<redacted:unsupported-value>';
}

function receipt(
  disclosureClass: DisclosureReceipt['class'],
  originalBytes: number,
  redactions: Redaction[],
  options: {
    disclosed: boolean;
    disclosedBytes?: number;
    truncated?: boolean;
    withheldReason?: DisclosureReceipt['withheldReason'];
  },
): DisclosureReceipt {
  return {
    class: disclosureClass,
    disclosed: options.disclosed,
    ...(options.withheldReason ? { withheldReason: options.withheldReason } : {}),
    redactions,
    originalBytes,
    disclosedBytes: options.disclosedBytes ?? 0,
    truncated: options.truncated ?? false,
  };
}

function withheld(
  disclosureClass: DisclosureReceipt['class'],
  mediaType: string | undefined,
  encoding: string | undefined,
  originalBytes: number,
  reason: NonNullable<DisclosureReceipt['withheldReason']>,
  redactions: Redaction[] = [],
): SanitizedDisclosure {
  return {
    class: disclosureClass,
    ...(mediaType ? { mediaType } : {}),
    ...(encoding ? { encoding } : {}),
    receipt: receipt(disclosureClass, originalBytes, redactions, {
      disclosed: false,
      withheldReason: reason,
    }),
  };
}

function parseContentType(raw?: string): { mediaType?: string; encoding?: string } {
  if (!raw) return {};
  const [type, ...parameters] = raw.split(';');
  const mediaType = type?.trim().toLowerCase() || undefined;
  let encoding: string | undefined;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*["']?([^"';\s]+)["']?\s*$/i.exec(parameter);
    if (match) encoding = match[1].toLowerCase();
  }
  return { mediaType, encoding };
}

function decodeBody(body: string | Buffer, encoding: string | undefined): string | undefined {
  const normalized = encoding ?? 'utf-8';
  if (!['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(normalized)) return undefined;
  if (typeof body === 'string') return body;
  try {
    return new TextDecoder(normalized.startsWith('ascii') || normalized === 'us-ascii' ? 'ascii' : 'utf-8', {
      fatal: true,
    }).decode(body);
  } catch {
    return undefined;
  }
}

function bodyBytes(body: string | Buffer): number {
  return typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
}

/** Sanitize caller-visible headers; unsafe transport headers are removed, not replayable. */
export function sanitizeHeaders(
  headers: Record<string, string | readonly string[] | undefined>,
  options: SanitizerOptions = {},
): SanitizedHeaders {
  const redactions: Redaction[] = [];
  const state: WalkState = {
    limits: limitsFor(options.limits),
    secrets: secretsFor(options.exactSecrets),
    redactions,
    members: 0,
    truncated: false,
  };
  const value: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    if (TRANSPORT_HEADERS.has(name)) {
      redactions.push({ path: `headers.${name}`, reason: 'transport_header' });
      continue;
    }
    if (AUTH_HEADERS.has(name)) {
      value[name] = `<auth:${name === 'set-cookie' ? 'cookie' : name}>`;
      redactions.push({ path: `headers.${name}`, reason: 'auth_header' });
      continue;
    }
    if (CREDENTIAL_KEY.test(name)) {
      value[name] = '<redacted:secret>';
      redactions.push({ path: `headers.${name}`, reason: 'credential_field' });
      continue;
    }
    const joined = typeof rawValue === 'string' ? rawValue : rawValue.join(', ');
    value[name] = redactString(joined, `headers.${name}`, state).value.slice(0, state.limits.maxStringLength);
  }
  return { value, receipt: { redactions } };
}

/** Parse and reconstruct a URL so raw query text is never retained in the result. */
export function sanitizeUrl(rawUrl: string, options: SanitizerOptions = {}): SanitizedUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Do not retain the raw value on the error object: it may itself carry a secret.
    throw new TypeError('URL could not be sanitized');
  }
  url.username = '';
  url.password = '';
  const redactions: Redaction[] = [];
  const state: WalkState = {
    limits: limitsFor(options.limits),
    secrets: secretsFor(options.exactSecrets),
    redactions,
    members: 0,
    truncated: false,
  };
  const query: Array<{ name: string; value: string }> = [];
  const sanitized = new URLSearchParams();
  for (const [name, rawValue] of url.searchParams) {
    const path = `query.${name}`;
    let value: string;
    if (CREDENTIAL_KEY.test(name)) {
      value = '<redacted:secret>';
      redactions.push({ path, reason: 'credential_field' });
    } else {
      value = redactString(rawValue, path, state).value;
    }
    value = value.slice(0, state.limits.maxStringLength);
    sanitized.append(name.slice(0, 512), value);
    query.push({ name: name.slice(0, 512), value });
    if (query.length >= state.limits.maxMembers) break;
  }
  url.search = sanitized.toString();
  url.hash = '';
  return { value: url.toString(), query, receipt: { redactions } };
}

/**
 * Convert an untrusted body to a bounded positive shape. Unsupported or ambiguous
 * content returns metadata only; callers never receive a raw fallback.
 */
export function sanitizeBody(input: SanitizeBodyInput): SanitizedDisclosure {
  const limits = limitsFor(input.limits);
  const { mediaType, encoding } = parseContentType(input.contentType);
  const originalBytes = bodyBytes(input.body);
  if (originalBytes > limits.maxDecodedBytes) {
    return withheld('truncated', mediaType, encoding, originalBytes, 'decoded_size_exceeded');
  }
  if (mediaType?.startsWith('multipart/')) {
    return withheld('multipart', mediaType, encoding, originalBytes, 'multipart_content');
  }
  if (mediaType && (mediaType.startsWith('image/') || mediaType.startsWith('audio/') || mediaType.startsWith('video/') || mediaType === 'application/octet-stream')) {
    return withheld('binary', mediaType, encoding, originalBytes, 'binary_content');
  }
  const supportedEncoding = !encoding || ['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(encoding);
  if (!supportedEncoding) {
    return withheld('invalid_encoding', mediaType, encoding, originalBytes, 'unsupported_encoding');
  }
  const decoded = decodeBody(input.body, encoding);
  if (decoded === undefined) {
    return withheld('invalid_encoding', mediaType, encoding, originalBytes, 'unsupported_encoding');
  }

  const isJson = mediaType === 'application/json' || mediaType?.endsWith('+json');
  const isForm = mediaType === 'application/x-www-form-urlencoded';
  const isText = mediaType?.startsWith('text/') ?? false;
  if (!isJson && !isForm && !isText) {
    return withheld('unknown', mediaType, encoding, originalBytes, 'unsupported_content_type');
  }

  const redactions: Redaction[] = [];
  const state: WalkState = {
    limits,
    secrets: secretsFor(input.exactSecrets),
    redactions,
    members: 0,
    truncated: false,
  };
  try {
    if (isJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded);
      } catch {
        return withheld('json', mediaType, encoding, originalBytes, 'invalid_content');
      }
      const isGraphql = typeof parsed === 'object' && parsed !== null
        && typeof (parsed as Record<string, unknown>).query === 'string';
      const disclosureClass = isGraphql ? 'graphql' : 'json';
      const value = redactValue(parsed, '$', 0, state) as NonNullable<SanitizedDisclosure['value']>;
      const disclosedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      return {
        class: disclosureClass,
        ...(mediaType ? { mediaType } : {}),
        encoding: encoding ?? 'utf-8',
        value,
        receipt: receipt(disclosureClass, originalBytes, redactions, {
          disclosed: true,
          disclosedBytes,
          truncated: state.truncated,
        }),
      };
    }

    if (isForm) {
      const value: Record<string, string | string[]> = {};
      for (const [key, rawValue] of new URLSearchParams(decoded)) {
        state.members += 1;
        if (state.members > limits.maxMembers) throw new StructureLimitError('members');
        const path = `$.${key}`;
        const sanitized = CREDENTIAL_KEY.test(key)
          ? '<redacted:secret>'
          : redactString(rawValue, path, state).value.slice(0, limits.maxStringLength);
        if (CREDENTIAL_KEY.test(key)) redactions.push({ path, reason: 'credential_field' });
        const prior = value[key];
        value[key] = prior === undefined ? sanitized : Array.isArray(prior) ? [...prior, sanitized] : [prior, sanitized];
      }
      const disclosedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      return {
        class: 'form',
        mediaType,
        encoding: encoding ?? 'utf-8',
        value,
        receipt: receipt('form', originalBytes, redactions, { disclosed: true, disclosedBytes }),
      };
    }

    const textResult = redactString(decoded, '$', state);
    if (textResult.sensitive) {
      return withheld('text', mediaType, encoding, originalBytes, 'ambiguous_sensitive_text', redactions);
    }
    const truncated = textResult.value.length > limits.maxStringLength;
    const value = truncated ? textResult.value.slice(0, limits.maxStringLength) : textResult.value;
    const disclosureClass = truncated ? 'truncated' : 'text';
    return {
      class: disclosureClass,
      ...(mediaType ? { mediaType } : {}),
      encoding: encoding ?? 'utf-8',
      value,
      receipt: receipt(disclosureClass, originalBytes, redactions, {
        disclosed: true,
        disclosedBytes: Buffer.byteLength(value, 'utf8'),
        truncated,
      }),
    };
  } catch (error) {
    if (error instanceof StructureLimitError) {
      const disclosureClass = isForm ? 'form' : isJson ? 'json' : 'text';
      return withheld(disclosureClass, mediaType, encoding, originalBytes, 'structure_limit_exceeded', redactions);
    }
    return withheld('unknown', mediaType, encoding, originalBytes, 'sanitization_failed');
  }
}

/** Last-resort logging boundary for metadata whose exact shape is not yet known. */
export function serializeLogSafe(value: unknown, options: SanitizerOptions = {}): string {
  const state: WalkState = {
    limits: limitsFor(options.limits),
    secrets: secretsFor(options.exactSecrets),
    redactions: [],
    members: 0,
    truncated: false,
  };
  try {
    return JSON.stringify(redactValue(value, '$', 0, state));
  } catch {
    return JSON.stringify({ withheld: true, reason: 'sanitization_failed' });
  }
}
