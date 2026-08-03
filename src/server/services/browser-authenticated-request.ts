import { createHash, randomBytes } from 'crypto';
import {
  CONTRACT_VERSION,
  brokerRequestSchema,
  type BrowserApiError,
  type BrokerRequest,
  type BrokerResult,
  type SanitizedDisclosure,
} from '@comate/api-contracts';
import { sanitizeBody, sanitizeHeaders } from './browser-api-sanitizer.js';
import {
  BrowserDirectHttpClient,
  BrowserDirectHttpError,
  type BrowserDirectHttpResult,
} from './browser-direct-http-client.js';
import type { ResolvedAuthMaterial } from './browser-auth-binding.js';
import type { BrowserBrokerAuditInput } from './browser-audit.js';
import { siteKeyForUrl } from './browser-site-key.js';

export type { BrowserBrokerAuditInput } from './browser-audit.js';

export type BrokerApprovalDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny' }
  | { behavior: 'timeout' }
  | { behavior: 'cancel' };

export interface BrokerExecutionContext {
  taskId: string;
  workspaceId: string;
  /** Runtime-generation scope: grants must never survive task token rotation. */
  grantScope: string;
  signal?: AbortSignal;
}

interface BrokerDeps {
  httpClient?: Pick<BrowserDirectHttpClient, 'request'>;
  resolveAuth: (taskId: string, bindingId: string, destination: string) => ResolvedAuthMaterial;
  approvalRequester?: (input: {
    taskId: string;
    method: string;
    siteKey: string;
    correlationId: string;
    validationRequested: boolean;
    signal?: AbortSignal;
  }) => Promise<BrokerApprovalDecision>;
  audit: { logBroker(input: BrowserBrokerAuditInput): unknown | null };
  now?: () => number;
  grantTtlMs?: number;
}

interface PreparedOperation {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  fingerprint: string;
  siteKey: string;
}

interface Grant {
  taskId: string;
  grantScope: string;
  bindingId: string;
  fingerprint: string;
  expiresAt: number;
}

const AUTH_HEADER = /^(?:authorization|cookie|proxy-authorization)$/i;
const UNSAFE_HEADER = /^(?:host|content-length|transfer-encoding|connection|trailer|upgrade|proxy-|forwarded|x-forwarded-|via|te|expect)$/i;
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function error(
  code: BrowserApiError['code'],
  message: string,
  recovery: string,
  retryable = false,
  outcomeUnknownAfterDispatch = false,
): BrowserApiError {
  return {
    version: CONTRACT_VERSION,
    ok: false,
    code,
    message,
    recovery,
    retryable,
    ...(outcomeUnknownAfterDispatch ? { outcomeUnknownAfterDispatch: true } : {}),
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scalar(value: string | number | boolean | null): string {
  return value === null ? 'null' : String(value);
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function substitute(
  template: string,
  location: 'path' | 'query' | 'header' | 'body',
  declared: Map<string, 'path' | 'query' | 'header' | 'body'>,
  values: BrokerRequest['variables'],
): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    if (declared.get(name) !== location || !(name in values)) throw new Error('invalid_contract');
    const raw = scalar(values[name]);
    if (raw.length > 4096 || hasControl(raw)) throw new Error('invalid_contract');
    return location === 'path' ? encodeURIComponent(raw) : raw;
  });
}

function replaceBodyValue(
  value: unknown,
  declared: Map<string, 'path' | 'query' | 'header' | 'body'>,
  values: BrokerRequest['variables'],
): unknown {
  if (typeof value === 'string') {
    const exact = /^\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(value);
    if (exact && declared.get(exact[1]) === 'body' && exact[1] in values) return values[exact[1]];
    return substitute(value, 'body', declared, values);
  }
  if (Array.isArray(value)) return value.map((item) => replaceBodyValue(item, declared, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, replaceBodyValue(item, declared, values)]));
  }
  return value;
}

function bodyFor(
  disclosure: SanitizedDisclosure | undefined,
  declared: Map<string, 'path' | 'query' | 'header' | 'body'>,
  values: BrokerRequest['variables'],
): string | undefined {
  if (!disclosure || disclosure.value === undefined) return undefined;
  const replaced = replaceBodyValue(disclosure.value, declared, values);
  if (disclosure.class === 'json' || disclosure.class === 'graphql') return JSON.stringify(replaced);
  if (disclosure.class === 'form' && replaced && typeof replaced === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(replaced as Record<string, unknown>)) {
      if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
      else params.append(key, String(value));
    }
    return params.toString();
  }
  return typeof replaced === 'string' ? replaced : JSON.stringify(replaced);
}

function prepare(request: BrokerRequest): PreparedOperation {
  const declarations = new Map(request.recipe.variables.map((item) => [item.name, item.location]));
  for (const variable of request.recipe.variables) {
    if (variable.required && !(variable.name in request.variables)) throw new Error('invalid_contract');
  }
  for (const name of Object.keys(request.variables)) {
    if (!declarations.has(name)) throw new Error('invalid_contract');
  }
  const original = new URL(request.recipe.url);
  const pathTemplate = original.pathname.replace(
    /%7B%7B([A-Za-z_][A-Za-z0-9_]*)%7D%7D/gi,
    '{{$1}}',
  );
  const path = substitute(pathTemplate, 'path', declarations, request.variables);
  const url = new URL(`${original.protocol}//${original.host}${path}`);
  for (const item of request.recipe.query) {
    url.searchParams.append(item.name, substitute(item.value, 'query', declarations, request.variables));
  }
  const headers: Record<string, string> = {};
  for (const [rawName, template] of Object.entries(request.recipe.headers)) {
    const name = rawName.toLowerCase();
    if (AUTH_HEADER.test(name) || UNSAFE_HEADER.test(name)) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(rawName)) throw new Error('invalid_contract');
    headers[name] = substitute(template, 'header', declarations, request.variables);
  }
  const body = bodyFor(request.recipe.body, declarations, request.variables);
  const method = request.recipe.method.toUpperCase();
  const keyResult = siteKeyForUrl(url.toString());
  if (!keyResult.ok) throw new Error('invalid_contract');
  const siteKey = keyResult.key;
  const canonical = { method, url: url.toString(), headers, body: body ?? null };
  const fingerprint = `sha256:${createHash('sha256').update(stable(canonical)).digest('hex')}`;
  return { method, url: url.toString(), headers, ...(body !== undefined ? { body } : {}), fingerprint, siteKey };
}

function cookieHeader(cookies: Array<Record<string, unknown>>): string | undefined {
  const pairs: string[] = [];
  for (const cookie of cookies) {
    const name = typeof cookie.name === 'string' ? cookie.name : '';
    const value = typeof cookie.value === 'string' ? cookie.value : '';
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || value.includes(';') || hasControl(value)) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function terminalOutcome(result: BrowserDirectHttpResult): 'ok' | 'error' {
  return result.status >= 400 ? 'error' : 'ok';
}

export class BrowserAuthenticatedRequestBroker {
  private readonly http: Pick<BrowserDirectHttpClient, 'request'>;
  private readonly grants = new Map<string, Grant>();
  private readonly now: () => number;
  private readonly grantTtlMs: number;

  constructor(private readonly deps: BrokerDeps) {
    this.http = deps.httpClient ?? new BrowserDirectHttpClient();
    this.now = deps.now ?? (() => Date.now());
    this.grantTtlMs = deps.grantTtlMs ?? 10 * 60_000;
  }

  async execute(context: BrokerExecutionContext, raw: unknown): Promise<BrokerResult> {
    const parsed = brokerRequestSchema.safeParse(raw);
    if (!parsed.success) return error('invalid_contract', 'The request recipe is invalid.', 'Regenerate the recipe from a capture candidate.');
    let operation: PreparedOperation;
    try {
      operation = prepare(parsed.data);
    } catch {
      return error('invalid_contract', 'The request variables do not match the declared recipe.', 'Provide only declared bounded variables.');
    }
    const bindingId = parsed.data.recipe.authBinding;
    const correlationId = `broker_${randomBytes(12).toString('base64url')}`;
    const readOnly = operation.method === 'GET' || operation.method === 'HEAD';
    const grantKey = `${context.taskId}\0${context.grantScope}\0${bindingId}\0${operation.fingerprint}`;
    const grant = this.grants.get(grantKey);
    let approval: BrowserBrokerAuditInput['approval'] = readOnly
      ? 'not_required'
      : grant && grant.expiresAt > this.now() ? 'task_grant' : 'required';

    if (!this.deps.audit.logBroker({
      workspaceId: context.workspaceId, sessionId: context.taskId, phase: 'intent',
      correlationId, method: operation.method, siteKey: operation.siteKey,
      approval, outcome: 'ok',
    })) return error('audit_unavailable', 'The request was not sent because its intent could not be audited.', 'Restore audit storage and retry.', true);

    if (!readOnly && approval !== 'task_grant') {
      if (!this.deps.approvalRequester) {
        return this.finishWithoutDispatch(context, operation, correlationId, 'denied', 'authorization_required');
      }
      let decision: BrokerApprovalDecision;
      try {
        decision = await this.deps.approvalRequester({
          taskId: context.taskId, method: operation.method, siteKey: operation.siteKey,
          correlationId, validationRequested: parsed.data.validateNonMutating === true,
          signal: context.signal,
        });
      } catch {
        decision = context.signal?.aborted ? { behavior: 'cancel' } : { behavior: 'timeout' };
      }
      if (decision.behavior !== 'allow') {
        approval = decision.behavior === 'deny' ? 'denied' : decision.behavior === 'timeout' ? 'timeout' : 'cancelled';
        const code = decision.behavior === 'deny' ? 'authorization_denied'
          : decision.behavior === 'timeout' ? 'authorization_expired' : 'authorization_cancelled';
        return this.finishWithoutDispatch(context, operation, correlationId, approval, code);
      }
      approval = 'approved';
    }

    let dispatched = false;
    const exactSecrets = new Set<string>();
    try {
      const result = await this.http.request({
        url: operation.url,
        authorizedDomain: operation.siteKey,
        method: operation.method,
        headers: operation.headers,
        ...(operation.body !== undefined ? { body: operation.body } : {}),
        signal: context.signal,
        prepareHopHeaders: (authorized) => {
          const auth = this.deps.resolveAuth(context.taskId, bindingId, authorized.url.toString());
          const cookie = cookieHeader(auth.cookies);
          const headers: Record<string, string> = {};
          if (cookie) {
            headers.cookie = cookie;
            for (const item of auth.cookies) if (typeof item.value === 'string') exactSecrets.add(item.value);
          }
          if (auth.bearerToken && !hasControl(auth.bearerToken)) {
            headers.authorization = `Bearer ${auth.bearerToken}`;
            exactSecrets.add(auth.bearerToken);
          }
          if (!headers.cookie && !headers.authorization) throw new BrowserDirectHttpError('invalid_request', 'No applicable authentication');
          dispatched = true;
          return headers;
        },
      });
      if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
        throw new BrowserDirectHttpError('transport_error', 'Transport returned an invalid status');
      }
      const safeHeadersInput = Object.fromEntries(Object.entries(result.headers)
        .filter(([name]) => !/^set-cookie2?$/i.test(name) && name.length <= 256)
        .slice(0, 128));
      const headers = sanitizeHeaders(safeHeadersInput, { exactSecrets: [...exactSecrets] }).value;
      const body = sanitizeBody({
        contentType: result.headers['content-type'], body: result.body,
        exactSecrets: [...exactSecrets],
      });
      if (!this.deps.audit.logBroker({
        workspaceId: context.workspaceId, sessionId: context.taskId, phase: 'terminal',
        correlationId, method: operation.method, siteKey: operation.siteKey,
        approval, outcome: terminalOutcome(result), status: result.status,
      })) return error('audit_unavailable', 'The response was withheld because terminal audit failed.', 'Check audit storage before deciding whether to retry.', false, true);

      if (!readOnly && approval === 'approved' && result.status < 400 &&
          parsed.data.validateNonMutating === true) {
        this.grants.set(grantKey, {
          taskId: context.taskId, grantScope: context.grantScope,
          bindingId, fingerprint: operation.fingerprint,
          expiresAt: this.now() + this.grantTtlMs,
        });
      }
      const successApproval = approval === 'required' ? 'approved' : approval;
      return { version: CONTRACT_VERSION, ok: true, status: result.status, headers, body, approval: successApproval };
    } catch (caught) {
      const mapped = this.mapError(caught);
      const terminalOk = this.deps.audit.logBroker({
        workspaceId: context.workspaceId, sessionId: context.taskId, phase: 'terminal',
        correlationId, method: operation.method, siteKey: operation.siteKey,
        approval, outcome: mapped.code === 'authorization_expired' ? 'timeout' : 'error',
      });
      if (!terminalOk) return error('audit_unavailable', 'The request outcome was withheld because terminal audit failed.', 'Check audit storage before deciding whether to retry.', false, dispatched);
      return mapped;
    }
  }

  revokeTask(taskId: string): void {
    for (const [key, grant] of this.grants) if (grant.taskId === taskId) this.grants.delete(key);
  }

  revokeBinding(taskId: string, bindingId: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.taskId === taskId && grant.bindingId === bindingId) this.grants.delete(key);
    }
  }

  private finishWithoutDispatch(
    context: BrokerExecutionContext,
    operation: PreparedOperation,
    correlationId: string,
    approval: 'denied' | 'timeout' | 'cancelled',
    code: 'authorization_required' | 'authorization_denied' | 'authorization_expired' | 'authorization_cancelled',
  ): BrowserApiError {
    const outcome = approval === 'timeout' ? 'timeout' : 'denied';
    if (!this.deps.audit.logBroker({
      workspaceId: context.workspaceId, sessionId: context.taskId, phase: 'terminal',
      correlationId, method: operation.method, siteKey: operation.siteKey,
      approval, outcome,
    })) return error('audit_unavailable', 'The authorization outcome could not be audited.', 'Restore audit storage and retry.', true);
    return error(code, 'The request was not authorized.', 'Approve a new validation request to continue.', code === 'authorization_expired');
  }

  private mapError(caught: unknown): BrowserApiError {
    if (caught instanceof BrowserDirectHttpError) {
      if (caught.code === 'request_timeout') return error('broker_unavailable', 'The request timed out.', 'Retry the request.', true);
      if (caught.code === 'request_aborted') return error('authorization_cancelled', 'The request was cancelled.', 'Retry when ready.');
      if (caught.code === 'destination_not_allowed') return error('destination_not_allowed', 'The destination is outside the authorized site.', 'Use the captured site domain.');
      if (caught.code === 'destination_unsafe') return error('destination_unsafe', 'The destination failed network safety checks.', 'Use a public HTTPS destination.');
      if (caught.code === 'request_limit_exceeded' || caught.code === 'response_limit_exceeded' || caught.code === 'concurrency_limit_exceeded') {
        return error('request_limit_exceeded', 'The request exceeded a broker safety limit.', 'Reduce the request or response size.', true);
      }
      if (caught.code === 'invalid_request' && caught.message === 'No applicable authentication') {
        return error('auth_not_applicable', 'No captured authentication applies to this destination.', 'Capture or remember authentication for this exact destination.');
      }
    }
    const authCode = (caught as { code?: unknown } | null)?.code;
    if (authCode === 'auth_binding_stale') return error('auth_binding_stale', 'The authentication binding is stale.', 'Capture or remember the site again.');
    if (authCode === 'reauthentication_needed') return error('reauthentication_needed', 'Remembered authentication can no longer be decrypted.', 'Sign in and remember the site again.');
    if (authCode === 'domain_not_authorized') return error('destination_not_allowed', 'The binding does not authorize this destination.', 'Use the captured site domain.');
    return error('broker_unavailable', 'The authenticated request could not be completed.', 'Retry after checking the captured authentication.', true);
  }
}
