export const SESSION_TOKEN_ENV = 'COMATE_SESSION_TOKEN';
export const SERVER_URL_ENV = 'COMATE_SERVER_URL';

export interface ComateContext {
  token: string;
  serverUrl: string;
}

export function resolveContext(env: NodeJS.ProcessEnv = process.env): ComateContext {
  const token = env[SESSION_TOKEN_ENV]?.trim();
  if (!token) throw new Error('This command must run inside a live Comate task.');
  const rawUrl = env[SERVER_URL_ENV]?.trim();
  if (!rawUrl) throw new Error('The Comate server address is unavailable for this task.');
  let serverUrl: URL;
  try {
    serverUrl = new URL(rawUrl);
  } catch {
    throw new Error('The Comate server address is invalid.');
  }
  if (serverUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(serverUrl.hostname)) {
    throw new Error('The Comate server address is not a loopback HTTP endpoint.');
  }
  return { token, serverUrl: serverUrl.origin };
}
