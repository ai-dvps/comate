let clientId = ''
try {
  clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
} catch {
  clientId = 'unknown'
}

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
  // Fire-and-forget POST to server log sink
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message: `[${clientId}] ${message}` }),
  }).catch(() => {
    // Ignore network errors — we're logging about network errors
  })
}

export function diagLog(...args: unknown[]): void {
  send('log', ...args)
}

export function diagWarn(...args: unknown[]): void {
  send('warn', ...args)
}
