let clientId = ''
try {
  clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
} catch {
  clientId = 'unknown'
}

let logPostInFlight = false
const LOG_POST_TIMEOUT_MS = 2000

function send(level: string, ...args: unknown[]): void {
  const message = args.map(String).join(' ')
  // Also echo to browser console
  if (level === 'warn') {
    console.warn(message)
  } else if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }

  if (level === 'log' || logPostInFlight) return

  logPostInFlight = true
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOG_POST_TIMEOUT_MS)
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message: `[${clientId}] ${message}` }),
    signal: controller.signal,
  })
    .catch(() => {
      // Ignore network errors — we're logging about network errors
    })
    .finally(() => {
      clearTimeout(timeout)
      logPostInFlight = false
    })
}

export function diagLog(...args: unknown[]): void {
  send('log', ...args)
}

export function diagWarn(...args: unknown[]): void {
  send('warn', ...args)
}
