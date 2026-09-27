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

let windowsPromise: Promise<boolean> | null = null

async function detectWindows(): Promise<boolean> {
  if (!isDesktop()) return false
  // Electron reports 'Win32' even on 64-bit Windows; /Win/i is specific
  // enough ('MacIntel' and 'Linux x86_64' don't match).
  return typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)
}

export function isWindows(): Promise<boolean> {
  if (!windowsPromise) {
    windowsPromise = detectWindows()
  }
  return windowsPromise
}
