import { describe, it, expect } from 'vitest'
import {
  openDrawer,
  pushDrawer,
  popDrawer,
  closeDrawer,
  canGoBack,
  topView,
  type DrawerView,
} from './detail-drawer-view'

const process = (messageId: string, regionIndex = 0): DrawerView => ({
  kind: 'process',
  messageId,
  regionIndex,
})
const subagent = (id: string): DrawerView => ({ kind: 'subagent', parentToolUseId: id })
const workflow = (id: string): DrawerView => ({ kind: 'workflow', runId: id })

describe('drawer view-stack', () => {
  it('openDrawer resets the stack to a single view, discarding any prior depth', () => {
    expect(openDrawer(process('m1'))).toEqual([process('m1')])
    const deep = pushDrawer(subagent('a2'), openDrawer(subagent('a1')))
    expect(openDrawer(workflow('w1'))).toEqual([workflow('w1')])
    expect(openDrawer(workflow('w1'))).not.toEqual(deep)
  })

  it('pushDrawer appends a view and keeps the parent', () => {
    const stack = pushDrawer(subagent('a2'), openDrawer(process('m1')))
    expect(stack).toEqual([process('m1'), subagent('a2')])
    expect(topView(stack)).toEqual(subagent('a2'))
  })

  it('popDrawer drops only the top view and only when depth > 1 (R3)', () => {
    const depth1 = openDrawer(process('m1'))
    expect(popDrawer(depth1)).toEqual(depth1) // no-op at the bottom

    const depth2 = pushDrawer(subagent('a1'), depth1)
    expect(popDrawer(depth2)).toEqual([process('m1')])

    const depth3 = pushDrawer(subagent('a2'), depth2)
    expect(popDrawer(depth3)).toEqual(depth2)
  })

  it('closeDrawer clears the stack (R4)', () => {
    const deep = pushDrawer(subagent('a2'), pushDrawer(subagent('a1'), openDrawer(process('m1'))))
    expect(closeDrawer()).toEqual([])
    expect(closeDrawer()).not.toEqual(deep)
  })

  it('canGoBack is true only past depth 1', () => {
    expect(canGoBack(openDrawer(process('m1')))).toBe(false)
    expect(canGoBack(pushDrawer(subagent('a1'), openDrawer(process('m1'))))).toBe(true)
    expect(canGoBack(closeDrawer())).toBe(false)
  })

  it('topView returns the top or null when empty', () => {
    expect(topView(closeDrawer())).toBeNull()
    const stack = pushDrawer(workflow('w1'), openDrawer(process('m1')))
    expect(topView(stack)).toEqual(workflow('w1'))
  })
})
