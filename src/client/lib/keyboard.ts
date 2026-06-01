import type React from 'react'

/**
 * Decide whether an Enter keydown should trigger submit,
 * accounting for IME composition and the user's modifier preference.
 */
export function shouldSubmitOnEnter(
  event: React.KeyboardEvent<HTMLElement>,
  useModifierToSubmit: boolean,
): boolean {
  if (event.key !== 'Enter') return false
  if (event.nativeEvent.isComposing) return false

  if (useModifierToSubmit) {
    return event.ctrlKey || event.metaKey
  }

  return !event.shiftKey
}
