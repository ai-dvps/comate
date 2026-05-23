function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
}

let macOSPromise: Promise<boolean> | null = null

async function detectMacOS(): Promise<boolean> {
  if (!isTauri()) return false
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}

export function isMacOS(): Promise<boolean> {
  if (!macOSPromise) {
    macOSPromise = detectMacOS()
  }
  return macOSPromise
}
