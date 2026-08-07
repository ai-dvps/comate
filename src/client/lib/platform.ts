import { isDesktop } from './desktop-api'

let macOSPromise: Promise<boolean> | null = null

async function detectMacOS(): Promise<boolean> {
  if (!isDesktop()) return false
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
}

export function isMacOS(): Promise<boolean> {
  if (!macOSPromise) {
    macOSPromise = detectMacOS()
  }
  return macOSPromise
}
