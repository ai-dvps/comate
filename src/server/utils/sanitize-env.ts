/**
 * Shared subprocess env sanitization: strip unrelated providers' secrets and
 * bot-channel variables before handing an environment to a child process
 * (SDK subprocess, opencode serve). Same rule set as the historical
 * sanitizeBotEnv in chat-service — unrelated keys must never leak into a
 * child that only needs its own provider's credentials.
 */

export function sanitizeSubprocessEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('WECOM_')) continue;
    if (/^(AWS_|GOOGLE_|AZURE_|OPENAI_)/i.test(key)) continue;
    if (/^CLAUDE_(API_KEY|AUTH)/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
