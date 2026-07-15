/**
 * Unified detail drawer: a navigation stack of views. The drawer renders the
 * top view; drilling from within the drawer pushes, opening from the main chat
 * resets, back pops, and X clears. Keeping these as pure functions over a
 * `DrawerView[]` makes the navigation semantics unit-testable without React.
 */

export type DrawerView =
  | { kind: 'process'; messageId: string; regionIndex: number }
  | { kind: 'subagent'; parentToolUseId: string }
  | { kind: 'workflow'; runId: string }

/** Open from the main chat: reset the stack to a single view. */
export function openDrawer(_view: DrawerView): DrawerView[] {
  return [_view]
}

/** Drill from within the drawer: push a new view, parent retained. */
export function pushDrawer(view: DrawerView, stack: DrawerView[]): DrawerView[] {
  return [...stack, view]
}

/** Back: pop the top view, but only when there is a parent to return to. */
export function popDrawer(stack: DrawerView[]): DrawerView[] {
  return stack.length > 1 ? stack.slice(0, -1) : stack
}

/** Close (X): clear the stack. */
export function closeDrawer(): DrawerView[] {
  return []
}

/** Whether a back button should be shown (stack depth > 1). */
export function canGoBack(stack: DrawerView[]): boolean {
  return stack.length > 1
}

/** The view currently rendered (top of the stack), or null when closed. */
export function topView(stack: DrawerView[]): DrawerView | null {
  return stack.length > 0 ? stack[stack.length - 1] : null
}
