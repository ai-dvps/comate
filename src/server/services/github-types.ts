/**
 * Backend-agnostic GitHub adapter contract + shared types (KTD8).
 *
 * This module deliberately imports NO octokit and NO storage/crypto code: it is
 * the pure contract + the {@link redactGithubError} security helper. Keeping it
 * dependency-free means redaction and route tests never pull octokit or the
 * SQLite singleton into their import closure, and a second server backend can
 * implement {@link GithubBackendAdapter} against this file alone.
 *
 * SECURITY (R13/KTD3): every GitHub-derived error that could reach a logger or
 * an HTTP response must pass through {@link redactGithubError} first. Octokit
 * errors carry `request.headers.authorization`, `request.headers.cookie`, and
 * sometimes an echoed `response.data.access_token` / `refresh_token`. The
 * redactor strips those by key and scrubs `Bearer <token>` / `token=<value>`
 * forms from any string, so the sentinel-token tests in `github.test.ts` hold.
 */

/** One accessible repository (R8 association UI; R17 preserves `private`). */
export interface GithubRepo {
  /** `owner/repo` */
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

/** A GitHub issue, normalized for the sync engine. */
export interface RemoteIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  /** Primary assignee login, or null. */
  assignee: string | null;
  labels: string[];
  /** ISO 8601 `updated_at` from GitHub — drives the `since` cursor. */
  updatedAt: string;
  htmlUrl: string;
}

/** A GitHub issue comment, normalized for append-only merge. */
export interface RemoteComment {
  id: number;
  /** Author login. */
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListChangedResult {
  issues: RemoteIssue[];
  /** ETag to persist as the next `If-None-Match` (null when GitHub sent none). */
  etag: string | null;
  /** `max(updated_at)` seen, or null when no issues returned. */
  latestUpdatedAt: string | null;
}

export interface CreateIssueInput {
  title: string;
  body: string | null;
  labels?: string[];
  assignees?: string[];
}

export interface UpdateIssueInput {
  title?: string;
  body?: string | null;
  state?: 'open' | 'closed';
  labels?: string[];
  assignees?: string[];
}

/**
 * The backend-agnostic adapter contract (KTD8). `github-client.ts` is the first
 * (octokit-backed) implementation; a later backend implements the same methods
 * with no core change.
 */
export interface GithubBackendAdapter {
  /** Repos the connected account can see — for the workspace association UI. */
  listAccessibleRepos(): Promise<GithubRepo[]>;
  /** Issues in `repo` (`owner/repo`) changed since `since`, with ETag short-circuit. */
  listChanged(repo: string, since: string | null, etag: string | null): Promise<ListChangedResult>;
  /** Fetch one issue; `null` means 404 (origin-side deletion detection in U5). */
  getIssue(repo: string, number: number): Promise<RemoteIssue | null>;
  create(repo: string, input: CreateIssueInput): Promise<RemoteIssue>;
  update(repo: string, number: number, input: UpdateIssueInput): Promise<RemoteIssue>;
  fetchComments(repo: string, number: number): Promise<RemoteComment[]>;
  addComment(repo: string, number: number, body: string): Promise<RemoteComment>;
}

/** The connection status shape returned to the client — never carries a token (R18). */
export interface GithubConnectionStatus {
  connected: boolean;
  tokenType: 'pat' | 'device-flow' | null;
  /** ISO expiry of the access token, or null when not connected / no expiry. */
  expiresAt: string | null;
  /** Authenticated login, when known. */
  login: string | null;
}

/** Keys whose values are secrets regardless of the surrounding object. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'client_secret',
  'private_key',
  'api_key',
  'x-github-token',
  'gh_token',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

/**
 * Scrub token-bearing substrings from a string. Covers the structural forms
 * (`Bearer <token>`, `token=<value>`) plus GitHub token prefixes anywhere
 * (`gh[pousr]_…`, `github_pat_…`) so a bare token value that leaked into a
 * message — without a wrapper — is still redacted.
 */
function scrubString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(access_token|refresh_token|token)=([A-Za-z0-9._-]+)/gi, '$1=[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/gi, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gi, '[REDACTED]');
}

/**
 * Recursively sanitize an arbitrary value: replace sensitive-key values with
 * `[REDACTED]` and scrub token-bearing substrings out of strings. Never throws.
 */
function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? '[REDACTED]' : sanitize(v, seen);
  }
  return out;
}

/** A GitHub error after redaction: safe to log or return. */
export interface RedactedGithubError {
  message: string;
  status?: number;
  request?: { method?: string; url?: string };
  response?: { status?: number; data?: unknown };
}

/**
 * Sanitize any error caught at a GitHub boundary so no access/refresh token,
 * authorization header, or cookie reaches a logger or HTTP response (R13/KTD3).
 *
 * Extracts the HTTP status and a redacted summary of the request/response, then
 * returns a fresh {@link RedactedGithubError} whose every field has passed
 * through {@link sanitize}. Callers attach `redacted.message` to the response
 * and pass the whole object to `diagLog` — both are safe.
 */
export function redactGithubError(err: unknown): RedactedGithubError {
  const seen = new WeakSet<object>();
  const source = (err ?? {}) as Record<string, unknown>;
  const rawMessage =
    typeof source.message === 'string' ? source.message : typeof err === 'string' ? err : 'GitHub request failed';
  const status = typeof source.status === 'number' ? source.status : undefined;

  const rawRequest = (source.request ?? undefined) as
    | { method?: string; url?: string; headers?: Record<string, unknown>; body?: unknown }
    | undefined;
  const rawResponse = (source.response ?? undefined) as
    | { status?: number; headers?: Record<string, unknown>; data?: unknown }
    | undefined;

  const request = rawRequest
    ? {
        method: typeof rawRequest.method === 'string' ? rawRequest.method : undefined,
        url: typeof rawRequest.url === 'string' ? scrubString(rawRequest.url) : undefined,
      }
    : undefined;

  const response = rawResponse
    ? {
        status: typeof rawResponse.status === 'number' ? rawResponse.status : undefined,
        data: sanitize(rawResponse.data, seen),
      }
    : undefined;

  return {
    message: scrubString(rawMessage),
    status,
    request,
    response,
  };
}
