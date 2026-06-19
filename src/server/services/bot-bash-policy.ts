import type { BashWhitelistEntry } from '../models/workspace.js';
import type { PathPolicyContext, PathValidationResult } from './bot-path-policy.js';
import { checkUserPath, resolveAndCheckPath } from './bot-path-policy.js';

export interface BashPolicyContext {
  whitelist: BashWhitelistEntry[];
  pathContext: PathPolicyContext;
}

export interface BashPolicyResult {
  allowed: boolean;
  reason?: string;
}

const SHELL_METACHARACTERS = /[|&;`$<>(){}[\]~*?!#\\\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/;

function hasShellMetacharacters(token: string): boolean {
  return SHELL_METACHARACTERS.test(token);
}

function hasControlCharacters(command: string): boolean {
  return /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/.test(command);
}

/**
 * A conservative shell-like tokenizer. Supports single/double quotes and
 * backslash escapes. Rejects unbalanced quotes. The output tokens have quotes
 * removed and escapes resolved.
 */
function tokenize(command: string): { ok: true; tokens: string[] } | { ok: false; reason: string } {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === ' ' || ch === '\t') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      i++;
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length && command[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          current += command[i];
          i++;
        }
      }
      if (i >= command.length) {
        return { ok: false, reason: 'unbalanced-quotes' };
      }
      i++;
      continue;
    }

    if (ch === "'") {
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i++;
      }
      if (i >= command.length) {
        return { ok: false, reason: 'unbalanced-quotes' };
      }
      i++;
      continue;
    }

    if (ch === '\\') {
      if (i + 1 >= command.length) {
        return { ok: false, reason: 'trailing-backslash' };
      }
      current += command[i + 1];
      i += 2;
      continue;
    }

    current += ch;
    i++;
  }

  if (current !== '') {
    tokens.push(current);
  }

  return { ok: true, tokens };
}

function matchArgument(
  ctx: BashPolicyContext,
  spec: BashWhitelistEntry['args'][number],
  token: string,
): PathValidationResult | null {
  if (typeof spec === 'string') {
    return spec === token ? { allowed: true } : null;
  }

  if (token === '') {
    return { allowed: false, reason: 'empty-argument' };
  }

  switch (spec.type) {
    case 'user_path':
      return checkUserPath(ctx.pathContext, token);
    case 'shared_path':
      return resolveAndCheckPath(ctx.pathContext, token, { write: false });
    case 'any':
      return hasShellMetacharacters(token)
        ? { allowed: false, reason: 'argument-metacharacter' }
        : { allowed: true };
    default:
      return null;
  }
}

function matchWhitelist(
  ctx: BashPolicyContext,
  command: string,
  tokens: string[],
): { allowed: true } | { allowed: false; reason: string } {
  for (const entry of ctx.whitelist) {
    if (entry.command !== command) continue;
    const expectedArgs = entry.args.length;
    if (tokens.length - 1 !== expectedArgs) continue;

    let matched = true;
    for (let i = 0; i < expectedArgs; i++) {
      const spec = entry.args[i];
      const token = tokens[i + 1];
      const result = matchArgument(ctx, spec, token!);
      if (result === null) {
        matched = false;
        break;
      }
      if (!result.allowed) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: 'whitelist-mismatch' };
}

export function evaluateBash(
  ctx: BashPolicyContext,
  input: Record<string, unknown>,
): BashPolicyResult {
  if (ctx.whitelist.length === 0) {
    return { allowed: false, reason: 'bash-disabled' };
  }

  const command = input.command;
  if (typeof command !== 'string' || command === '') {
    return { allowed: false, reason: 'missing-command' };
  }

  if (hasControlCharacters(command)) {
    return { allowed: false, reason: 'control-characters' };
  }

  const tokenResult = tokenize(command);
  if (!tokenResult.ok) {
    return { allowed: false, reason: tokenResult.reason };
  }

  const tokens = tokenResult.tokens;
  if (tokens.length === 0) {
    return { allowed: false, reason: 'empty-command' };
  }

  // Reject any token containing shell metacharacters after quote/escape processing.
  for (const token of tokens) {
    if (hasShellMetacharacters(token)) {
      return { allowed: false, reason: 'shell-metacharacter' };
    }
  }

  const program = tokens[0];
  const match = matchWhitelist(ctx, program, tokens);
  if (!match.allowed) {
    return { allowed: false, reason: match.reason };
  }

  return { allowed: true };
}

/**
 * Build the sanitized environment for an allowed Bash command.
 *
 * Removes provider/bot credentials and other sensitive env vars. PATH is kept so
 * whitelisted commands can resolve.
 */
export function buildSanitizedEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('ANTHROPIC_')) continue;
    if (key.startsWith('WECOM_')) continue;
    if (/^AWS_/i.test(key)) continue;
    if (/^GOOGLE_/i.test(key)) continue;
    if (/^AZURE_/i.test(key)) continue;
    if (/^OPENAI_/i.test(key)) continue;
    if (/^CLAUDE_(API_KEY|AUTH)/i.test(key)) continue;
    result[key] = value;
  }
  return result;
}
