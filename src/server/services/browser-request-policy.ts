import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getDomain } from 'tldts';

export type BrowserRequestPolicyErrorCode =
  | 'invalid_request'
  | 'destination_not_allowed'
  | 'destination_unsafe'
  | 'request_limit_exceeded';

export class BrowserRequestPolicyError extends Error {
  constructor(readonly code: BrowserRequestPolicyErrorCode, message: string) {
    super(message);
    this.name = 'BrowserRequestPolicyError';
  }
}

export interface BrowserRequestPolicyLimits {
  maxUrlLength: number;
  maxRequestBytes: number;
  maxHeaders: number;
  maxHeaderBytes: number;
}

export interface BrowserRequestInput {
  url: string;
  authorizedDomain: string;
  method: string;
  headers?: Record<string, string> | ReadonlyArray<readonly [string, string]>;
  body?: string | Buffer;
  limits?: Partial<BrowserRequestPolicyLimits>;
}

export interface AuthorizedBrowserRequest {
  url: URL;
  authorizedDomain: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

export interface DnsAddress {
  address: string;
  family: 4 | 6;
}

export type BrowserDnsResolver = (hostname: string) => Promise<readonly DnsAddress[]>;

export interface SafeDestination {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
}

const DEFAULT_LIMITS: BrowserRequestPolicyLimits = {
  maxUrlLength: 8_192,
  maxRequestBytes: 1024 * 1024,
  maxHeaders: 64,
  maxHeaderBytes: 32 * 1024,
};

const FORBIDDEN_HEADERS = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const METHOD = /^[A-Z][A-Z0-9!#$%&'*+\-.^_`|~]{0,15}$/;
const PRIVATE_PSL = { allowPrivateDomains: true };

function limitsFor(input?: Partial<BrowserRequestPolicyLimits>): BrowserRequestPolicyLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BrowserRequestPolicyError('invalid_request', `${name} must be a positive integer`);
    }
  }
  return limits;
}

function normalizedHostname(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
}

function normalizeAuthorizedDomain(domain: string): string {
  const trimmed = domain.trim().replace(/\.$/, '');
  if (!trimmed || /[/\\?#@]/.test(trimmed)) {
    throw new BrowserRequestPolicyError('invalid_request', 'Authorized domain is malformed');
  }
  let hostname: string;
  try {
    hostname = normalizedHostname(new URL(`https://${trimmed}/`).hostname);
  } catch {
    throw new BrowserRequestPolicyError('invalid_request', 'Authorized domain is malformed');
  }
  if (!hostname || isIP(hostname) !== 0) {
    throw new BrowserRequestPolicyError('destination_unsafe', 'IP literals cannot be authorized sites');
  }
  return hostname;
}

function boundaryForHostname(hostname: string): string {
  return getDomain(hostname, PRIVATE_PSL) ?? hostname;
}

export function siteBoundaryForUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BrowserRequestPolicyError('invalid_request', 'URL is malformed');
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || isIP(hostname) !== 0) {
    throw new BrowserRequestPolicyError('destination_unsafe', 'URL host must be a DNS name');
  }
  return boundaryForHostname(hostname);
}

function normalizeHeaders(
  input: BrowserRequestInput['headers'],
  limits: BrowserRequestPolicyLimits,
): Record<string, string> {
  const entries = Array.isArray(input) ? input : Object.entries(input ?? {});
  if (entries.length > limits.maxHeaders) {
    throw new BrowserRequestPolicyError('request_limit_exceeded', 'Too many request headers');
  }
  const output: Record<string, string> = {};
  let bytes = 0;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME.test(rawName) || containsControlCharacter(rawValue)) {
      throw new BrowserRequestPolicyError('invalid_request', 'Request header contains control characters');
    }
    if (output[name] !== undefined) {
      throw new BrowserRequestPolicyError('invalid_request', `Duplicate request header: ${name}`);
    }
    if (
      FORBIDDEN_HEADERS.has(name)
      || name.startsWith('proxy-')
      || name.startsWith('x-forwarded-')
      || name.startsWith('sec-websocket-')
    ) {
      throw new BrowserRequestPolicyError('invalid_request', `Caller header is not permitted: ${name}`);
    }
    bytes += Buffer.byteLength(rawName) + Buffer.byteLength(rawValue) + 4;
    if (bytes > limits.maxHeaderBytes) {
      throw new BrowserRequestPolicyError('request_limit_exceeded', 'Request headers exceed byte limit');
    }
    output[name] = rawValue;
  }
  return output;
}

export function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function authorizeBrowserRequest(input: BrowserRequestInput): AuthorizedBrowserRequest {
  const limits = limitsFor(input.limits);
  if (typeof input.url !== 'string' || input.url.length === 0 || input.url.length > limits.maxUrlLength) {
    throw new BrowserRequestPolicyError('request_limit_exceeded', 'URL exceeds byte limit');
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new BrowserRequestPolicyError('invalid_request', 'URL is malformed');
  }
  if (url.protocol !== 'https:') {
    throw new BrowserRequestPolicyError('destination_unsafe', 'Only HTTPS destinations are allowed');
  }
  if (url.username || url.password) {
    throw new BrowserRequestPolicyError('destination_unsafe', 'URL userinfo is not allowed');
  }
  if (url.hash) {
    throw new BrowserRequestPolicyError('destination_unsafe', 'URL fragments are not allowed');
  }
  if (url.port && url.port !== '443') {
    throw new BrowserRequestPolicyError('destination_unsafe', 'Only the standard HTTPS port is allowed');
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || isIP(hostname) !== 0) {
    throw new BrowserRequestPolicyError('destination_unsafe', 'IP-literal destinations are not allowed');
  }
  url.hostname = hostname;
  const authorizedDomain = normalizeAuthorizedDomain(input.authorizedDomain);
  if (
    boundaryForHostname(hostname) !== authorizedDomain
    || (hostname !== authorizedDomain && !hostname.endsWith(`.${authorizedDomain}`))
  ) {
    throw new BrowserRequestPolicyError('destination_not_allowed', 'Destination is outside the authorized site');
  }
  const method = input.method.toUpperCase();
  if (!METHOD.test(method) || method === 'CONNECT' || method === 'TRACE') {
    throw new BrowserRequestPolicyError('invalid_request', 'HTTP method is not permitted');
  }
  const headers = normalizeHeaders(input.headers, limits);
  let body: Buffer | undefined;
  if (input.body !== undefined) {
    if (method === 'GET' || method === 'HEAD') {
      throw new BrowserRequestPolicyError('invalid_request', `${method} requests cannot carry a body`);
    }
    body = Buffer.isBuffer(input.body) ? Buffer.from(input.body) : Buffer.from(input.body, 'utf8');
    if (body.byteLength > limits.maxRequestBytes) {
      throw new BrowserRequestPolicyError('request_limit_exceeded', 'Request body exceeds byte limit');
    }
  }
  return { url, authorizedDomain, method, headers, ...(body ? { body } : {}) };
}

function ipv4Number(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split('.').map(Number);
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function ipv4In(value: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === undefined) return false;
  const blocked: Array<[number, number]> = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
    [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ];
  return !blocked.some(([base, bits]) => ipv4In(value, base, bits));
}

function parseIpv6(address: string): bigint | undefined {
  let raw = address.toLowerCase().split('%')[0];
  const ipv4Match = /((?:\d{1,3}\.){3}\d{1,3})$/.exec(raw);
  if (ipv4Match) {
    const ipv4 = ipv4Number(ipv4Match[1]);
    if (ipv4 === undefined) return undefined;
    raw = `${raw.slice(0, ipv4Match.index)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = raw.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function ipv6Prefix(value: bigint, base: bigint, bits: number): boolean {
  return bits === 0 || (value >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
}

function isPublicIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === undefined) return false;
  const mappedPrefix = 0xffffn;
  if ((value >> 32n) === mappedPrefix) {
    const ipv4 = Number(value & 0xffffffffn);
    return isPublicIpv4(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  if (value === 0n || value === 1n) return false;
  const prefixes: Array<[bigint, number]> = [
    [0xfc00n << 112n, 7], [0xfe80n << 112n, 10], [0xfec0n << 112n, 10],
    [0xff00n << 112n, 8], [0x0100n << 112n, 64], [0x20010db8n << 96n, 32],
    [0x20010000n << 96n, 32], [0x3ffen << 112n, 16],
  ];
  if (prefixes.some(([base, bits]) => ipv6Prefix(value, base, bits))) return false;
  if (ipv6Prefix(value, 0x2002n << 112n, 16)) {
    const embedded = Number((value >> 80n) & 0xffffffffn);
    return isPublicIpv4(`${embedded >>> 24}.${(embedded >>> 16) & 255}.${(embedded >>> 8) & 255}.${embedded & 255}`);
  }
  // Native globally routable unicast is 2000::/3. Reject exotic transition
  // ranges conservatively rather than letting them bypass all-answer checks.
  return ipv6Prefix(value, 0x2000n << 112n, 3);
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(normalized);
  return family === 4 ? isPublicIpv4(normalized) : family === 6 ? isPublicIpv6(normalized) : false;
}

export const defaultBrowserDnsResolver: BrowserDnsResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.filter((answer): answer is DnsAddress => answer.family === 4 || answer.family === 6);
};

export async function resolveSafeDestination(
  request: AuthorizedBrowserRequest,
  resolver: BrowserDnsResolver = defaultBrowserDnsResolver,
): Promise<SafeDestination> {
  const answers = await resolver(request.url.hostname);
  if (answers.length === 0) {
    throw new BrowserRequestPolicyError('destination_unsafe', 'Destination has no usable DNS answers');
  }
  for (const answer of answers) {
    if (isIP(answer.address) !== answer.family || !isPublicIpAddress(answer.address)) {
      throw new BrowserRequestPolicyError('destination_unsafe', 'Destination DNS includes a non-public address');
    }
  }
  const pinned = answers[0];
  return {
    hostname: request.url.hostname,
    address: pinned.address,
    family: pinned.family,
    port: 443,
  };
}
